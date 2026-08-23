/**
 * Fail-loud configuration resolver. Validation stays hand-rolled (no runtime
 * schema dependency) so a tree-external link/path mount keeps zero external
 * runtime requirements; invalid types throw here at load time.
 * @module dsh-plugin-background-tasks/config
 */
import type { BackgroundTasksConfig, ResolvedBackgroundTasksConfig } from './types.js';
/** Defaults applied when the cordis entry omits the field. */
export declare const BACKGROUND_TASKS_DEFAULTS: ResolvedBackgroundTasksConfig;
/**
 * Validate one raw cordis.yml config object and apply defaults. Throws at load
 * time on any invalid field (misconfiguration fails loud), so callers can rely
 * on every field being present and well-typed afterwards.
 *
 * Hand-rolled instead of schemastery on purpose: the plugin is mounted by
 * absolute path outside any node_modules tree and keeps its runtime surface
 * limited to the harness seams it consumes; a schemastery import would add a
 * vendored-package dependency for no validation power this single integer
 * field needs.
 * @param raw - the cordis entry `config` object, when present.
 * @returns the fully resolved config; every field present and well-typed.
 */
export declare function resolveBackgroundTasksConfig(raw?: BackgroundTasksConfig): ResolvedBackgroundTasksConfig;
//# sourceMappingURL=config.d.ts.map