import type { BackgroundTasksConfig, ResolvedBackgroundTasksConfig } from './types.js';
/** Audited defaults; every field is overridable through cordis.yml entry config. */
export declare const BACKGROUND_TASKS_DEFAULTS: ResolvedBackgroundTasksConfig;
/**
 * Validate one raw cordis.yml config object and apply defaults. Throws at load
 * time on any invalid field (misconfiguration fails loud), so callers can rely
 * on every field being present and well-typed afterwards.
 *
 * Hand-rolled instead of schemastery on purpose: the plugin is mounted by
 * absolute path outside any node_modules tree and keeps zero runtime
 * dependencies; type-only imports of dsh packages vanish at compile time, but
 * a schemastery import would have to resolve on the host at runtime.
 */
export declare function resolveBackgroundTasksConfig(raw?: BackgroundTasksConfig): ResolvedBackgroundTasksConfig;
//# sourceMappingURL=config.d.ts.map