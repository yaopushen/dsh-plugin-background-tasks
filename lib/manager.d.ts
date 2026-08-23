import type { DshSessionId, ResolvedBackgroundTasksConfig, RunCommandResult, TaskRecord } from './types.js';
export type TaskCompleteCallback = (task: TaskRecord, tailLogs: string) => void;
interface RunRequest {
    command: string;
    cwd?: string;
    waitMsBeforeAsync?: number;
    sessionId: DshSessionId;
    agentId: DshSessionId;
    description?: string;
}
/**
 * Owns background command lifecycle: synchronous-wait promotion, per-task log
 * files, process-tree termination, retention pruning, and completion hooks.
 *
 * Settlement is single-homed: close, process error, explicit kill, and manager
 * disposal all converge on one once-per-task settler that finalizes the record,
 * writes the log trailer exactly once, closes the stream, and fires hooks.
 * This ordering guarantees no write ever lands after the stream ended.
 */
export declare class TaskManager {
    private tasks;
    private logStreams;
    private settlers;
    private hooks;
    private readonly taskDir;
    private readonly maxCompletedTasks;
    private readonly syncOutputLimitBytes;
    constructor(options?: Partial<ResolvedBackgroundTasksConfig>);
    onTaskComplete(callback: TaskCompleteCallback): () => void;
    getTask(taskId: string): TaskRecord | undefined;
    listTasks(sessionId?: DshSessionId): Array<Omit<TaskRecord, 'child'>>;
    /**
     * Read a task's log tail without loading an unbounded file: files larger than
     * LOG_TAIL_READ_BYTES are read from a byte offset and their first partial
     * line dropped, then the result is capped to `maxLines` lines.
     */
    readTaskLogs(taskId: string, maxLines?: number): {
        exists: boolean;
        logs: string;
    };
    /**
     * Kill a running task's whole process tree. The kill request settles the task
     * as 'killed' immediately; the later child close event is absorbed by the
     * settlement guard, so the status cannot flip to 'failed' and no completion
     * hook fires for an intentional kill.
     */
    killTask(taskId: string): {
        success: boolean;
        message: string;
    };
    /**
     * Run `command` through the platform shell. Returns synchronously when the
     * command exits within `waitMsBeforeAsync`; otherwise promotes it to a
     * background task whose completion later fires the registered hooks.
     */
    runCommand(request: RunRequest): Promise<RunCommandResult>;
    /**
     * Kill every running task and settle all state without firing completion
     * hooks. Safe against later close events: those are absorbed by each task's
     * settlement guard, so no write can reach an ended log stream afterwards.
     */
    dispose(): void;
    /** Enforce the finished-task retention cap, deleting evicted log files. */
    private prune;
    private killTree;
}
export {};
//# sourceMappingURL=manager.d.ts.map