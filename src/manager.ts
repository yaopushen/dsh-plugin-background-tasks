import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs'
import type { WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { DshSessionId, ResolvedBackgroundTasksConfig, RunCommandResult, TaskRecord } from './types.js'

export type TaskCompleteCallback = (task: TaskRecord, tailLogs: string) => void

/** Upper bound on bytes read from one log file in a single tail read. */
const LOG_TAIL_READ_BYTES = 512 * 1024
/** Tail line count embedded into completion wakeup notifications. */
const WAKEUP_TAIL_LINES = 40
/** Task id length: 12 hex chars (48 bits) keeps ids short while making collisions negligible. */
const TASK_ID_HEX_LENGTH = 12

interface RunRequest {
  command: string
  cwd?: string
  waitMsBeforeAsync?: number
  sessionId: DshSessionId
  agentId: DshSessionId
  description?: string
}

type SettleOptions = {
  /** Set when the process never ran to exit (spawn/launch failure). */
  viaError?: boolean
  /** Suppress completion hooks; used for kills and teardown. */
  suppressHooks?: boolean
}

type SettleFn = (code: number | null, signal: string | null, options?: SettleOptions) => void

/**
 * Owns background command lifecycle: synchronous-wait promotion, per-task log
 * files, process-tree termination, retention pruning, and completion hooks.
 *
 * Settlement is single-homed: close, process error, explicit kill, and manager
 * disposal all converge on one once-per-task settler that finalizes the record,
 * writes the log trailer exactly once, closes the stream, and fires hooks.
 * This ordering guarantees no write ever lands after the stream ended.
 */
export class TaskManager {
  private tasks = new Map<string, TaskRecord>()
  private logStreams = new Map<string, WriteStream>()
  private settlers = new Map<string, SettleFn>()
  private hooks = new Set<TaskCompleteCallback>()
  private readonly taskDir: string
  private readonly maxCompletedTasks: number
  private readonly syncOutputLimitBytes: number

  constructor(options: Partial<ResolvedBackgroundTasksConfig> = {}) {
    this.taskDir = options.taskDir ?? join(homedir(), '.dsh', 'tasks')
    this.maxCompletedTasks = options.maxCompletedTasks ?? 100
    this.syncOutputLimitBytes = options.syncOutputLimitBytes ?? 256 * 1024
    if (!existsSync(this.taskDir)) {
      mkdirSync(this.taskDir, { recursive: true })
    }
  }

  onTaskComplete(callback: TaskCompleteCallback): () => void {
    this.hooks.add(callback)
    return () => this.hooks.delete(callback)
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  listTasks(sessionId?: DshSessionId): Array<Omit<TaskRecord, 'child'>> {
    const list: Array<Omit<TaskRecord, 'child'>> = []
    for (const record of this.tasks.values()) {
      if (sessionId === undefined || record.sessionId === sessionId) {
        const { child: _child, ...rest } = record
        list.push(rest)
      }
    }
    return list.sort((a, b) => b.startTime - a.startTime)
  }

  /**
   * Read a task's log tail without loading an unbounded file: files larger than
   * LOG_TAIL_READ_BYTES are read from a byte offset and their first partial
   * line dropped, then the result is capped to `maxLines` lines.
   */
  readTaskLogs(taskId: string, maxLines = 100): { exists: boolean; logs: string } {
    const task = this.tasks.get(taskId)
    if (!task) return { exists: false, logs: `Task "${taskId}" not found.` }
    if (!existsSync(task.logPath)) return { exists: true, logs: '(No log output yet)' }

    const cappedLines = Math.min(Math.max(1, Math.trunc(maxLines)), 2000)
    try {
      let content = readFileSync(task.logPath, 'utf8')
      const size = statSync(task.logPath).size
      if (size > LOG_TAIL_READ_BYTES) {
        const handle = openSync(task.logPath, 'r')
        try {
          const buffer = Buffer.alloc(LOG_TAIL_READ_BYTES)
          const read = readSync(handle, buffer, 0, LOG_TAIL_READ_BYTES, size - LOG_TAIL_READ_BYTES)
          const text = buffer.subarray(0, read).toString('utf8')
          // Drop the first (almost certainly partial) line of the byte window.
          content = '[...older output omitted...]\n' + text.replace(/^[^\r\n]*\r?\n/, '')
        } finally {
          closeSync(handle)
        }
      }

      const lines = content.split(/\r?\n/)
      if (lines.length <= cappedLines) return { exists: true, logs: content }
      return {
        exists: true,
        logs:
          `... [showing last ${cappedLines} of ${lines.length} lines] ...\n` +
          lines.slice(-cappedLines).join('\n'),
      }
    } catch (err: unknown) {
      return { exists: true, logs: `Error reading log file: ${String(err)}` }
    }
  }

  /**
   * Kill a running task's whole process tree. The kill request settles the task
   * as 'killed' immediately; the later child close event is absorbed by the
   * settlement guard, so the status cannot flip to 'failed' and no completion
   * hook fires for an intentional kill.
   */
  killTask(taskId: string): { success: boolean; message: string } {
    const task = this.tasks.get(taskId)
    if (!task) return { success: false, message: `Task "${taskId}" not found.` }
    if (task.status !== 'running') {
      return { success: true, message: `Task "${taskId}" is already in "${task.status}" state.` }
    }
    const pid = task.child?.pid
    if (pid === undefined) {
      return { success: false, message: `Task "${taskId}" has no live process handle.` }
    }

    this.killTree(pid)
    task.status = 'killed'
    this.settlers.get(taskId)?.(null, 'SIGKILL', { suppressHooks: true })
    return {
      success: true,
      message: `Task "${taskId}" (PID ${pid}) terminated; its process tree kill was requested.`,
    }
  }

  /**
   * Run `command` through the platform shell. Returns synchronously when the
   * command exits within `waitMsBeforeAsync`; otherwise promotes it to a
   * background task whose completion later fires the registered hooks.
   */
  async runCommand(request: RunRequest): Promise<RunCommandResult> {
    // Explicit request normalization: every default applied here is visible in
    // one place instead of being scattered through the body.
    const command = request.command
    const cwd = resolve(request.cwd ?? process.cwd())
    const waitMs = request.waitMsBeforeAsync ?? 5000
    const { sessionId, agentId, description } = request

    const taskId = `task-${randomUUID().slice(0, TASK_ID_HEX_LENGTH)}`
    const logPath = join(this.taskDir, `${taskId}.log`)
    const startTime = Date.now()

    const logStream = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' })
    // Post-end writes are prevented by the settlement guard; this listener only
    // guarantees a disk-level stream error can never crash the host.
    logStream.on('error', () => {})
    this.logStreams.set(taskId, logStream)
    const logWrite = (text: string): void => {
      if (!logStream.destroyed && !logStream.writableEnded) logStream.write(text)
    }

    logWrite(`=== Task ${taskId} started at ${new Date(startTime).toISOString()} ===\n`)
    logWrite(`Command: ${command}\n`)
    logWrite(`CWD: ${cwd}\n\n`)

    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : '/bin/bash'
    // Windows progress records reach the redirected stderr as CLIXML noise
    // (e.g. "Preparing modules for first use."); silencing the preference at
    // the top of the encoded script keeps merged output clean. The user
    // command follows on its own line and may override it deliberately.
    const windowsScript = `$ProgressPreference = 'SilentlyContinue'\n${command}`
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')]
      : ['-c', command]

    let child: ChildProcess
    try {
      child = spawn(shell, args, {
        cwd,
        // POSIX only: the child becomes its own process-group leader so
        // killTree can signal -pid and take down grandchildren too. Windows
        // tree walks parent-child pids itself via taskkill /T.
        detached: !isWin,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PAGER: 'cat' },
      })
    } catch (err: unknown) {
      // Synchronous throw covers invalid arguments only; spawn failures such as
      // a missing shell arrive asynchronously on the 'error' event instead.
      logWrite(`Failed to spawn: ${String(err)}\n`)
      logStream.end()
      this.logStreams.delete(taskId)
      return {
        mode: 'sync',
        status: 'failed',
        command,
        output: `Failed to spawn command: ${String(err)}`,
        message: String(err),
      }
    }

    const taskRecord: TaskRecord = {
      taskId,
      command,
      cwd,
      startTime,
      status: 'running',
      logPath,
      sessionId,
      agentId,
      child,
      description,
    }
    this.tasks.set(taskId, taskRecord)

    let promotedToBackground = false
    let settledResolve!: (value: { code: number | null; signal: string | null }) => void
    const settledPromise = new Promise<{ code: number | null; signal: string | null }>((res) => {
      settledResolve = res
    })
    let timer: NodeJS.Timeout | undefined

    // UTF-8-safe decoding: multibyte sequences split across chunks are held by
    // the decoder instead of turning into mojibake in the log or sync output.
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')

    let syncOutput = ''
    let syncOutputTruncated = false
    const appendSyncOutput = (text: string): void => {
      if (promotedToBackground) return
      const room = this.syncOutputLimitBytes - syncOutput.length
      if (room <= 0) {
        if (!syncOutputTruncated) {
          syncOutputTruncated = true
          syncOutput += `\n[output truncated at ${this.syncOutputLimitBytes} bytes during the synchronous wait; full log: ${logPath}]\n`
        }
        return
      }
      syncOutput += text.length <= room ? text : text.slice(0, room)
    }

    const settle: SettleFn = (code, signal, options = {}) => {
      if ((settle as { done?: boolean }).done) return
      ;(settle as { done?: boolean }).done = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      this.settlers.delete(taskId)

      taskRecord.endTime = Date.now()
      taskRecord.exitCode = code
      taskRecord.signal = signal
      if (taskRecord.status !== 'killed') {
        taskRecord.status = !options.viaError && code === 0 ? 'completed' : 'failed'
      }

      logWrite(
        `\n=== Task ${taskId} settled at ${new Date().toISOString()} ${describeSettlement(options, code, signal, taskRecord.status)} ===\n`,
      )
      logStream.end()
      this.logStreams.delete(taskId)

      // Intentional kills and plugin teardown never page the agent.
      if (promotedToBackground && !options.suppressHooks && taskRecord.status !== 'killed') {
        const tail = this.readTaskLogs(taskId, WAKEUP_TAIL_LINES).logs
        for (const hook of this.hooks) {
          try {
            hook(taskRecord, tail)
          } catch {
            // One failing subscriber must not block the remaining subscribers.
          }
        }
      }
      settledResolve({ code, signal })
      this.prune()
    }
    this.settlers.set(taskId, settle)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk)
      logWrite(text)
      appendSyncOutput(text)
    })
    child.stdout?.on('end', () => {
      const rest = stdoutDecoder.end()
      if (rest) {
        logWrite(rest)
        appendSyncOutput(rest)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk)
      logWrite(text)
      appendSyncOutput(text)
    })
    child.stderr?.on('end', () => {
      const rest = stderrDecoder.end()
      if (rest) {
        logWrite(rest)
        appendSyncOutput(rest)
      }
    })

    child.on('close', (code, signal) => settle(code, signal))
    child.on('error', (err: Error) => {
      logWrite(`\nProcess error: ${String(err)}\n`)
      appendSyncOutput(`\n[process error] ${String(err)}\n`)
      // The process never reached an exit code; null + failed status records a
      // launch failure distinctly from a non-zero exit.
      settle(null, null, { viaError: true })
    })

    if (waitMs <= 0) {
      promotedToBackground = true
      this.prune()
      return {
        mode: 'background',
        taskId,
        status: 'running',
        command,
        logPath,
        message: `Command launched in background as "${taskId}". You will receive a system notification when it finishes.`,
      }
    }

    const timeoutPromise = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), waitMs)
      timer.unref?.()
    })

    const outcome = await Promise.race([settledPromise, timeoutPromise])
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    if (outcome !== 'timeout') {
      this.prune()
      const body = syncOutput.trim() || '(No output)'
      return {
        mode: 'sync',
        taskId,
        status: taskRecord.status,
        command,
        exitCode: taskRecord.exitCode,
        output: syncOutput,
        logPath,
        message:
          taskRecord.status === 'completed'
            ? `Command executed successfully.\nExit code: 0\nOutput:\n${body}`
            : `Command failed.\nExit code: ${taskRecord.exitCode ?? 'N/A'}\nOutput:\n${body}`,
      }
    }

    promotedToBackground = true
    this.prune()
    return {
      mode: 'background',
      taskId,
      status: 'running',
      command,
      logPath,
      message: `Command exceeded ${waitMs}ms; promoted to background task "${taskId}". Its log streams into ${logPath}, and you will be automatically notified when it finishes.`,
    }
  }

  /**
   * Kill every running task and settle all state without firing completion
   * hooks. Safe against later close events: those are absorbed by each task's
   * settlement guard, so no write can reach an ended log stream afterwards.
   */
  dispose(): void {
    for (const task of [...this.tasks.values()]) {
      if (task.status === 'running' && task.child?.pid !== undefined) {
        this.killTree(task.child.pid)
      }
    }
    for (const [taskId, settleNow] of [...this.settlers]) {
      const task = this.tasks.get(taskId)
      if (task?.status === 'running') task.status = 'killed'
      settleNow(null, 'SIGKILL', { suppressHooks: true })
    }
    for (const stream of this.logStreams.values()) stream.end()
    this.logStreams.clear()
    this.settlers.clear()
    this.hooks.clear()
    this.tasks.clear()
  }

  /** Enforce the finished-task retention cap, deleting evicted log files. */
  private prune(): void {
    const finished = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime))
    const excess = finished.length - this.maxCompletedTasks
    for (const victim of finished.slice(0, Math.max(0, excess))) {
      this.tasks.delete(victim.taskId)
      try {
        rmSync(victim.logPath, { force: true })
      } catch {
        // Retention is best-effort; the log file may already be gone.
      }
    }
  }

  private killTree(pid: number): void {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
      } catch {
        // The tree may already be dead between the status check and the kill.
      }
    } else {
      try {
        // Valid because POSIX children are spawned detached (own group).
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already dead; nothing left to reap.
        }
      }
    }
  }
}

function describeSettlement(
  options: SettleOptions,
  code: number | null,
  signal: string | null,
  status: string,
): string {
  if (options.viaError) return `(spawn/process error, status: ${status})`
  return `(exit code: ${code === null ? 'null' : code}, signal: ${signal ?? 'none'}, status: ${status})`
}
