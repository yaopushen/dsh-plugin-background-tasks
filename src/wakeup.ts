import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { codeFence } from './format.js'
import type { TaskRecord } from './types.js'

/**
 * Deliver one task-completion wakeup to the agent that launched the task.
 *
 * The agent is looked up strictly by id: agent ids are session ids in DSH, so
 * when the lookup misses the launching agent/session is gone, and delivering
 * the notification to some unrelated root agent would inject another session's
 * context. In that case the wakeup is dropped and the log path is reported.
 */
export function deliverTaskWakeup(ctx: Context, task: TaskRecord, tailLogs: string): void {
  const log = ctx.logger('background-tasks')
  const agent = ctx.agents.get(task.agentId)
  if (!agent) {
    log.warn(
      'background-tasks: agent %s is no longer active; dropping wakeup for task %s (full log kept at %s)',
      task.agentId,
      task.taskId,
      task.logPath,
    )
    return
  }

  const durationSec = ((task.endTime ?? Date.now()) - task.startTime) / 1000
  const isSuccess = task.status === 'completed'

  const messageText = [
    `[System Notification: Background Task "${task.taskId}" ${isSuccess ? 'Completed' : 'Failed'}]`,
    `Command: ${task.command}`,
    `CWD: ${task.cwd}`,
    `Duration: ${durationSec.toFixed(2)}s`,
    `Exit Code: ${task.exitCode ?? 'N/A'} (Status: ${task.status})`,
    `Log File: ${task.logPath}`,
    '',
    'Output Tail:',
    codeFence(tailLogs.trim() || '(No output recorded)'),
    '',
    'Please review the result and proceed with your workflow.',
  ].join('\n')

  try {
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: messageText }],
        source: { kind: 'plugin', plugin: 'background-tasks' },
      }),
    )
    log.info(
      'background-tasks: delivered wakeup for task %s to session %s',
      task.taskId,
      task.sessionId,
    )
  } catch (err: unknown) {
    // followup can throw on a disposed or mid-cancel agent; the task outcome is
    // still durable in the log file, so a failed delivery is downgraded to warn.
    log.warn(
      'background-tasks: failed to deliver wakeup for task %s: %s',
      task.taskId,
      String(err),
    )
  }
}
