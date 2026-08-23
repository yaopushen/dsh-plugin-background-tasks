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
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';
import { codeFence } from './format.js';
import { processOutcome, raceCompletion, renderProcessRead, resolveWorkdir } from './shell-exec.js';
function abortedError() {
    const error = new HarnessError('tool call aborted', TOOL_ABORTED);
    error.name = 'AbortError';
    return error;
}
function validateArgs(args) {
    if (args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string');
    }
    validateEscalationArgs(args.sandbox_permissions, args.justification);
}
function renderSync(proc, escalationAvailable) {
    const body = renderProcessRead(proc.readOutput(), proc.sandbox, escalationAvailable).trim() || '(No output)';
    const header = proc.status === 'killed'
        ? `Command was terminated before completion (status: killed${proc.signal !== null ? `, signal: ${proc.signal}` : ''}):`
        : `Command finished (exit code ${proc.exitCode ?? 'N/A'}):`;
    return `${header}\n${codeFence(body)}`;
}
function renderBackground(outcome) {
    return [
        '[Command moved to background]',
        `JobId: ${outcome.jobId}`,
        'The result arrives via completion notification; manage with job_output / job_kill.',
    ].join('\n');
}
/**
 * Register the `run_command` tool against the harness seams present on `ctx`.
 * @param ctx - the plugin composition context; `shell` is injected, `jobs`,
 *   `shellEnv`, and `approval` are optional reads.
 * @param config - the resolved standing configuration.
 * @param seam - the sandbox ingredients resolved at load time.
 * @returns the disposer removing the tool registration.
 */
export function registerBackgroundTools(ctx, config, seam) {
    const shell = ctx.shell;
    const approveCommandEscalation = (mode, justification, exec, standingPolicy) => {
        if (seam.escalationModes.length === 0 || standingPolicy === undefined) {
            throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)');
        }
        return approveEscalation({ requestedMode: mode, justification, effectiveMode: standingPolicy.mode, subject: 'command' }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'run_command', signal: exec.signal });
    };
    const disposer = ctx.tools.register(defineTool({
        name: 'run_command',
        description: 'A default executor compatible with any shell command — suitable for scenarios such as building, installing, downloading, testing, model training, and batch scripting. ' +
            'If a command completes within a few seconds, the system synchronously returns the exit code and output; for longer-running commands, execution automatically shifts to the background, with the final result delivered via a completion notification. ' +
            'There is no need for polling or artificial delays (e.g. Start-Sleep): simply run the actual command, allowing long-running tasks to execute in the background until completion — this is non-blocking. ' +
            'Commands are executed by the DSH shell executor within a session sandbox and subject to approval workflows, mirroring the behavior of pwsh or bash; if file operations are blocked, the system returns the error `[sandbox: file access denied under <mode> mode]`. ' +
            'PowerShell is used on Windows, Bash on Linux/macOS. ' +
            'For SSH commands, enclose the entire remote command argument in single quotes (\') to prevent escaping or variable-expansion issues. ' +
            'For Python commands: on Linux/macOS use a Bash heredoc —\n' +
            "python3 - << 'EOF'\n# arbitrary multi-line code; no need to worry about quote conflicts\nEOF\n" +
            "on Windows pipe a PowerShell here-string into the interpreter:\n@'\n# arbitrary multi-line code\n'@ | python -",
        parameters: {
            command: { type: 'string', required: true, description: 'The exact command line string to execute.' },
            cwd: { type: 'string', description: 'Working directory for the command. Defaults to the session workspace; a relative path is resolved against it.' },
            description: { type: 'string', description: 'Optional short summary of what this command does.' },
            ...(seam.escalationModes.length > 0 ? {
                sandbox_permissions: {
                    type: 'string',
                    enum: [...seam.escalationModes],
                    description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
                },
                justification: {
                    type: 'string',
                    description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
                },
            } : {}),
        },
        output: {
            schema: { type: 'string' },
            render: (_args, text) => [{ type: 'text', text }],
        },
        async execute(args, exec) {
            validateArgs(args);
            // The caller owns cancellation until a promoted job commits ownership.
            if (exec.signal.aborted)
                throw abortedError();
            const standingPolicy = seam.resolveSandboxPolicy(exec);
            const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
                ? await approveCommandEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
                : undefined;
            const policy = approvedMode === undefined
                ? standingPolicy
                : { ...standingPolicy, mode: approvedMode };
            const workdir = resolveWorkdir(args.cwd, exec.agent?.session.header.cwd, standingPolicy?.workspaceRoot);
            const shellEnv = ctx.get('shellEnv');
            const request = {
                command: args.command,
                ...workdir !== undefined ? { workdir } : {},
                ...shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {},
                ...policy !== undefined ? { sandboxPolicy: policy } : {},
            };
            // The window belongs to the deployment, not the model: one config
            // value governs every call (see Known Limitations in README).
            const waitMs = config.waitMsBeforeAsync;
            const jobs = ctx.get('jobs');
            if (jobs === undefined) {
                throw new Error('background-tasks: ctx.jobs is not composed; every run_command call must remain collectable, so load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs');
            }
            /**
             * Hand an already-running process to the registry. Promotion starts
             * the process before preflight (inherent to racing a live process);
             * a rejected registration therefore kills the partial start.
             */
            const registerJob = (running) => {
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
                    });
                }
                catch (err) {
                    running.kill();
                    throw err;
                }
            };
            const proc = shell.start(shell.resolve(request));
            const winner = await raceCompletion(proc, waitMs, exec.signal);
            if (winner === 'promote') {
                const jobId = registerJob(proc);
                return renderBackground({ mode: 'background', jobId, waitedMs: waitMs });
            }
            return renderSync(proc, seam.escalationModes.length > 0);
        },
    }));
    return disposer;
}
//# sourceMappingURL=tools.js.map