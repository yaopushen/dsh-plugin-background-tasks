import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundTasksConfig, ResolvedBackgroundTasksConfig } from './types.js'

/** Audited defaults; every field is overridable through cordis.yml entry config. */
export const BACKGROUND_TASKS_DEFAULTS: ResolvedBackgroundTasksConfig = {
  waitMsBeforeAsync: 5000,
  taskDir: join(homedir(), '.dsh', 'tasks'),
  defaultTailLines: 50,
  maxCompletedTasks: 100,
  syncOutputLimitBytes: 256 * 1024,
}

function requireInt(
  raw: unknown,
  field: string,
  fallback: number,
  { min }: { min: number },
): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) {
    throw new TypeError(
      `background-tasks: config.${field} must be an integer >= ${min}, got ${JSON.stringify(raw)}`,
    )
  }
  return raw
}

function requireString(raw: unknown, field: string, fallback: string): string {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TypeError(
      `background-tasks: config.${field} must be a non-empty string, got ${JSON.stringify(raw)}`,
    )
  }
  return raw
}

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
export function resolveBackgroundTasksConfig(
  raw: BackgroundTasksConfig = {},
): ResolvedBackgroundTasksConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(
      `background-tasks: config must be an object, got ${JSON.stringify(raw)}`,
    )
  }
  return {
    waitMsBeforeAsync: requireInt(raw.waitMsBeforeAsync, 'waitMsBeforeAsync', BACKGROUND_TASKS_DEFAULTS.waitMsBeforeAsync, { min: 0 }),
    taskDir: requireString(raw.taskDir, 'taskDir', BACKGROUND_TASKS_DEFAULTS.taskDir),
    defaultTailLines: requireInt(raw.defaultTailLines, 'defaultTailLines', BACKGROUND_TASKS_DEFAULTS.defaultTailLines, { min: 1 }),
    maxCompletedTasks: requireInt(raw.maxCompletedTasks, 'maxCompletedTasks', BACKGROUND_TASKS_DEFAULTS.maxCompletedTasks, { min: 1 }),
    syncOutputLimitBytes: requireInt(raw.syncOutputLimitBytes, 'syncOutputLimitBytes', BACKGROUND_TASKS_DEFAULTS.syncOutputLimitBytes, { min: 1 }),
  }
}
