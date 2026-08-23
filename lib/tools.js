import { defineTool } from '@deepseek-ai/dsh-tools';
import { codeFence } from './format.js';
/** Model-facing display cap for synchronous output; the full log path is always included. */
const SYNC_DISPLAY_LIMIT_BYTES = 32 * 1024;
/**
 * Stand-in identity when a dispatch reaches the tool without an agent context
 * (never under the real pipeline; kept so records stay addressable).
 */
const FALLBACK_SESSION_ID = 'default';
export function registerBackgroundTools(ctx, manager, config) {
    const disposers = [];
    // 1. run_command
    disposers.push(ctx.tools.register(defineTool({
        name: 'run_command',
        description: 'Default runner for ANY shell command that may take longer than a few seconds — builds, installs, downloads, tests, training, batch scripts. ' +
            `Commands finishing within wait_ms (default ${config.waitMsBeforeAsync}ms) return the exit code and output synchronously; ` +
            'longer ones are auto-promoted to a managed background task and a completion notification with the output tail arrives on its own — never poll, never block the turn. ' +
            'PowerShell on Windows (-EncodedCommand), Bash on Linux/macOS. ' +
            'Prefer over pwsh/bash whenever the duration is uncertain or likely to exceed ~10 seconds.',
        parameters: {
            command: {
                type: 'string',
                required: true,
                description: 'The exact command line string to execute.',
            },
            cwd: {
                type: 'string',
                description: 'Working directory for the command. Defaults to the current process working directory.',
            },
            wait_ms: {
                type: 'number',
                description: `Milliseconds to wait before promoting to background (default: ${config.waitMsBeforeAsync}). Set to 0 to launch directly into background.`,
            },
            description: {
                type: 'string',
                description: 'Optional short summary of what this command does.',
            },
        },
        output: {
            schema: {
                type: 'string',
            },
            render: (_args, text) => [{ type: 'text', text }],
        },
        async execute(args, exec) {
            const sessionId = exec?.agent?.session?.header?.id ?? FALLBACK_SESSION_ID;
            const agentId = exec?.agent?.id ?? sessionId;
            const result = await manager.runCommand({
                command: args.command,
                cwd: args.cwd,
                waitMsBeforeAsync: args.wait_ms ?? config.waitMsBeforeAsync,
                sessionId,
                agentId,
                description: args.description,
            });
            if (result.mode === 'sync') {
                const body = (result.output ?? '').trim() || '(No output)';
                const display = body.length <= SYNC_DISPLAY_LIMIT_BYTES
                    ? body
                    : `[...truncated, showing last ${SYNC_DISPLAY_LIMIT_BYTES} bytes of ${body.length} characters; full log: ${result.logPath}]\n` +
                        body.slice(-SYNC_DISPLAY_LIMIT_BYTES);
                return `Command finished (exit code ${result.exitCode ?? 'N/A'}):\n${codeFence(display)}`;
            }
            return [
                '[Background Task Started]',
                `TaskId: ${result.taskId}`,
                `Log: ${result.logPath}`,
                `Status: ${result.status}`,
                `Notice: ${result.message}`,
            ].join('\n');
        },
    })));
    // 2. manage_background_task
    disposers.push(ctx.tools.register(defineTool({
        name: 'manage_background_task',
        description: 'Manage background tasks started by run_command: list them, inspect status or live logs, or terminate a running task tree. ' +
            'Safe to call anytime — checking progress never blocks the running task.',
        parameters: {
            action: {
                type: 'string',
                enum: ['list', 'status', 'logs', 'kill'],
                required: true,
                description: 'Action to perform: list, status, logs, kill.',
            },
            task_id: {
                type: 'string',
                description: 'The task ID. Required for status, logs, and kill.',
            },
            tail_lines: {
                type: 'number',
                description: `Number of log lines to retrieve for the logs action (default: ${config.defaultTailLines}).`,
            },
        },
        output: {
            schema: {
                type: 'string',
            },
            render: (_args, text) => [{ type: 'text', text }],
        },
        async execute(args) {
            if (args.action === 'list') {
                const tasks = manager.listTasks();
                if (tasks.length === 0)
                    return 'No background tasks found.';
                const lines = tasks.map((t) => `- [${t.taskId}] (${t.status}) cmd: "${t.command}" | log: ${t.logPath}`);
                return `Background Tasks (${tasks.length}):\n${lines.join('\n')}`;
            }
            if (!args.task_id) {
                return `Error: task_id is required for action "${args.action}".`;
            }
            if (args.action === 'status') {
                const task = manager.getTask(args.task_id);
                if (!task)
                    return `Error: Task "${args.task_id}" not found.`;
                const durationSec = ((task.endTime ?? Date.now()) - task.startTime) / 1000;
                return [
                    `Task: ${task.taskId}`,
                    `Status: ${task.status}`,
                    `Command: ${task.command}`,
                    `CWD: ${task.cwd}`,
                    `Duration: ${durationSec.toFixed(2)}s`,
                    `Exit Code: ${task.exitCode ?? 'N/A'}`,
                    `Log: ${task.logPath}`,
                ].join('\n');
            }
            if (args.action === 'logs') {
                const logResult = manager.readTaskLogs(args.task_id, args.tail_lines ?? config.defaultTailLines);
                if (!logResult.exists)
                    return `Error: Task "${args.task_id}" not found.`;
                return `Logs for task [${args.task_id}]:\n${codeFence(logResult.logs)}`;
            }
            if (args.action === 'kill') {
                const killResult = manager.killTask(args.task_id);
                return `[Kill Task] Success: ${killResult.success}\nMessage: ${killResult.message}`;
            }
            return `Error: Unknown action "${args.action}".`;
        },
    })));
    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch {
                // A failing individual disposer must not stop its siblings from
                // running during plugin teardown; registration cleanup is best-effort.
            }
        }
    };
}
//# sourceMappingURL=tools.js.map