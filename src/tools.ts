/**
 * Model-facing Consumer wiring of the background-tasks plugin: one tool,
 * `run_command`, executed through the harness `ctx.shell` executor seam.
 * Commands that finish inside the wait window return synchronously; the rest
 * are promoted into the generic `ctx.jobs` runtime (owner-fenced, collected
 * with `job_output`, stopped with `job_kill`, completion-notified by the jobs
 * consumer). Sandbox confinement follows the calling session's resolved
 * policy, and same-turn widening goes through the shared approval escalation.
 * @module dsh-plugin-background-tasks/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellProcess } from '@deepseek-ai/dsh-shell'
import { codeFence } from './format.js'
import { processOutcome, raceCompletion, renderProcessRead, resolveWorkdir } from './shell-exec.js'
import type { ResolvedBackgroundTasksConfig, RunCommandOutcome } from './types.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** Background commands promoted by this plugin (`command-N` ids). */
    command: 'command'
  }
}

/** Parsed tool args; execute validates value constraints absent from the parameter schema. */
interface RunCommandArgs {
  command: string
  cwd?: string
  wait_ms?: number
  description?: string
  sandbox_permissions?: string
  justification?: string
}

/** Sandbox ingredients resolved once at plugin load, applied per call. */
export interface SandboxSeam {
  /** Closed escalation-target vocabulary; empty when no confining executor is mounted. */
  escalationModes: readonly SandboxMode[]
  /** Resolve the complete standing policy for one call; `undefined` without a confining executor. */
  resolveSandboxPolicy(exec: ToolExecution): SandboxExecutionPolicy | undefined
}

function abortedError(): HarnessError {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

function validateArgs(args: RunCommandArgs): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.wait_ms !== undefined && (!Number.isFinite(args.wait_ms) || args.wait_ms < 0)) {
    throw new Error(`invalid wait_ms: expected a non-negative number, got ${JSON.stringify(args.wait_ms)}`)
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}

function renderSync(proc: ShellProcess, waitedMs: number, escalationAvailable: boolean): string {
  const body = renderProcessRead(proc.readOutput(), proc.sandbox, escalationAvailable).trim() || '(No output)'
  const header = proc.status === 'killed'
    ? `Command was terminated after ${waitedMs}ms window (status: killed${proc.signal !== null ? `, signal: ${proc.signal}` : ''}):`
    : `Command finished (exit code ${proc.exitCode ?? 'N/A'}):`
  return `${header}\n${codeFence(body)}`
}

function renderBackground(outcome: Extract<RunCommandOutcome, { mode: 'background' }>): string {
  const waited = outcome.waitedMs === 0 ? 'immediately' : `after ${outcome.waitedMs}ms without completion`
  return [
    '[Background Task Started]',
    `JobId: ${outcome.jobId}`,
    `Promoted: ${waited}`,
    'Collect output with job_output, stop with job_kill. A completion notification with the output tail arrives on its own — never poll.',
  ].join('\n')
}

/**
 * Register the `run_command` tool against the harness seams present on `ctx`.
 * @param ctx - the plugin composition context; `shell` is injected, `jobs`,
 *   `shellEnv`, and `approval` are optional reads.
 * @param config - the resolved standing configuration.
 * @param seam - the sandbox ingredients resolved at load time.
 * @returns the disposer removing the tool registration.
 */
export function registerBackgroundTools(
  ctx: Context,
  config: ResolvedBackgroundTasksConfig,
  seam: SandboxSeam,
): () => void {
  const shell = ctx.shell

  const approveCommandEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (seam.escalationModes.length === 0 || standingPolicy === undefined) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode: standingPolicy.mode, subject: 'command' },
      { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'run_command', signal: exec.signal },
    )
  }

  const disposer = ctx.tools.register(
    defineTool({
      name: 'run_command',
      description:
        'Default runner for ANY shell command that may take longer than a few seconds — builds, installs, downloads, tests, training, batch scripts. ' +
        `Commands finishing within wait_ms (default ${config.waitMsBeforeAsync}ms) return the exit code and output synchronously; ` +
        'longer ones are automatically promoted into the harness job runtime — collect with job_output, stop with job_kill, and a completion notification with the output tail arrives on its own — never poll, never block the turn. ' +
        'Execution goes through the DSH shell executor under the session sandbox policy and approval pipeline, exactly like pwsh/bash; ' +
        'a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`. PowerShell on Windows, Bash on Linux/macOS. ' +
        'SSH: wrap the whole remote argument in SINGLE quotes (kept literal) — bash-style \\" nesting terminates the string early and silently mangles arguments.',
      parameters: {
        command: { type: 'string', required: true, description: 'The exact command line string to execute.' },
        cwd: { type: 'string', description: 'Working directory for the command. Defaults to the session workspace; a relative path is resolved against it.' },
        wait_ms: { type: 'number', description: `Patience window before this call yields and the command continues in background (default: ${config.waitMsBeforeAsync}; 0 = straight to background). NOT a timeout — the command always runs to completion and past-window results still arrive via notification, so larger values only block your turn longer. Raise above the default only when the very next step needs THIS result inline.` },
        description: { type: 'string', description: 'Optional short summary of what this command does.' },
        ...(seam.escalationModes.length > 0 ? {
          sandbox_permissions: {
            type: 'string' as const,
            enum: [...seam.escalationModes],
            description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
          },
          justification: {
            type: 'string' as const,
            description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
          },
        } : {}),
      },
      output: {
        schema: { type: 'string' },
        render: (_args, text: string) => [{ type: 'text', text }],
      },
      async execute(args: RunCommandArgs, exec): Promise<string> {
        validateArgs(args)
        // The caller owns cancellation until a promoted job commits ownership.
        if (exec.signal.aborted) throw abortedError()

        const standingPolicy = seam.resolveSandboxPolicy(exec)
        const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
          ? await approveCommandEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
          : undefined
        const policy = approvedMode === undefined
          ? standingPolicy
          : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }

        const workdir = resolveWorkdir(
          args.cwd,
          (exec.agent as Agent | undefined)?.session.header.cwd,
          standingPolicy?.workspaceRoot,
        )
        const shellEnv = ctx.get('shellEnv')
        const request: ShellExecRequest = {
          command: args.command,
          ...workdir !== undefined ? { workdir } : {},
          ...shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {},
          ...policy !== undefined ? { sandboxPolicy: policy } : {},
        }

        const waitMs = args.wait_ms ?? config.waitMsBeforeAsync
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background-tasks: ctx.jobs is not composed; every run_command call must remain collectable, so load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs')
        }

        /**
         * Hand an already-running process to the registry. Promotion starts
         * the process before preflight (inherent to racing a live process);
         * a rejected registration therefore kills the partial start.
         */
        const registerJob = (running: ShellProcess): string => {
          try {
            return jobs.start({
              kind: 'command',
              label: args.description ?? args.command,
              ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
              run: () => ({
                cancel: () => void running.kill(),
                done: running.done.then(() => processOutcome(running)),
                readOutput: () => renderProcessRead(running.readOutput(), running.sandbox, seam.escalationModes.length > 0),
              }),
            })
          } catch (err) {
            running.kill()
            throw err
          }
        }

        if (waitMs === 0) {
          const proc = shell.start(shell.resolve(request))
          const jobId = registerJob(proc)
          return renderBackground({ mode: 'background', jobId, waitedMs: 0 })
        }

        const proc = shell.start(shell.resolve(request))
        const winner = await raceCompletion(proc, waitMs, exec.signal)
        if (winner === 'promote') {
          const jobId = registerJob(proc)
          return renderBackground({ mode: 'background', jobId, waitedMs: waitMs })
        }
        return renderSync(proc, waitMs, seam.escalationModes.length > 0)
      },
    }),
  )

  return disposer
}
