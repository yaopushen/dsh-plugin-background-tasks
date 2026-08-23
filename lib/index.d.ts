import type { Context } from '@deepseek-ai/cordis';
import type { BackgroundTasksConfig } from './types.js';
export { TaskManager } from './manager.js';
export { BACKGROUND_TASKS_DEFAULTS, resolveBackgroundTasksConfig } from './config.js';
export type { BackgroundTasksConfig, ResolvedBackgroundTasksConfig, RunCommandResult, ManageTaskResult, TaskRecord, TaskStatus, } from './types.js';
export declare const name = "dsh-plugin-background-tasks";
export declare const inject: string[];
/**
 * Mount the background-tasks plugin. Invalid config throws here at load time;
 * after this point every config field is resolved and validated.
 */
export declare function apply(ctx: Context, rawConfig?: BackgroundTasksConfig): void;
//# sourceMappingURL=index.d.ts.map