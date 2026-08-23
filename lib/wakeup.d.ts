import type { Context } from '@deepseek-ai/cordis';
import type { TaskRecord } from './types.js';
/**
 * Deliver one task-completion wakeup to the agent that launched the task.
 *
 * The agent is looked up strictly by id: agent ids are session ids in DSH, so
 * when the lookup misses the launching agent/session is gone, and delivering
 * the notification to some unrelated root agent would inject another session's
 * context. In that case the wakeup is dropped and the log path is reported.
 */
export declare function deliverTaskWakeup(ctx: Context, task: TaskRecord, tailLogs: string): void;
//# sourceMappingURL=wakeup.d.ts.map