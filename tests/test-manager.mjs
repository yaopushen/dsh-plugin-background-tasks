import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from '../lib/manager.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll until predicate() is truthy; sleeps drive only the polling interval,
 * never the assertion itself, so the suite stays timing-robust.
 */
async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(25)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`)
}

async function runTests() {
  console.log('=== TaskManager verification tests ===\n')
  const taskDir = mkdtempSync(join(tmpdir(), 'dsh-bgtest-'))
  const manager = new TaskManager({ taskDir, maxCompletedTasks: 2 })

  let hookCalls = 0
  let lastHookTaskId = ''
  let lastHookTail = ''
  manager.onTaskComplete((task, tail) => {
    hookCalls += 1
    lastHookTaskId = task.taskId
    lastHookTail = tail
  })

  try {
    // 1. Quick command settles synchronously.
    console.log('Test 1: quick sync command...')
    const syncRes = await manager.runCommand({
      command: 'echo HELLO_SYNC_TEST',
      waitMsBeforeAsync: 8000,
      sessionId: 's1',
      agentId: 's1',
    })
    if (syncRes.mode !== 'sync' || !syncRes.output?.includes('HELLO_SYNC_TEST')) {
      throw new Error(`Test 1 failed: expected sync output, got ${JSON.stringify(syncRes)}`)
    }
    console.log('\u2714 Test 1 passed\n')

    // 2. Long command promotes to background; completion hook fires exactly once.
    console.log('Test 2: timeout promotion + single completion hook...')
    const bg = await manager.runCommand({
      command: process.platform === 'win32'
        ? 'Start-Sleep -Seconds 1; echo ASYNC_DONE'
        : 'sleep 1; echo ASYNC_DONE',
      waitMsBeforeAsync: 300,
      sessionId: 's2',
      agentId: 's2',
    })
    if (bg.mode !== 'background' || !bg.taskId) {
      throw new Error(`Test 2 failed: expected background promotion, got ${JSON.stringify(bg)}`)
    }
    await waitFor(
      () => manager.getTask(bg.taskId)?.status === 'completed',
      'background task to complete',
    )
    const settledTask = manager.getTask(bg.taskId)
    await waitFor(() => hookCalls >= 1, 'completion hook')
    if (lastHookTaskId !== bg.taskId || hookCalls !== 1) {
      throw new Error(`Test 2 failed: expected exactly one hook for ${bg.taskId}, got ${hookCalls} (last: ${lastHookTaskId})`)
    }
    if (!settledTask || settledTask.exitCode !== 0) {
      throw new Error(`Test 2 failed: expected exitCode 0, got ${settledTask?.exitCode}`)
    }
    if (!lastHookTail.includes('ASYNC_DONE')) {
      throw new Error('Test 2 failed: hook tail does not contain the task output')
    }
    console.log(`\u2714 Test 2 passed (exit code ${settledTask.exitCode}, hook tail carries output)\n`)

    // 3. Kill keeps status 'killed' even after the close event lands
    //    (regression: close used to overwrite 'killed' with 'failed').
    console.log('Test 3: kill preserves killed status after settlement...')
    const victim = await manager.runCommand({
      command: process.platform === 'win32'
        ? 'Start-Sleep -Seconds 20'
        : 'sleep 20',
      waitMsBeforeAsync: 200,
      sessionId: 's3',
      agentId: 's3',
    })
    if (victim.mode !== 'background') throw new Error('Test 3 failed: expected background promotion')
    const killResult = manager.killTask(victim.taskId)
    if (!killResult.success) throw new Error(`Test 3 failed: kill failed: ${killResult.message}`)
    await waitFor(
      () => manager.getTask(victim.taskId)?.signal != null || manager.getTask(victim.taskId)?.endTime != null,
      'killed child close event',
    )
    const killedStatus = manager.getTask(victim.taskId)?.status
    if (killedStatus !== 'killed') {
      throw new Error(`Test 3 failed: status flipped to "${killedStatus}" after settle, expected 'killed'`)
    }
    if (hookCalls !== 1) {
      throw new Error(`Test 3 failed: kill fired a completion hook (calls: ${hookCalls})`)
    }
    console.log('\u2714 Test 3 passed\n')

    // 4. Launch failure (bad cwd) settles as failed via the error path instead
    //    of hanging or throwing (regression: error events never settled).
    console.log('Test 4: spawn error path...')
    const badCwd = join(taskDir, 'does-not-exist')
    const errRes = await manager.runCommand({
      command: 'echo never',
      cwd: badCwd,
      waitMsBeforeAsync: 4000,
      sessionId: 's4',
      agentId: 's4',
    })
    if (errRes.status !== 'failed') {
      throw new Error(`Test 4 failed: expected failed status on spawn error, got ${errRes.status}`)
    }
    if (hookCalls !== 1) {
      throw new Error(`Test 4 failed: sync-mode failure must not fire hooks (${hookCalls})`)
    }
    console.log('\u2714 Test 4 passed\n')

    // 5. Retention cap prunes oldest finished tasks and their log files.
    console.log('Test 5: retention pruning...')
    for (let i = 0; i < 4; i++) {
      const res = await manager.runCommand({
        command: `echo RETENTION_${i}`,
        waitMsBeforeAsync: 8000,
        sessionId: 's5',
        agentId: 's5',
      })
      if (res.mode !== 'sync') throw new Error(`Test 5 failed: task ${i} did not finish synchronously`)
    }
    const remaining = manager.listTasks()
    if (remaining.length > 2) {
      throw new Error(`Test 5 failed: ${remaining.length} tasks retained, cap is 2`)
    }
    for (const task of remaining) {
      if (!existsSync(task.logPath)) throw new Error(`Test 5 failed: retained log missing: ${task.logPath}`)
    }
    console.log(`\u2714 Test 5 passed (${remaining.length} tasks retained)\n`)

    // 6. Dispose kills running children and absorbs their later close events
    //    without crashing the host (regression: post-end stream write).
    console.log('Test 6: dispose with a running task...')
    const orphan = await manager.runCommand({
      command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30',
      waitMsBeforeAsync: 150,
      sessionId: 's6',
      agentId: 's6',
    })
    manager.dispose()
    await sleep(1200) // let the child's close event land against disposed state
    if (manager.getTask(orphan.taskId)?.status !== undefined) {
      throw new Error('Test 6 failed: dispose must clear the task map')
    }
    if (hookCalls !== 1) {
      throw new Error(`Test 6 failed: dispose fired hooks (${hookCalls} total)`)
    }
    console.log('\u2714 Test 6 passed\n')

    console.log('\ud83c\udf89 All TaskManager tests passed.')
  } finally {
    manager.dispose()
    rmSync(taskDir, { recursive: true, force: true })
  }
}

runTests().catch((err) => {
  console.error('\u274c Test execution failed:', err)
  process.exit(1)
})
