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
import { ESCALATION_TARGETS } from '@deepseek-ai/dsh-sandbox';
import { resolveBackgroundTasksConfig } from './config.js';
import { registerBackgroundTools } from './tools.js';
import { installPackagedPreset } from './preset-installer.js';
export { BACKGROUND_TASKS_DEFAULTS, resolveBackgroundTasksConfig } from './config.js';
export const name = 'dsh-plugin-background-tasks';
/** `shell` is the execution seam this plugin exists to drive; without it the composition cannot serve the tool at all. */
export const inject = ['tools', 'shell'];
/**
 * Mount the background-tasks plugin. Invalid config throws here at load time;
 * after this point every config field is resolved and validated.
 * @param ctx - the composition context.
 * @param rawConfig - the cordis entry `config` object, when present.
 */
export function apply(ctx, rawConfig = {}) {
    const config = resolveBackgroundTasksConfig(rawConfig);
    const log = ctx.logger('background-tasks');
    log.info('initializing plugin (seam-aligned: ctx.shell + ctx.jobs; waitMsBeforeAsync=%s)', config.waitMsBeforeAsync);
    if (ctx.get('shellEnv') === undefined) {
        log.warn('shellEnv service is not composed; commands will run without managed DSH_* variables '
            + '(load @deepseek-ai/dsh-shell-env in this composition)');
    }
    // Mirror the harness shell tools: an executor that confines without the
    // shared policy resolver is a split composition that must fail at load.
    const defaultMode = ctx.shell.sandboxMode;
    const sandboxPolicyService = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy');
    if (defaultMode !== undefined && sandboxPolicyService === undefined) {
        throw new Error('dsh-plugin-background-tasks: the mounted shell executor confines but ctx.sandboxPolicy is missing');
    }
    const seam = {
        escalationModes: defaultMode === undefined ? [] : ESCALATION_TARGETS,
        resolveSandboxPolicy: (exec) => sandboxPolicyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }),
    };
    const unregisterTools = registerBackgroundTools(ctx, config, seam);
    // Auto-install packaged agent preset to $DSH_HOME/.agent-presets/background-shell/
    installPackagedPreset(ctx).catch(() => {
        // Best-effort auto-installation; warning already logged inside installer.
    });
    ctx.effect(() => {
        return () => {
            log.info('disposing background-tasks plugin');
            unregisterTools();
        };
    }, 'background-tasks teardown');
    log.info('plugin loaded');
}
//# sourceMappingURL=index.js.map