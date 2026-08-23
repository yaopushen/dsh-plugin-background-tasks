/**
 * Pure adaptation helpers between the model-facing `run_command` contract and
 * the `ctx.shell` / `ctx.jobs` seams. No host services are touched here, so
 * every helper is unit-testable without a live composition.
 * @module dsh-plugin-background-tasks/shell-exec
 */
import type { ShellProcess, ShellProcessRead, ShellSandboxInfo } from '@deepseek-ai/dsh-shell';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
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
export declare function resolveWorkdir(modelCwd: string | undefined, headerCwd: string | undefined, policyWorkspaceRoot: string | undefined): string | undefined;
/**
 * Map a settled background process onto the generic job-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported as completed, not failed, matching the harness tools' rendering.
 * @param proc - the settled process handle.
 * @returns the outcome supplied through {@link JobOutcome} to `ctx.jobs`.
 */
export declare function processOutcome(proc: Pick<ShellProcess, 'status' | 'exitCode' | 'signal'>): JobOutcome;
/**
 * Render one incremental process read into job-output text. The delta already
 * carries stderr in its marked section; lossy reads gain an explicit
 * truncation notice pointing at the executor's spill files, and a policy
 * denial gains the shared harness denial marker — plus, when this composition
 * advertises the escalation surface, the shared same-turn escalation hint at
 * the decision point, verbatim with the native shell tools.
 * @param read - the consuming read returned by {@link ShellProcess.readOutput}.
 * @param sandbox - the process's sandbox facts, stamped by confining executors.
 * @param escalationAvailable - whether this composition advertises
 *   `sandbox_permissions` (a confining executor is mounted).
 * @returns the text handed to `ctx.jobs` as this read's output delta.
 */
export declare function renderProcessRead(read: ShellProcessRead, sandbox: ShellSandboxInfo | undefined, escalationAvailable?: boolean): string;
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
export declare function raceCompletion(proc: Pick<ShellProcess, 'done'>, waitMs: number, abort?: AbortSignal): Promise<'completed' | 'promote'>;
//# sourceMappingURL=shell-exec.d.ts.map