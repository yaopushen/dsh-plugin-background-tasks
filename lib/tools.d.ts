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
import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type { ResolvedBackgroundTasksConfig } from './types.js';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        /** Background commands promoted by this plugin (`command-N` ids). */
        command: 'command';
    }
}
/** Sandbox ingredients resolved once at plugin load, applied per call. */
export interface SandboxSeam {
    /** Closed escalation-target vocabulary; empty when no confining executor is mounted. */
    escalationModes: readonly SandboxMode[];
    /** Resolve the complete standing policy for one call; `undefined` without a confining executor. */
    resolveSandboxPolicy(exec: ToolExecution): SandboxExecutionPolicy | undefined;
}
/**
 * Register the `run_command` tool against the harness seams present on `ctx`.
 * @param ctx - the plugin composition context; `shell` is injected, `jobs`,
 *   `shellEnv`, and `approval` are optional reads.
 * @param config - the resolved standing configuration.
 * @param seam - the sandbox ingredients resolved at load time.
 * @returns the disposer removing the tool registration.
 */
export declare function registerBackgroundTools(ctx: Context, config: ResolvedBackgroundTasksConfig, seam: SandboxSeam): () => void;
//# sourceMappingURL=tools.d.ts.map