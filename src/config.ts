/**
 * Fail-loud configuration resolver. Validation stays hand-rolled (no runtime
 * schema dependency) so a tree-external link/path mount keeps zero external
 * runtime requirements; invalid types throw here at load time.
 * @module dsh-plugin-background-tasks/config
 */

import type { BackgroundTasksConfig, ResolvedBackgroundTasksConfig } from './types.js'

/** Defaults applied when the cordis entry omits the field. */
export const BACKGROUND_TASKS_DEFAULTS: ResolvedBackgroundTasksConfig = {
  waitMsBeforeAsync: 10_000,
}

function failField(field: string, value: unknown, expected: string): never {
  throw new TypeError(
    `dsh-plugin-background-tasks config: ${field} must be ${expected}, got ${JSON.stringify(value)}`,
  )
}

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
export function resolveBackgroundTasksConfig(
  raw: BackgroundTasksConfig = {},
): ResolvedBackgroundTasksConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    failField('(root)', raw, 'an object')
  }
  // Only a truly absent field takes the default; an explicit null is a
  // misconfiguration and fails loud below.
  const requested = raw.waitMsBeforeAsync
  const waitMsBeforeAsync = requested === undefined ? BACKGROUND_TASKS_DEFAULTS.waitMsBeforeAsync : requested
  if (typeof waitMsBeforeAsync !== 'number' || !Number.isInteger(waitMsBeforeAsync) || waitMsBeforeAsync < 0) {
    failField('waitMsBeforeAsync', raw.waitMsBeforeAsync, 'a non-negative integer')
  }
  return { waitMsBeforeAsync }
}
