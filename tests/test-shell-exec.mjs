/**
 * Regression suite for the seam-aligned background-tasks plugin: the pure
 * adaptation helpers in lib/shell-exec.js plus the fail-loud config resolver.
 * No host composition is required — every subject is a pure function.
 */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBackgroundTasksConfig, BACKGROUND_TASKS_DEFAULTS } from '../lib/config.js'
import { processOutcome, raceCompletion, renderProcessRead, resolveWorkdir } from '../lib/shell-exec.js'
import { codeFence } from '../lib/format.js'

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`FAIL - ${name}: ${err?.message ?? err}`)
  }
}

// --- resolveWorkdir --------------------------------------------------------

// Fixtures must be absolute ON THE RUNNING PLATFORM: drive-letter paths are
// not absolute on POSIX runners, so each platform gets its own spellings.
const winPaths = process.platform === 'win32'
const sessionCwd = winPaths ? 'D:\\session\\cwd' : '/tmp/session/cwd'
const policyRoot = winPaths ? 'D:\\policy\\root' : '/tmp/policy/root'
const relSub = winPaths ? 'sub\\dir' : 'sub/dir'
const elsewhere = winPaths ? 'C:\\elsewhere' : '/var/elsewhere'

await test('policy workspace root wins over session header cwd', () => {
  const workdir = resolveWorkdir(undefined, sessionCwd, policyRoot)
  assert.equal(workdir, policyRoot)
})

await test('header cwd applies when no policy root exists', () => {
  // canonicalPath resolves symlinks and 8.3 short names, so the expectation is
  // the canonical spelling of tmpdir, not the raw one.
  const canonicalTmp = realpathSync.native(tmpdir())
  const workdir = resolveWorkdir(undefined, canonicalTmp, undefined)
  assert.equal(workdir, canonicalTmp)
})

await test('relative model cwd resolves against the session identity', () => {
  const expected = join(policyRoot, relSub)
  const workdir = resolveWorkdir(relSub, sessionCwd, policyRoot)
  assert.ok(workdir?.endsWith(expected.slice(winPaths ? 2 : 0)) || workdir === expected, `got ${workdir}`)
})

await test('absolute model cwd wins unchanged', () => {
  const workdir = resolveWorkdir(elsewhere, sessionCwd, policyRoot)
  assert.equal(workdir, elsewhere)
})

await test('no identity at all leaves executor defaulting in charge', () => {
  assert.equal(resolveWorkdir(undefined, undefined, undefined), undefined)
})

// --- processOutcome --------------------------------------------------------

await test('settled process maps to completed with exit detail', () => {
  assert.deepEqual(
    processOutcome({ status: 'completed', exitCode: 3, signal: null }),
    { status: 'completed', detail: 'exit code: 3' },
  )
})

await test('zero exit reports exit code 0', () => {
  assert.deepEqual(
    processOutcome({ status: 'completed', exitCode: 0, signal: null }),
    { status: 'completed', detail: 'exit code: 0' },
  )
})

await test('killed by signal keeps killed with signal detail', () => {
  assert.deepEqual(
    processOutcome({ status: 'killed', exitCode: null, signal: 'SIGTERM' }),
    { status: 'killed', detail: 'signal: SIGTERM' },
  )
})

await test('killed without signal keeps killed without invented detail', () => {
  assert.deepEqual(
    processOutcome({ status: 'killed', exitCode: null, signal: null }),
    { status: 'killed', detail: 'killed before exit' },
  )
})

// --- renderProcessRead -----------------------------------------------------

await test('clean delta passes through untouched', () => {
  assert.equal(renderProcessRead({ delta: 'hello\n', lossy: false }, undefined), 'hello\n')
})

await test('lossy read gains spill notice', () => {
  const text = renderProcessRead(
    { delta: 'x', lossy: true, stdoutSpillPath: 'C:\\spill.out', stderrSpillPath: 'C:\\spill.err' },
    undefined,
  )
  assert.ok(text.includes('[output truncated; full streams: C:\\spill.out | C:\\spill.err]'))
})

await test('lossy read without retained spills says so', () => {
  const text = renderProcessRead({ delta: '', lossy: true }, undefined)
  assert.ok(text.includes('full streams not retained'))
})

await test('sandbox denial appends the shared marker', () => {
  const text = renderProcessRead({ delta: '', lossy: false }, { mode: 'workspace-write', denied: true })
  assert.ok(text.includes('[sandbox: file access denied under workspace-write mode]'))
})

await test('denial with advertised escalation surface gains the shared hint', () => {
  const text = renderProcessRead(
    { delta: '', lossy: false },
    { mode: 'workspace-write', denied: true },
    true,
  )
  assert.ok(text.includes('[sandbox: file access denied under workspace-write mode]'))
  assert.ok(text.includes('[sandbox: escalation available'), `missing escalation hint, got: ${text}`)
})

await test('denial without an escalation surface stays hint-free', () => {
  const text = renderProcessRead(
    { delta: '', lossy: false },
    { mode: 'workspace-write', denied: true },
    false,
  )
  assert.ok(!text.includes('escalation available'))
})

await test('non-denied sandbox facts add nothing', () => {
  const text = renderProcessRead({ delta: 'ok', lossy: false }, { mode: 'workspace-write', denied: false })
  assert.equal(text, 'ok')
})

await test('still-running read gains the pending hint', () => {
  const text = renderProcessRead({ delta: 'building…\n', lossy: false }, undefined, false, true)
  assert.ok(text.startsWith('building…\n'))
  assert.ok(text.includes('Job still in progress'), `missing hint, got: ${text}`)
  assert.ok(text.includes('end your turn'))
})

await test('settled read stays hint-free', () => {
  const text = renderProcessRead({ delta: 'done', lossy: false }, undefined, false, false)
  assert.equal(text, 'done')
})

await test('pending hint lands below denial markers', () => {
  const text = renderProcessRead(
    { delta: '', lossy: false },
    { mode: 'workspace-write', denied: true },
    true,
    true,
  )
  assert.ok(text.indexOf('escalation available') < text.indexOf('Job still in progress'))
})

// --- raceCompletion --------------------------------------------------------

await test('fast process settles as completed and clears the timer', async () => {
  const proc = { done: Promise.resolve() }
  assert.equal(await raceCompletion(proc, 5_000), 'completed')
})

await test('slow process is promoted when the window expires first', async () => {
  let neverSettle
  const proc = { done: new Promise((resolve) => { neverSettle = resolve }) }
  const winner = await raceCompletion(proc, 20)
  neverSettle()
  assert.equal(winner, 'promote')
})

await test('zero window promotes immediately even for instant commands', async () => {
  let settle
  const proc = { done: new Promise((resolve) => { settle = resolve }) }
  const race = raceCompletion(proc, 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  settle()
  assert.equal(await race, 'promote')
})

await test('caller abort inside the window promotes early', async () => {
  let settle
  const proc = { done: new Promise((resolve) => { settle = resolve }) }
  const controller = new AbortController()
  const startedAt = Date.now()
  const race = raceCompletion(proc, 60_000, controller.signal)
  setTimeout(() => controller.abort(), 15)
  const winner = await race
  settle()
  assert.equal(winner, 'promote')
  assert.ok(Date.now() - startedAt < 30_000, 'abort must end the wait far before the window')
})

await test('already-aborted signal promotes without waiting', async () => {
  let settle
  const proc = { done: new Promise((resolve) => { settle = resolve }) }
  const controller = new AbortController()
  controller.abort()
  assert.equal(await raceCompletion(proc, 60_000, controller.signal), 'promote')
  settle()
})

// --- config ----------------------------------------------------------------

await test('config defaults apply when fields are omitted', () => {
  assert.deepEqual(resolveBackgroundTasksConfig(), BACKGROUND_TASKS_DEFAULTS)
  assert.deepEqual(resolveBackgroundTasksConfig({}), { waitMsBeforeAsync: 10_000 })
})

await test('valid custom waitMsBeforeAsync is kept', () => {
  assert.deepEqual(resolveBackgroundTasksConfig({ waitMsBeforeAsync: 0 }), { waitMsBeforeAsync: 0 })
  assert.deepEqual(resolveBackgroundTasksConfig({ waitMsBeforeAsync: 60_000 }), { waitMsBeforeAsync: 60_000 })
})

await test('invalid waitMsBeforeAsync fails loud', () => {
  for (const bad of [-1, 1.5, '10000', null]) {
    assert.throws(() => resolveBackgroundTasksConfig({ waitMsBeforeAsync: bad }), TypeError)
  }
})

await test('non-object config root fails loud', () => {
  for (const bad of [null, 'x', 42, []]) {
    assert.throws(() => resolveBackgroundTasksConfig(bad), TypeError)
  }
})

// --- format ----------------------------------------------------------------

await test('codeFence escapes embedded triple backticks', () => {
  const fenced = codeFence('before\n```\ninside\n```')
  assert.ok(fenced.startsWith('````\n'), `fence should be 4 backticks, got ${fenced.slice(0, 8)}`)
  assert.ok(fenced.endsWith('\n````'))
})

await test('codeFence keeps the minimal fence for clean output', () => {
  assert.equal(codeFence('plain'), '```\nplain\n```')
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s), ${passed} passed`)
  process.exit(1)
}
console.log(`\nall ${passed} cases passed`)
