/**
 * Integration regression for the `run_command` orchestration layer: drives the
 * compiled lib/tools.js through a hand-built fake composition (shell, jobs,
 * shellEnv, approval fakes) and asserts the full execute() behavior — path
 * selection driven by the DEPLOYMENT wait window (the model has no timing
 * parameter), job registration shape, workdir/policy stamping, the escalation
 * flow through the REAL approveEscalation code, and fail-loud branches.
 *
 * Note: defineTool normalizes the per-property parameter dialect into
 * `{ type, properties, required }`, so parameter assertions read
 * `def.parameters.properties.<name>`.
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import { registerBackgroundTools } from '../lib/tools.js'

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

// --- fakes -----------------------------------------------------------------

/** Process handle fake; settle()/kill() resolve `done` exactly like the seam promises. */
function makeProc({ output = '', exitCode = null, status = null, signal = null, sandbox } = {}) {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const proc = {
    status: 'running',
    exitCode,
    signal,
    sandbox,
    done,
    readOutput() { return { delta: output, lossy: false } },
    kill() {
      if (proc.status !== 'running') return false
      proc.status = 'killed'
      resolveDone()
      return true
    },
    /** Settle as a finished command (test driver only). */
    settle() {
      proc.status = status ?? 'completed'
      resolveDone()
    },
  }
  return proc
}

function makeShell(nextProc) {
  const started = []
  const resolvedSpecs = []
  return {
    started,
    resolvedSpecs,
    resolve(request) {
      const spec = { ...request }
      resolvedSpecs.push(spec)
      return spec
    },
    start() {
      const proc = nextProc()
      started.push(proc)
      return proc
    },
  }
}

function makeJobs() {
  const started = []
  return {
    started,
    start(spec) {
      const hooks = spec.run()
      const id = `command-${started.length + 1}`
      started.push({ id, spec, hooks })
      return id
    },
  }
}

function makeCtx({ shell, jobs = makeJobs(), shellEnv, approval } = {}) {
  const registered = []
  const warnings = []
  // `null` means "service deliberately absent" (destructuring defaults would
  // resurrect makeJobs() on an explicit undefined).
  const services = { jobs, shellEnv, approval }
  const ctx = {
    shell,
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    get(name) {
      const value = services[name]
      return value === null ? undefined : value
    },
    logger() {
      return { info() {}, warn(msg) { warnings.push(String(msg)) }, error() {} }
    },
  }
  return { ctx, registered, warnings }
}

function makeExec() {
  const controller = new AbortController()
  return {
    controller,
    exec: {
      agent: { id: 'sess-A', session: { header: { cwd: 'D:\\DEEPSEEK' } } },
      callId: 'call-1',
      signal: controller.signal,
    },
  }
}

const NO_POLICY_SEAM = { escalationModes: [], resolveSandboxPolicy: () => undefined }

function confiningSeam(mode = 'workspace-write', root = 'D:\\DEEPSEEK') {
  return {
    escalationModes: ['workspace-write', 'danger-full-access'],
    resolveSandboxPolicy: () => ({ mode, workspaceRoot: root }),
  }
}

const SYNC_WINDOW_CONFIG = { waitMsBeforeAsync: 10_000 }

// --- parameter surface -------------------------------------------------------

await test('model-facing schema has NO timing parameter (window is deployment-owned)', () => {
  const { ctx, registered } = makeCtx({ shell: makeShell(() => makeProc()) })
  registerBackgroundTools(ctx, SYNC_WINDOW_CONFIG, confiningSeam())
  const props = registered.at(-1).parameters.properties
  assert.equal(props.wait_ms, undefined)
  assert.equal(props.run_in_background, undefined)
})

await test('confining composition advertises the escalation pair', () => {
  const { ctx, registered } = makeCtx({ shell: makeShell(() => makeProc()) })
  registerBackgroundTools(ctx, SYNC_WINDOW_CONFIG, confiningSeam())
  const props = registered.at(-1).parameters.properties
  assert.ok(props.sandbox_permissions !== undefined)
  assert.ok(props.justification !== undefined)
})

await test('non-confining composition hides the escalation pair', () => {
  const { ctx, registered } = makeCtx({ shell: makeShell(() => makeProc()) })
  registerBackgroundTools(ctx, SYNC_WINDOW_CONFIG, NO_POLICY_SEAM)
  const props = registered.at(-1).parameters.properties
  assert.equal(props.sandbox_permissions, undefined)
  assert.equal(props.justification, undefined)
})

// --- synchronous path --------------------------------------------------------

await test('fast command returns synchronously without touching ctx.jobs', async () => {
  const shell = makeShell(() => {
    const proc = makeProc({ output: 'hello world', exitCode: 0 })
    proc.settle()
    return proc
  })
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, SYNC_WINDOW_CONFIG, NO_POLICY_SEAM)
  const tool = registered.at(-1)
  const { exec } = makeExec()
  const out = await tool.execute({ command: 'echo hello' }, exec)
  assert.ok(out.includes('Command finished (exit code 0)'), out)
  assert.ok(out.includes('hello world'))
  assert.equal(ctx.get('jobs').started.length, 0)
  assert.equal(shell.started.length, 1)
})

await test('denied sync output carries denial marker and hint when advertised', async () => {
  const shell = makeShell(() => {
    const proc = makeProc({
      output: '',
      exitCode: 1,
      sandbox: { mode: 'workspace-write', denied: true },
    })
    proc.settle()
    return proc
  })
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, SYNC_WINDOW_CONFIG, confiningSeam())
  const tool = registered.at(-1)
  const { exec } = makeExec()
  const out = await tool.execute({ command: 'touch elsewhere' }, exec)
  assert.ok(out.includes('[sandbox: file access denied under workspace-write mode]'))
  assert.ok(out.includes('[sandbox: escalation available'), out)
})

// --- promotion paths ---------------------------------------------------------

await test('wait-window expiry promotes into ctx.jobs with owner and kind', async () => {
  const shell = makeShell(() => makeProc()) // never settles
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, NO_POLICY_SEAM)
  const tool = registered.at(-1)
  const { exec } = makeExec()
  const out = await tool.execute({ command: 'long-build', description: 'build it' }, exec)
  assert.ok(out.includes('[Command moved to background]'), out)
  assert.ok(out.includes('JobId: command-1'), out)
  const job = ctx.get('jobs').started[0]
  assert.equal(job.spec.kind, 'command')
  assert.equal(job.spec.owner, exec.agent)
  assert.equal(job.spec.label, 'build it')
  // The cancel hook must terminate the underlying process.
  assert.equal(shell.started[0].status, 'running')
  job.hooks.cancel('test')
  assert.equal(shell.started[0].status, 'killed')
})

await test('caller abort inside the window promotes early instead of waiting out', async () => {
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 60_000 }, NO_POLICY_SEAM)
  const tool = registered.at(-1)
  const { exec, controller } = makeExec()
  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 15)
  const out = await tool.execute({ command: 'endless' }, exec)
  assert.ok(Date.now() - startedAt < 30_000, 'abort must cut the window short')
  assert.ok(out.includes('[Command moved to background]'), out)
})

// --- request stamping --------------------------------------------------------

await test('policy workspace root wins as default workdir and rides the spec', async () => {
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, confiningSeam('workspace-write', 'D:\\DEEPSEEK'))
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await tool.execute({ command: 'pwd' }, exec)
  const spec = shell.resolvedSpecs.at(-1)
  assert.equal(spec.workdir, 'D:\\DEEPSEEK')
  assert.equal(spec.sandboxPolicy.mode, 'workspace-write')
  assert.equal(spec.sandboxPolicy.workspaceRoot, 'D:\\DEEPSEEK')
})

await test('relative cwd resolves against the policy root; absolute wins', async () => {
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, confiningSeam('workspace-write', tmpdir()))
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await tool.execute({ command: 'x', cwd: 'sub' }, exec)
  const relative = shell.resolvedSpecs.at(-1).workdir
  assert.ok(isAbsolute(relative))
  assert.ok(relative.startsWith(tmpdir()))
  await tool.execute({ command: 'x', cwd: process.platform === 'win32' ? 'C:\\elsewhere' : '/var/elsewhere' }, exec)
  assert.equal(shell.resolvedSpecs.at(-1).workdir, process.platform === 'win32' ? 'C:\\elsewhere' : '/var/elsewhere')
})

await test('header cwd applies when no policy exists', async () => {
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, NO_POLICY_SEAM)
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await tool.execute({ command: 'x' }, exec)
  // canonicalPath resolves symlinks; a missing path passes through unchanged.
  const workdir = shell.resolvedSpecs.at(-1).workdir
  assert.ok(workdir === 'D:\\DEEPSEEK' || isAbsolute(workdir), `got ${workdir}`)
  assert.equal(shell.resolvedSpecs.at(-1).sandboxPolicy, undefined)
})

await test('managed DSH_* environment is collected per call when composed', async () => {
  const collected = { DSH_SESSION_ID: 'sess-A' }
  const shellEnv = { collect: () => collected }
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell, shellEnv })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, NO_POLICY_SEAM)
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await tool.execute({ command: 'x' }, exec)
  assert.equal(shell.resolvedSpecs.at(-1).dshEnv, collected)
})

// --- escalation flow (real approveEscalation code) ---------------------------

await test('approved escalation stamps the widened mode onto this call', async () => {
  const asks = []
  const approval = { request: async (req) => { asks.push(req); return 'allowed-once' } }
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell, approval })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, confiningSeam('workspace-write', 'D:\\DEEPSEEK'))
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await tool.execute(
    { command: 'x', sandbox_permissions: 'danger-full-access', justification: 'need one write outside workspace' },
    exec,
  )
  assert.equal(asks.length, 1)
  assert.equal(asks[0].toolName, 'run_command')
  assert.equal(asks[0].agent, exec.agent)
  const spec = shell.resolvedSpecs.at(-1)
  assert.equal(spec.sandboxPolicy.mode, 'danger-full-access')
})

await test('rejected escalation throws and nothing executes', async () => {
  const approval = { request: async () => 'rejected' }
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell, approval })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, confiningSeam('workspace-write', 'D:\\DEEPSEEK'))
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await assert.rejects(
    tool.execute(
      { command: 'x', sandbox_permissions: 'danger-full-access', justification: 'why not' },
      exec,
    ),
    /rejected escalating/,
  )
  assert.equal(shell.started.length, 0)
})

await test('non-widening escalation fails closed before any ask', async () => {
  const asks = []
  const approval = { request: async (req) => { asks.push(req); return 'allowed-once' } }
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell, approval })
  registerBackgroundTools(ctx, { waitMsBeforeAsync: 25 }, confiningSeam('danger-full-access', 'D:\\DEEPSEEK'))
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await assert.rejects(
    tool.execute(
      { command: 'x', sandbox_permissions: 'danger-full-access', justification: 'same mode' },
      exec,
    ),
    /not strictly wider/,
  )
  assert.equal(asks.length, 0)
})

// --- fail-loud branches ------------------------------------------------------

await test('missing ctx.jobs fails loudly with remediation text', async () => {
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell, jobs: null })
  registerBackgroundTools(ctx, SYNC_WINDOW_CONFIG, NO_POLICY_SEAM)
  const tool = registered.at(-1)
  const { exec } = makeExec()
  await assert.rejects(
    tool.execute({ command: 'anything' }, exec),
    /ctx\.jobs is not composed/,
  )
})

await test('aborted tool call refuses to start anything', async () => {
  const shell = makeShell(() => makeProc())
  const { ctx, registered } = makeCtx({ shell })
  registerBackgroundTools(ctx, SYNC_WINDOW_CONFIG, NO_POLICY_SEAM)
  const tool = registered.at(-1)
  const { exec, controller } = makeExec()
  controller.abort()
  await assert.rejects(tool.execute({ command: 'x' }, exec), (err) => err.name === 'AbortError')
  assert.equal(shell.started.length, 0)
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s), ${passed} passed`)
  process.exit(1)
}
console.log(`\nall ${passed} cases passed`)
