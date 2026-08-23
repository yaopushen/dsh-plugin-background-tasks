/**
 * dsh-plugin-background-tasks — seam-aligned background command execution for
 * DeepSeek Harness. One tool (`run_command`) runs every command through the
 * harness `ctx.shell` executor under the session sandbox policy; commands
 * exceeding the wait window are promoted into the generic `ctx.jobs` runtime,
 * which owns identity, owner-fenced access, output collection, cancellation,
 * and completion notices. The plugin owns no registry of its own.
 *
 * Function plugin protocol: named exports only, no default export (a default
 * export makes the Loader discard the namespace and with it `inject`).
 * @module dsh-plugin-background-tasks
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BackgroundTasksConfig } from './types.js';
export { BACKGROUND_TASKS_DEFAULTS, resolveBackgroundTasksConfig } from './config.js';
export type { BackgroundTasksConfig, ResolvedBackgroundTasksConfig, RunCommandOutcome, SyncCommandOutcome, BackgroundCommandOutcome, } from './types.js';
export declare const name = "dsh-plugin-background-tasks";
/** `shell` is the execution seam this plugin exists to drive; without it the composition cannot serve the tool at all. */
export declare const inject: string[];
/**
 * Mount the background-tasks plugin. Invalid config throws here at load time;
 * after this point every config field is resolved and validated.
 * @param ctx - the composition context.
 * @param rawConfig - the cordis entry `config` object, when present.
 */
export declare function apply(ctx: Context, rawConfig?: BackgroundTasksConfig): void;
//# sourceMappingURL=index.d.ts.map