import type { ChildProcess } from 'node:child_process'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The harness-branded session id (Agent.id shares the session identity); derived to avoid depending on @deepseek-ai/dsh-session directly. */
export type DshSessionId = Agent['id']

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface TaskRecord {
  taskId: string
  command: string
  cwd: string
  startTime: number
  endTime?: number
  status: TaskStatus
  exitCode?: number | null
  signal?: string | null
  logPath: string
  sessionId: DshSessionId
  agentId: DshSessionId
  child?: ChildProcess
  description?: string
}

export interface RunCommandResult {
  mode: 'sync' | 'background'
  taskId?: string
  status: TaskStatus
  command: string
  exitCode?: number | null
  stdout?: string
  stderr?: string
  output?: string
  logPath?: string
  message?: string
}

export interface ManageTaskResult {
  action: string
  tasks?: Array<Omit<TaskRecord, 'child'>>
  task?: Omit<TaskRecord, 'child'>
  logs?: string
  success: boolean
  message?: string
}

/** Plugin config as accepted from cordis.yml (all fields optional). */
export interface BackgroundTasksConfig {
  /** Milliseconds to wait synchronously before promoting a command to background; 0 launches straight into background. */
  waitMsBeforeAsync?: number
  /** Directory for per-task log files. Default: ~/.dsh/tasks. */
  taskDir?: string
  /** Default line count for the logs action and for completion wakeup tails. */
  defaultTailLines?: number
  /** Retention cap: finished tasks beyond this are pruned oldest-first together with their log files. */
  maxCompletedTasks?: number
  /** Cap on stdout+stderr accumulated during one synchronous wait window, in bytes. */
  syncOutputLimitBytes?: number
}

/** Fully resolved plugin config; every field is guaranteed by resolveBackgroundTasksConfig. */
export type ResolvedBackgroundTasksConfig = Required<BackgroundTasksConfig>
