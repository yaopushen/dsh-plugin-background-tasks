/**
 * Public types of the background-tasks plugin. Registry state, job identity,
 * and completion notices live in the harness `ctx.jobs` runtime, so this
 * module only carries the plugin config and the tool's own outcome union.
 * @module dsh-plugin-background-tasks/types
 */

/** Plugin config as accepted from cordis.yml (all fields optional). */
export interface BackgroundTasksConfig {
  /** Milliseconds to wait synchronously before promoting a command to a background job (default: 10000ms); 0 starts in background directly. */
  waitMsBeforeAsync?: number
}

/** Fully resolved plugin config; every field is validated by resolveBackgroundTasksConfig at load time. */
export interface ResolvedBackgroundTasksConfig {
  waitMsBeforeAsync: number
}

/**
 * Synchronous outcome: the process settled inside the wait window. Output is
 * the executor-captured combined stream; spill metadata appears only when the
 * executor truncated a stream it could not retain in memory.
 */
export interface SyncCommandOutcome {
  mode: 'sync'
  exitCode: number | null
  signal: string | null
  killed: boolean
  output: string
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

/** Background acknowledgement: the command was handed to the `ctx.jobs` registry. */
export interface BackgroundCommandOutcome {
  mode: 'background'
  /** The `<kind>-N` id issued by ctx.jobs; collect with `job_output`, stop with `job_kill`. */
  jobId: string
  waitedMs: number
}

export type RunCommandOutcome = SyncCommandOutcome | BackgroundCommandOutcome
