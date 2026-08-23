import { resolveBackgroundTasksConfig } from './config.js';
import { TaskManager } from './manager.js';
import { registerBackgroundTools } from './tools.js';
import { deliverTaskWakeup } from './wakeup.js';
export { TaskManager } from './manager.js';
export { BACKGROUND_TASKS_DEFAULTS, resolveBackgroundTasksConfig } from './config.js';
export const name = 'dsh-plugin-background-tasks';
export const inject = ['tools', 'agents'];
/**
 * Mount the background-tasks plugin. Invalid config throws here at load time;
 * after this point every config field is resolved and validated.
 */
export function apply(ctx, rawConfig = {}) {
    const config = resolveBackgroundTasksConfig(rawConfig);
    const log = ctx.logger('background-tasks');
    log.info('initializing plugin (taskDir=%s, waitMsBeforeAsync=%s, maxCompletedTasks=%s)', config.taskDir, config.waitMsBeforeAsync, config.maxCompletedTasks);
    const manager = new TaskManager(config);
    // Completion hooks fire only for promoted tasks that were not killed or torn
    // down (see TaskManager settlement); each delivery wakes the owning agent.
    const unhookComplete = manager.onTaskComplete((task, tailLogs) => {
        deliverTaskWakeup(ctx, task, tailLogs);
    });
    const unregisterTools = registerBackgroundTools(ctx, manager, config);
    ctx.effect(() => {
        return () => {
            log.info('disposing background task manager');
            unhookComplete();
            unregisterTools();
            manager.dispose();
        };
    }, 'background-tasks teardown');
    log.info('plugin loaded');
}
//# sourceMappingURL=index.js.map