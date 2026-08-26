/**
 * Pure adaptation helpers between the model-facing `run_command` contract and
 * the `ctx.shell` / `ctx.jobs` seams. No host services are touched here, so
 * every helper is unit-testable without a live composition.
 * @module dsh-plugin-background-tasks/shell-exec
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { canonicalPath, escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { ShellProcess, ShellProcessRead, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'

/**
 * Resolve the effective workdir exactly like the harness shell tools
 * (`dsh-tool-bash` / `dsh-tool-pwsh`): a resolved sandbox-policy root wins so
 * workdir and confinement share one per-call identity; otherwise the session
 * header cwd applies. A relative model path resolves against that identity;
 * an absolute model path wins unchanged.
 * @param modelCwd - the tool call's `cwd` argument, when given.
 * @param headerCwd - the calling session's header cwd, when composed.
 * @param policyWorkspaceRoot - the standing policy's workspace root, when a
 *   confining executor resolved one.
 * @returns the workdir for the shell request, or `undefined` to leave the
 *   executor's own defaulting in charge (no session identity available).
 */
export function resolveWorkdir(
  modelCwd: string | undefined,
  headerCwd: string | undefined,
  policyWorkspaceRoot: string | undefined,
): string | undefined {
  const sessionCwd = policyWorkspaceRoot ?? (headerCwd === undefined ? undefined : canonicalPath(headerCwd))
  if (modelCwd === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelCwd)) {
    return resolvePath(sessionCwd, modelCwd)
  }
  return modelCwd
}

/**
 * Map a settled background process onto the generic job-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported as completed, not failed, matching the harness tools' rendering.
 * @param proc - the settled process handle.
 * @returns the outcome supplied through {@link JobOutcome} to `ctx.jobs`.
 */
export function processOutcome(proc: Pick<ShellProcess, 'status' | 'exitCode' | 'signal'>): JobOutcome {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

/**
 * One-line nudge appended to a promoted job's still-running reads, below the
 * output delta and above the host's closing `[status: ...]` line. A bare
 * running status gives a model nothing to act on, so owners kept re-reading a
 * settling command — often with back-to-back blocking waits — until each wait
 * cap returned; the completion notification already reaches them without any
 * polling, so ending the turn loses nothing.
 */
export const PENDING_READ_HINT =
  '\nJob still in progress — re-reading it will not make it finish sooner. Continue independent work or end your turn; the completion notification will wake you.'

/**
 * Render one incremental process read into job-output text. The delta already
 * carries stderr in its marked section; lossy reads gain an explicit
 * truncation notice pointing at the executor's spill files, a policy denial
 * gains the shared harness denial marker — plus, when this composition
 * advertises the escalation surface, the shared same-turn escalation hint at
 * the decision point, verbatim with the native shell tools — and a
 * still-running read ends with the pending-read nudge so the model stops
 * polling and relies on the completion notification instead.
 * @param read - the consuming read returned by {@link ShellProcess.readOutput}.
 * @param sandbox - the process's sandbox facts, stamped by confining executors.
 * @param escalationAvailable - whether this composition advertises
 *   `sandbox_permissions` (a confining executor is mounted).
 * @param stillRunning - whether the underlying process has not settled yet;
 *   settled reads (and the synchronous completion path) stay hint-free.
 * @returns the text handed to `ctx.jobs` as this read's output delta.
 */
export function renderProcessRead(
  read: ShellProcessRead,
  sandbox: ShellSandboxInfo | undefined,
  escalationAvailable = false,
  stillRunning = false,
): string {
  let text = read.delta
  if (read.lossy) {
    const spills = [read.stdoutSpillPath, read.stderrSpillPath].filter((p) => p !== undefined)
    text += `\n[output truncated; full streams${spills.length > 0 ? `: ${spills.join(' | ')}` : ' not retained'}]`
  }
  if (sandbox?.denied === true) {
    text += `\n${sandboxDenialMarker(sandbox.mode)}`
    if (escalationAvailable) {
      text += `\n${escalationHintMarker('command')}`
    }
  }
  if (stillRunning) {
    text += PENDING_READ_HINT
  }
  return text
}

/**
 * Race a live process against the promotion window. The process keeps running
 * on every arm — neither the timeout nor a caller abort kills anything; both
 * merely end the synchronous wait so promotion can grant ownership early.
 * @param proc - the already-started background-capable process handle.
 * @param waitMs - milliseconds to wait before giving up on synchronous completion.
 * @param abort - the tool call's abort signal; firing it ends the wait as a
 *   promotion so an aborted call never leaves the process unowned.
 * @returns `'completed'` when the process closed inside the window, `'promote'`
 *   when the window expired or the signal fired first.
 */
export async function raceCompletion(
  proc: Pick<ShellProcess, 'done'>,
  waitMs: number,
  abort?: AbortSignal,
): Promise<'completed' | 'promote'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const abortArm = new Promise<'promote'>((resolve) => {
    if (abort === undefined) return
    if (abort.aborted) {
      resolve('promote')
      return
    }
    onAbort = () => resolve('promote')
    abort.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      proc.done.then(() => 'completed' as const),
      new Promise<'promote'>((resolve) => {
        timer = setTimeout(() => resolve('promote'), waitMs)
      }),
      abortArm,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined && abort !== undefined) {
      abort.removeEventListener('abort', onAbort)
    }
  }
}
