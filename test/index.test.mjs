import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { allowGuard } from '../lib/gate.js'

/**
 * `lib/index.js` is the DSH plugin entry, and it imports three packages the host
 * supplies at runtime (this repo installs none of them). They play no part in the
 * `agent/created` hook under test, so stand-ins let the real `apply` run and the
 * real hook fire. The hook itself, `installGate` and `isDelegatedChild` are the
 * production code; only the outer framework objects are fake.
 */
const dataUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source)

const STUBS = {
  '@deepseek-ai/schemastery': `
    function chain() {
      const node = {}
      node.default = () => chain()
      node.volatile = () => chain()
      node.min = () => chain()
      node.max = () => chain()
      node.step = () => chain()
      node.description = () => chain()
      node.describe = () => chain()
      return node
    }
    const z = {
      boolean: () => chain(),
      string: () => chain(),
      number: () => chain(),
      array: () => chain(),
      object: () => chain(),
    }
    export default z
  `,
  '@deepseek-ai/dsh-tools': `
    export function defineTool(spec) { return spec }
  `,
  zod: `
    const z = { object: () => ({ strict: () => ({}) }), enum: () => ({}), boolean: () => ({}) }
    export { z }
    export default z
  `,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier]
    if (stub !== undefined) return { url: dataUrl(stub), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

/**
 * Every tool a host could register: the file/search/shell/web tools a main agent must not
 * touch, the native delegation tools, an MCP tool, and the `run_code` transport. The gate
 * hides all of them except the ones the whitelist names (and never `run_code`, which
 * `tools.restrict` refuses).
 */
const HOST_TOOLS = [
  'apply_patch',
  'bash',
  'create_goal',
  'decompress',
  'edit',
  'glob',
  'grep',
  'list_agents',
  'mcp__demo__ping',
  'ops_bash',
  'ops_read_files',
  'pwsh',
  'ralph',
  'read',
  'read_image',
  'run_code',
  'schedule_create',
  'search_context',
  'subagent',
  'update_goal',
  'web_fetch',
  'web_search',
  'workflow',
  ...mod.DEFAULT_ALLOWED_TOOLS,
]

/**
 * What `tools.definitions(scope)` hands back before the plugin wraps it: every name the
 * scope can see, global and scope-local alike. `run_code` is left out on purpose — a host
 * in native mode never lists the PTC transport, so the default surface models that; a test
 * that needs the PTC shape adds it explicitly.
 */
const SURFACE_TOOLS = HOST_TOOLS.filter((name) => name !== 'run_code')

/** The names one `definitions()` result carries. */
const namesOf = (list) => list.map((definition) => definition.name)

/** A minimal ctx: only the members `apply` touches, each recording what it got.
 *  `enabled` and the live `allowedTools` are mutable so a test can flip the switch or the
 *  whitelist after installation, the way a panel write does.
 */
function fakeCtx({
  enabled = true,
  allowed,
  agents,
  sessions,
  stateOf,
  catalogNames = HOST_TOOLS,
  surface = SURFACE_TOOLS,
} = {}) {
  const state = { enabled, allowed }
  const projections = []
  const tools = []
  const handlers = new Map()
  // The options each subscription was made with: a lifecycle edge of a child is dispatched
  // with the child's parent as carrier, so the retry listener has to be registered global.
  const handlerOptions = new Map()
  const effects = []
  const logs = { info: [], warn: [] }
  const emitted = []
  // The live tool catalog the plugin publishes, as a writable volatile reference.
  let catalog = []
  const catalogRef = {
    get: () => catalog,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      catalog = next
    },
  }
  const ctx = {
    sessionProjections: {
      register: (projection) => projections.push(projection),
      stateOf,
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
      // The context-global view the catalog reads: names plus an empty visible map.
      view: () => ({ knownNames: new Set(catalogNames), visible: new Map() }),
      // The one exit a model request is built from. `apply` wraps it, so a test reads back
      // exactly the declarations a main agent or a child would be offered.
      definitions: () => surface.map((name) => ({ name })),
    },
    subagents: {},
    agents: agents ?? { get: () => undefined },
    sessions: sessions ?? { get: () => undefined, flush: async () => true },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    // The command channel: the client's mode switch writes through it, so tests read back
    // exactly the handler a web client would invoke.
    injected: [],
    inject(services, callback) {
      const registered = []
      const commandCtx = { commands: { register: (definition) => registered.push(definition) } }
      ctx.injected.push({ services, callback, registered })
      callback(commandCtx)
      return () => {}
    },
    on(event, handler, options) {
      handlers.set(event, handler)
      handlerOptions.set(event, options)
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    emit: (event, ...args) => emitted.push([event, ...args]),
  }
  const config = {
    enabled: { get: () => state.enabled },
    allowedTools: { get: () => state.allowed },
    workerProvider: { get: () => '' },
    workerModel: { get: () => '' },
    workerReasoningEffort: { get: () => '' },
    superviseEnabled: { get: () => true },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => 3 },
    superviseUnlimited: { get: () => false },
    superviseNotifyOnNoProgress: { get: () => false },
    toolCatalog: catalogRef,
  }
  return {
    ctx,
    config,
    state,
    projections,
    tools,
    handlers,
    handlerOptions,
    effects,
    logs,
    emitted,
    catalogNames,
    catalog: () => catalog,
    // The Loader commits a volatile field from the profile's raw value on every settings
    // write, which for an unset key means the empty array. Tests replay that.
    resetCatalog: () => {
      catalog = []
    },
  }
}

/**
 * A stand-in agent with its own tool registry. `restrict` only records calls — the plugin
 * is expected never to make one, which is what keeps `tools/change` quiet — and `guard`
 * hands back a disposer so the agent/disposed path is observable.
 */
function fakeAgent({ id = 'agent-1', depth, header = {} } = {}) {
  const restricted = []
  const guards = []
  const registered = []
  // One session object per agent: the dispatch mode is keyed by it, so two agents in one test
  // are two conversations that must never share a mode.
  const session = {
    header,
    log: [],
    append(type, data) {
      const event = { type, seq: this.log.length, time: 0, data }
      this.log.push(event)
      return event
    },
  }
  const agent = {
    id,
    options: { provider: 'p', model: 'm', ...(depth === undefined ? {} : { subagentDepth: depth }) },
    session,
    ctx: {
      tools: {
        restrict({ deny }) {
          restricted.push(deny[0])
          return () => {}
        },
        guard(fn) {
          guards.push(fn)
          let live = true
          return () => {
            if (!live) return
            live = false
            const at = guards.indexOf(fn)
            if (at !== -1) guards.splice(at, 1)
          }
        },
        register(tool) {
          registered.push(tool)
          return () => {}
        },
      },
    },
  }
  return { agent, restricted, guards, registered }
}

/** Start the plugin and hand back its `agent/created` handler. */
function start(options) {
  const harness = fakeCtx(options)
  mod.apply(harness.ctx, harness.config)
  const created = harness.handlers.get('agent/created')
  assert.equal(typeof created, 'function', 'apply must subscribe to agent/created')
  return { ...harness, created }
}

test('a child with a persisted delegation depth is never gated', () => {
  // Regression: a cold-resumed child was gated as a main agent, losing every working
  // tool and keeping only delegate/orchestrate. Its depth lives in the session header.
  for (const { agent, restricted, guards } of [
    fakeAgent({ header: { delegationDepth: 1 } }),
    fakeAgent({ header: {}, depth: 1 }),
  ]) {
    const { created, ctx } = start()
    created({ agent, source: 'resume' })
    assert.deepEqual(restricted, [], 'a child triggers no restriction at all')
    assert.equal(guards.length, 0, 'no guard may be registered for a child')
    assert.equal(namesOf(ctx.tools.definitions(agent)).includes('read'), true, 'the child keeps its working tools')
  }
})

test('a delegated child loses the delegation tools and keeps the native ones', () => {
  // Workers inherit the global table, so the surface drops the plugin's own pair — their
  // descriptions are written for a planner. The host's `subagent`, `workflow` and every
  // scope-local `ops_*` tool stay untouched: nothing is restricted.
  const { created, ctx } = start()
  const { agent, restricted, registered } = fakeAgent({ header: { delegationDepth: 1 } })
  created({ agent, source: 'resume' })
  const names = namesOf(ctx.tools.definitions(agent))
  assert.deepEqual(restricted, [], 'a child is masked by the surface, not by restrict')
  assert.deepEqual(registered, [], 'a child gets no scoped tool registration')
  assert.equal(names.includes('delegate'), false)
  assert.equal(names.includes('orchestrate'), false)
  for (const name of ['subagent', 'workflow', 'ops_bash', 'ops_read_files', 'read', 'edit']) {
    assert.equal(names.includes(name), true, name)
  }
})

test('a child is masked on its very first request, and no restriction is ever installed', () => {
  // The surface derives the deny list from the scope, so the first `preStep` assembly of a
  // new worker already lacks the pair: no window, no `tools/change`, no cache churn.
  const { created, ctx } = start()
  const { agent, restricted } = fakeAgent({ depth: 1 })
  created({ agent, source: 'create' })
  assert.equal(namesOf(ctx.tools.definitions(agent)).includes('delegate'), false)
  assert.equal(namesOf(ctx.tools.definitions(agent)).includes('orchestrate'), false)
  assert.deepEqual(restricted, [])
})

test('a main agent gets the full rule and no scoped registration', () => {
  const { created, tools } = start()
  const { agent, registered } = fakeAgent()
  created({ agent, source: 'create' })
  assert.deepEqual(registered, [], 'the global pair is enough for a main agent')
  const delegate = tools.find((tool) => tool.name === 'delegate')
  const orchestrate = tools.find((tool) => tool.name === 'orchestrate')
  assert.match(delegate.description, /主代理规则：主代理只负责规划/)
  // The rule is rendered once: the batch brief only points back at it.
  assert.match(orchestrate.description, /^主代理规则同 delegate/)
  assert.equal(orchestrate.description.includes('主代理可用工具'), false)
  assert.equal(orchestrate.description.includes('【插件重试｜子代理 <id>】'), false)
})

test('apply registers the subagent-management tool exactly once', () => {
  const { tools } = start()
  const registered = tools.map((tool) => tool.name)
  assert.deepEqual(registered, ['delegate', 'orchestrate', 'orchestrator_agents'])
  const admin = tools.find((tool) => tool.name === 'orchestrator_agents')
  assert.deepEqual(admin.parameters.action.enum, ['list', 'status', 'send', 'interrupt'])
  // The name must not collide with the host tools it replaces.
  for (const name of ['send_message', 'interrupt_agent', 'list_agents']) {
    assert.notEqual(admin.name, name)
  }
})

test('the delegation rule points the model at orchestrator_agents, not the host tools', () => {
  // The failure this prevents: a model that tried `send_message`, saw it refused or
  // shadowed, and re-dispatched the whole task instead of messaging the live child.
  const { tools } = start()
  const delegate = tools.find((tool) => tool.name === 'delegate')
  assert.match(delegate.description, /用 orchestrator_agents 管理它/)
  assert.match(delegate.description, /不要用 send_message \/ interrupt_agent 管理子代理/)
  assert.match(delegate.description, /不要因为 send_message 失败就重派子代理/)
  assert.match(delegate.description, /taskKey/)
  assert.match(delegate.description, /writeScope/)
})

test('a panel write reaches the next request without a re-mask or a new registration', () => {
  const { created, ctx, state, tools } = start()
  const delegated = tools.length
  const main = fakeAgent()
  created({ agent: main.agent, source: 'create' })
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.deepEqual(main.restricted, [], 'the surface needs no restriction')

  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), true)
  state.allowed = mod.DEFAULT_ALLOWED_TOOLS
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), false)
  assert.equal(tools.length, delegated, 'a whitelist change registers nothing')
  assert.deepEqual(main.restricted, [], 'and still restricts nothing')
})

test('a main agent is guarded, and the surface carries only the shipped whitelist', () => {
  const { created, ctx } = start()
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  // No mask any more: every name the whitelist leaves out is filtered at definitions(),
  // own-scope tools such as `ops_bash` and the native `subagent` included.
  assert.deepEqual(restricted, [])
  assert.equal(guards.length, 1)
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), mod.DEFAULT_ALLOWED_TOOLS)
  for (const name of ['read', 'edit', 'ops_bash', 'ops_read_files', 'subagent', 'workflow']) {
    assert.equal(namesOf(ctx.tools.definitions(agent)).includes(name), false, name)
  }
  for (const name of mod.DEFAULT_ALLOWED_TOOLS) assert.equal(guards[0]({ name }), undefined, name)
  assert.match(guards[0]({ name: 'edit' }), /"edit" is not available to the main agent/)
  assert.match(guards[0]({ name: 'subagent' }), /"subagent" is not available to the main agent/)
})

test('the shipped whitelist is twelve planning tools, and every other name is refused', () => {
  // The main agent keeps the delegation tools, the session read-only tools and `compress`:
  // the capabilities that make planning and review possible without touching the repo.
  const shipped = mod.DEFAULT_ALLOWED_TOOLS
  // 11 since `orchestrator_agents` replaced the host's `send_message`/`interrupt_agent` pair.
  assert.equal(shipped.length, 11)
  // The host's own per-agent tools are no longer in the default: `orchestrator_agents` is the
  // single supported route, and keeping both invited a target-id shadowing conflict.
  for (const name of ['send_message', 'interrupt_agent']) {
    assert.equal(shipped.includes(name), false, name)
    assert.match(allowGuard(shipped)({ name }), /is not available to the main agent/, name)
  }
  for (const name of [
    'delegate',
    'orchestrate',
    'orchestrator_agents',
    'todo_write',
    'ask_user_question',
    'compress',
    'session_search',
    'session_trace',
    'session_event_search',
    'session_event_read',
    'session_event_trace',
  ]) {
    assert.equal(shipped.includes(name), true, name)
    assert.equal(allowGuard(shipped)({ name }), undefined, name)
  }
  for (const name of [
    'read',
    'edit',
    'write',
    'apply_patch',
    'grep',
    'glob',
    'bash',
    'pwsh',
    'ops_bash',
    'web_fetch',
    'web_search',
    'subagent',
    'workflow',
    'ralph',
    'decompress',
    'search_context',
    'acp_status',
    'mcp_custom_tool',
  ]) {
    assert.equal(shipped.includes(name), false, name)
    assert.match(allowGuard(shipped)({ name }), /is not available to the main agent/, name)
  }

  const { created, ctx } = start()
  const { agent, guards } = fakeAgent()
  created({ agent, source: 'create' })
  const names = namesOf(ctx.tools.definitions(agent))
  assert.equal(names.includes('compress'), true, 'compress is whitelisted, so it stays declared')
  assert.equal(guards[0]({ name: 'compress' }), undefined, 'compress must pass the guard')
  for (const name of ['ops_bash', 'read', 'decompress']) {
    assert.match(guards[0]({ name }), /is not available to the main agent/, name)
  }
  assert.equal(guards[0]({ name: 'delegate' }), undefined)
})

test('a resumed agent with a parentSession but no depth is gated and warns', () => {
  const { created, ctx, logs } = start()
  const { agent, restricted, guards } = fakeAgent({ id: 'cold-child', header: { parentSession: 'root-session' } })
  created({ agent, source: 'resume' })
  assert.deepEqual(restricted, [], 'the surface replaces the old mask entirely')
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.equal(guards.length, 1)
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /cold-child/)
  assert.match(logs.warn[0], /parentSession but no delegation depth/)
  // The warning must not leak the conversation itself.
  assert.equal(logs.warn[0].includes('root-session'), false)
})

test('the warning fires only for a resume that fell through the depth test', () => {
  // A normal creation is not a resume, and a resumed child does have a depth.
  const fresh = start()
  fresh.created({ agent: fakeAgent({ header: { parentSession: 'root' } }).agent, source: 'create' })
  assert.equal(fresh.logs.warn.length, 0)

  const resumedChild = start()
  resumedChild.created({ agent: fakeAgent({ header: { parentSession: 'root', delegationDepth: 1 } }).agent, source: 'resume' })
  assert.equal(resumedChild.logs.warn.length, 0)
})

test('the switch being off still installs the guard and hands the host surface back intact', async () => {
  // The gate is installed even while dispatch mode is off, so flipping the switch on
  // in an open conversation takes effect without a restart; the info log follows the switch.
  const { created, ctx, state, logs } = start({ enabled: false })
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  assert.deepEqual(restricted, [])
  assert.equal(guards.length, 1)
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), SURFACE_TOOLS, 'off means host behaviour')
  assert.equal(logs.info.length, 0)
  assert.equal(logs.warn.length, 0)

  // Turning it on filters the next request even though nothing was re-installed. The mode is
  // written through the session's own log, exactly as the client switch does.
  const command = ctx.injected.find((entry) => entry.services.includes('commands')).registered[0]
  const outcome = await command.handler({ agent, rawInput: 'on' })
  assert.equal(outcome.kind, 'success')
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.deepEqual(restricted, [], 'still no restriction')
})

test('a whitelist written in the panel reaches an open conversation, live', () => {
  // The whitelist is read per call, so a panel write lands in a conversation that was
  // already open: checking `read` lets it through at once, unchecking `delegate` blocks it.
  const { created, state } = start()
  const { agent, guards } = fakeAgent()
  created({ agent, source: 'create' })
  assert.match(guards[0]({ name: 'read' }), /not available to the main agent/)
  assert.equal(guards[0]({ name: 'delegate' }), undefined)

  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(guards[0]({ name: 'read' }), undefined)

  state.allowed = mod.DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'delegate')
  assert.match(guards[0]({ name: 'delegate' }), /"delegate" is not available to the main agent/)
  assert.equal(guards[0]({ name: 'orchestrate' }), undefined)

  // Unchecking every box disables every tool: an empty whitelist is not "use the default".
  state.allowed = []
  for (const name of ['delegate', 'orchestrate', 'compress', 'read']) {
    assert.match(guards[0]({ name }), /is not available to the main agent/, name)
  }
})

test('the whitelist clause follows the live config without re-registering', () => {
  // The description is a getter, so the same registered tool renders the new list: a
  // settings change reaches the prompt without a restart or a new session. The clause is
  // rendered by `delegate` only — `orchestrate` points at it instead of repeating it.
  const { tools, state } = start()
  const delegate = tools.find((tool) => tool.name === 'delegate')
  const orchestrate = tools.find((tool) => tool.name === 'orchestrate')
  const allowedOf = (tool) =>
    /主代理可用工具（白名单驱动，其余全部禁用）: ([^。]+)。/.exec(tool.description)?.[1]
  assert.equal(allowedOf(delegate), mod.DEFAULT_ALLOWED_TOOLS.join(', '))
  assert.equal(allowedOf(orchestrate), undefined)

  state.allowed = ['delegate', 'orchestrate', 'read']
  assert.equal(allowedOf(delegate), 'delegate, orchestrate, read')
  assert.equal(orchestrate.description.includes('read'), false)

  // The rule has a second sentence for the case where the panel unchecks everything.
  state.allowed = []
  assert.match(delegate.description, /当前主代理无可用工具（白名单为空）。/)
  assert.equal(allowedOf(delegate), undefined)
})
/** Only the members supervision adapters use, with recording friendly defaults. */
function fakeSupervisionHost({ parents = new Map(), sessions = new Map(), stateOf, flush } = {}) {
  const logs = []
  const ctx = {
    agents: { get: (id) => parents.get(id) },
    sessions: {
      get: (id) => sessions.get(id),
      flush: flush ?? (async () => true),
    },
    sessionProjections: { stateOf },
    logger: { warn: (message) => logs.push(message) },
  }
  return { ctx, logs, parents, sessions }
}

test('apply installs a 5000 ms supervision timer and clears it when the effect unloads', () => {
  const timers = []
  const cleared = []
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unref() {} }
    timers.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => cleared.push(handle)
  try {
    const harness = start()
    // The scan period is fixed: a tick only compares clocks unless a child is due.
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 5000)
    const timerEffect = harness.effects.find(({ label }) => label === 'orchestrator: supervision timer')
    assert.ok(timerEffect, 'the timer must be owned by an effect')
    timerEffect.dispose()
    assert.deepEqual(cleared, [timers[0]])
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
})

test('onStarted tracks the child and forgets it once the receipt settles', async () => {
  const tracked = []
  const forgotten = []
  const hooks = mod.createSupervisionHooks({
    track: (entry) => tracked.push(entry),
    forget: (childId) => forgotten.push(childId),
  })

  const result = Promise.resolve('done')
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.equal(tracked.length, 1)
  assert.equal(tracked[0].childId, 'child-1')
  assert.equal(tracked[0].parentId, 'parent-1')
  assert.equal(tracked[0].label, '慢活')
  assert.ok(tracked[0].startedAt > 0)
  await result
  await Promise.resolve()
  assert.deepEqual(forgotten, ['child-1'])

  // A rejected receipt is handled silently, never as an unhandled rejection.
  const failed = Promise.reject(new Error('boom'))
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-2', result: failed }, { description: '失败' })
  await failed.catch(() => {})
  await Promise.resolve()
  assert.deepEqual(forgotten, ['child-1', 'child-2'])
})

/** The supervisor surface the hooks touch, with real add/remove semantics. */
function recordingSupervisor() {
  const entries = new Map()
  const tracked = []
  return {
    entries,
    tracked,
    track: (entry) => {
      tracked.push(entry)
      entries.set(entry.childId, entry)
    },
    forget: (childId) => entries.delete(childId),
    has: (childId) => entries.has(childId),
  }
}

test('a cold-resumed worker is tracked again with the log head as its baseline', async () => {
  // Regression: interrupt settles the receipt, the receipt forgets the child, and the
  // send_message cold resume created it again without registering it — supervision was
  // silently lost for the rest of that worker's life.
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: (childId) => (childId === 'child-1' ? 42 : 0) })
  let settle
  const result = new Promise((resolve) => {
    settle = resolve
  })
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.equal(registry.entries.size, 1)

  settle('done')
  await result
  await Promise.resolve()
  assert.equal(registry.entries.size, 0, 'the settled receipt releases the child')

  hooks.onResumed({ id: 'child-1', session: { header: { parentSession: 'parent-1', delegationDepth: 1 } } })
  const entry = registry.entries.get('child-1')
  assert.ok(entry, 'the resumed worker must be supervised again')
  assert.equal(entry.parentId, 'parent-1', 'the dispatch record names the real parent')
  assert.equal(entry.label, '慢活', 'the task description survives the interrupt')
  assert.equal(entry.resumed, true)
  assert.equal(entry.sinceSeq, 42, 'pre-interrupt history is not reported as new')
  assert.ok(entry.startedAt > 0)
})

test('a resumed agent this plugin never dispatched stays unsupervised', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 7 })
  // The host's own subagent tool also creates delegated children; they never entered
  // supervision, so a resume of one must not start a notice timer on it.
  hooks.onResumed({ id: 'host-child', session: { header: { parentSession: 'parent-1', delegationDepth: 1 } } })
  assert.equal(registry.entries.size, 0)
  assert.equal(registry.tracked.length, 0)
})

test('a repeated resume event does not restart the clock', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 5 })
  hooks.onStarted({ id: 'p' }, { childId: 'c', result: null }, { description: 'job' })
  registry.forget('c')
  hooks.onResumed({ id: 'c' })
  const first = registry.entries.get('c')
  const count = registry.tracked.length

  hooks.onResumed({ id: 'c' })
  assert.equal(registry.tracked.length, count, 'no second registration')
  assert.equal(registry.entries.get('c'), first, 'the deadline and budget are untouched')
})

test('an unreadable log head falls back to the zero baseline and still tracks', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, {
    headSeq: () => {
      throw new Error('session log unavailable')
    },
  })
  hooks.onStarted({ id: 'p' }, { childId: 'c', result: null }, { description: 'job' })
  registry.forget('c')
  assert.doesNotThrow(() => hooks.onResumed({ id: 'c' }))
  assert.equal(registry.entries.get('c').sinceSeq, 0)
})

test('the dispatch memory is bounded, so a very old worker is not re-armed', async () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 0 })
  const total = 129
  for (let index = 0; index < total; index += 1) {
    hooks.onStarted({ id: 'p' }, { childId: `child-${index}`, result: null }, { description: 'job' })
  }
  // Every registration is released, as a batch of finished receipts would leave them.
  registry.entries.clear()
  // The oldest dispatch record is evicted; the newest is still remembered.
  hooks.onResumed({ id: 'child-0' })
  assert.equal(registry.entries.has('child-0'), false)
  hooks.onResumed({ id: `child-${total - 1}` })
  assert.equal(registry.entries.has(`child-${total - 1}`), true)
})

test('headSeq reads the highest seq in the child log, and 0 when it cannot', () => {
  const parent = { id: 'p', session: { id: 's' } }
  const child = { id: 'c', log: [{ seq: 3, type: 'x' }, { seq: 9, type: 'y' }, { type: 'no-seq' }] }
  const host = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    sessions: new Map([['c', child]]),
  })
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {} })
  assert.equal(supervision.headSeq('c'), 9)
  // The baseline is a cold-resume detail; an unreadable log must never throw into the hook.
  assert.equal(supervision.headSeq('gone'), 0)
  assert.doesNotThrow(() => supervision.headSeq(undefined))
})

test('hasPendingNotice recognises its own source and tolerates a broken projection', () => {
  const parent = { id: 'p', session: { id: 's' } }
  const broken = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  const first = mod.createSupervision({ ctx: broken.ctx, config: {} })
  // The inbox state shape is not a public API: a failure is false, not a throw.
  assert.equal(first.hasPendingNotice('p'), false)
  assert.equal(first.hasPendingNotice('p'), false)
  assert.equal(broken.logs.filter((message) => /cannot read the parent inbox/.test(message)).length, 1)

  const good = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    stateOf: () => ({ 'next-turn': [{ source: { kind: mod.SUPERVISE_SOURCE_KIND } }], 'next-step': [] }),
  })
  const second = mod.createSupervision({ ctx: good.ctx, config: {} })
  assert.equal(second.hasPendingNotice('p'), true)

  const unrelated = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    stateOf: () => ({ 'next-turn': [{ source: { kind: 'schedule' } }], 'next-step': [] }),
  })
  assert.equal(mod.createSupervision({ ctx: unrelated.ctx, config: {} }).hasPendingNotice('p'), false)
})

test('deliver refuses an unknown parent and degrades safely when the llm import fails', async () => {
  const unknown = fakeSupervisionHost()
  const missing = mod.createSupervision({ ctx: unknown.ctx, config: {} })
  assert.equal(await missing.deliver('gone', 'text', ['child']), 'parent-gone')

  const parent = { id: 'p', session: {}, followup() {} }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  let loads = 0
  const broken = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => {
      loads += 1
      throw new Error('package unavailable')
    },
  })
  // A missing host package must not throw, must not be retried every tick, and must
  // not consume the child's notice budget (the supervisor warns and reschedules).
  assert.equal(await broken.deliver('p', 'text', ['child']), 'unavailable')
  assert.equal(await broken.deliver('p', 'text', ['child']), 'unavailable')
  assert.equal(loads, 1)
  assert.equal(host.logs.filter((message) => /cannot load @deepseek-ai\/dsh-llm/.test(message)).length, 1)
})

test('deliver queues exactly one notice with followup, never steer', async () => {
  const calls = { followup: [], steer: 0, flush: [] }
  const parent = {
    id: 'p',
    session: { id: 'parent-session' },
    followup: (message) => calls.followup.push(message),
    steer: () => {
      calls.steer += 1
    },
  }
  const host = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    flush: async (session) => {
      calls.flush.push(session)
      return true
    },
  })
  const { deliver } = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  assert.equal(await deliver('p', '巡检正文', ['child-1', 'child-2']), 'queued')
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.steer, 0)
  assert.equal(calls.followup[0].content[0].text, '巡检正文')
  assert.deepEqual(calls.followup[0].source, {
    kind: mod.SUPERVISE_SOURCE_KIND,
    form: 'notice',
    senderSessionId: 'child-1',
  })
  assert.equal(calls.flush.length, 1)
})

test('liveConfig reads superviseUnlimited on every tick, so the panel switch applies at once', async () => {
  const state = { unlimited: false, max: 0 }
  const config = {
    superviseEnabled: { get: () => true },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => state.max },
    superviseNotifyOnNoProgress: { get: () => false },
    superviseUnlimited: { get: () => state.unlimited },
  }
  const queued = []
  const parent = { id: 'p', session: { id: 'parent-session' }, followup: (message) => queued.push(message) }
  const child = { id: 'child-1', log: [] }
  const host = fakeSupervisionHost({
    parents: new Map([
      ['p', parent],
      ['child-1', child],
    ]),
    sessions: new Map([['child-1', child]]),
  })
  const supervision = mod.createSupervision({
    ctx: host.ctx,
    config,
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  const base = Date.now()
  supervision.supervisor.track({
    childId: 'child-1',
    parentId: 'p',
    label: '慢活',
    startedAt: base - 11 * 60_000,
  })

  // A zero budget with the unlimited switch off is "supervision off": nothing is sent,
  // but the running child stays registered.
  await supervision.supervisor.tick(base)
  assert.equal(queued.length, 0)
  assert.equal(supervision.supervisor.size(), 1)

  // Flipping the switch on the live config is enough: no rebuild, no re-dispatch.
  state.unlimited = true
  await supervision.supervisor.tick(base + 600_000)
  assert.equal(queued.length, 1)
  assert.match(queued[0].content[0].text, /第 1 次/)
  assert.equal(queued[0].content[0].text.includes('/0'), false)

  // Turning it back off restores the numeric budget, which is already spent.
  state.unlimited = false
  state.max = 1
  await supervision.supervisor.tick(base + 1_200_000)
  assert.equal(queued.length, 1)
  assert.equal(supervision.supervisor.size(), 1)
})

test('a panel write reaches every live main agent on its next request, not by re-masking', () => {
  const main = fakeAgent()
  const child = fakeAgent({ id: 'child-1', depth: 1 })
  const { created, ctx, state } = start({
    agents: { get: () => undefined, roots: () => [main.agent, child.agent] },
  })
  created({ agent: main.agent, source: 'create' })
  created({ agent: child.agent, source: 'create' })
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), false)
  assert.equal(
    namesOf(ctx.tools.definitions(child.agent)).includes('read'),
    true,
    'a child keeps its working tools',
  )

  // The panel checks `read`: allowedTools gains it and the next request sees it, live.
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), true)
  assert.equal(
    namesOf(ctx.tools.definitions(main.agent)).includes('ops_bash'),
    false,
    'every other name stays out',
  )
  assert.equal(
    namesOf(ctx.tools.definitions(child.agent)).includes('delegate'),
    false,
    'the child deny list never moves',
  )

  state.allowed = mod.DEFAULT_ALLOWED_TOOLS
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), false)
  assert.deepEqual(main.restricted, [], 'no restriction was ever installed')
  assert.deepEqual(child.restricted, [])
})

test('the enable switch flips the surface in the open session through the same live read', async () => {
  const main = fakeAgent()
  const { created, ctx, handlers } = start({
    agents: { get: () => undefined, roots: () => [main.agent] },
  })
  created({ agent: main.agent, source: 'create' })
  const volatile = handlers.get('loader/volatile-update')
  assert.equal(typeof volatile, 'function', 'apply must subscribe to loader/volatile-update')
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)

  const command = ctx.injected.find((entry) => entry.services.includes('commands')).registered[0]
  await command.handler({ agent: main.agent, rawInput: 'off' })
  volatile()
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), SURFACE_TOOLS, 'off hands the host table back')
  assert.equal(main.guards[0]({ name: 'edit' }), undefined, 'and lets every call through')

  await command.handler({ agent: main.agent, rawInput: 'on' })
  volatile()
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.match(main.guards[0]({ name: 'edit' }), /not available to the main agent/)
})

test('a disposed agent drops its guard, and a later write reinstalls nothing', () => {
  const main = fakeAgent()
  const roots = [main.agent]
  const { created, handlers, state } = start({ agents: { get: () => undefined, roots: () => roots } })
  created({ agent: main.agent, source: 'create' })
  const volatile = handlers.get('loader/volatile-update')
  const disposed = handlers.get('agent/disposed')
  assert.equal(typeof disposed, 'function', 'apply must subscribe to agent/disposed')
  assert.equal(main.guards.length, 1)
  assert.deepEqual(main.restricted, [])

  disposed({ agent: main.agent })
  assert.equal(main.guards.length, 0, 'the guard is unregistered with the agent')

  // A later write with the agent gone has nothing to reinstall, and must not throw.
  roots.length = 0
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.doesNotThrow(() => volatile())
  assert.deepEqual(main.restricted, [])
})

test('an agent created before the plugin mounted is already covered by the surface', () => {
  // The wrapper reads the scope, not a registry of hooked agents: a missed creation hook
  // only means no guard for that agent, never an unfiltered request.
  const preExisting = fakeAgent({ id: 'pre-existing' })
  const { ctx, state } = start()
  assert.deepEqual(namesOf(ctx.tools.definitions(preExisting.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(namesOf(ctx.tools.definitions(preExisting.agent)).includes('read'), true)
})

test('a volatile write is never fatal, with or without a usable registry', () => {
  const { handlers } = start()
  const volatile = handlers.get('loader/volatile-update')
  assert.doesNotThrow(() => volatile())

  const broken = start({
    agents: {
      get: () => undefined,
      roots: () => {
        throw new Error('registry gone')
      },
    },
  })
  assert.doesNotThrow(() => broken.handlers.get('loader/volatile-update')())
})

test('the surface is owned by one effect and hands the host method back on dispose', () => {
  const harness = start()
  const installed = harness.effects.find(({ label }) => label === 'orchestrator: tool surface')
  assert.equal(typeof installed?.dispose, 'function', 'apply must own the wrapper through an effect')
  const main = fakeAgent()
  assert.deepEqual(namesOf(harness.ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  installed.dispose()
  assert.deepEqual(namesOf(harness.ctx.tools.definitions(main.agent)), SURFACE_TOOLS)
})

// ---- Automatic retry of a child that died without a closing message ---------------------

test('onStarted hands the dispatched child to the retry policy, and only for a real dispatch', () => {
  const tracked = []
  const retry = {
    track: (childId, record) => {
      tracked.push({ childId, ...record })
      return true
    },
  }
  const hooks = mod.createSupervisionHooks({ track() {}, forget() {} }, { retry })
  const result = Promise.resolve('done')
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.deepEqual(tracked, [{ childId: 'child-1', parentId: 'parent-1', label: '慢活' }])
  // An event without the two ids is not a dispatch: nothing can be retried later.
  hooks.onStarted({}, { childId: 'child-2', result })
  hooks.onStarted({ id: 'parent-1' }, { result })
  assert.equal(tracked.length, 1)
})

test('a retry bookkeeping failure never breaks the dispatch', () => {
  const tracked = []
  const hooks = mod.createSupervisionHooks(
    { track: (entry) => tracked.push(entry), forget() {} },
    {
      retry: {
        track: () => {
          throw new Error('the policy is broken')
        },
      },
    },
  )
  assert.doesNotThrow(() => hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1' }, {}))
  assert.equal(tracked.length, 1)
})

test('apply listens for the settlement edge globally, so a child-scoped emission reaches it', () => {
  const harness = start()
  const listener = harness.handlers.get('subagent/end')
  assert.equal(typeof listener, 'function', 'apply must subscribe to subagent/end')
  // The host dispatches this edge with the child's parent as carrier: a scoped listener is
  // filtered out, so the option is what makes the retry possible at all.
  assert.deepEqual(harness.handlerOptions.get('subagent/end'), { global: true })
  // A malformed event is ignored rather than thrown into the emitter.
  assert.doesNotThrow(() => listener(undefined))
  assert.doesNotThrow(() => listener({ id: '' }))
})

test('the retry prompt goes through the host protocol entry, as a queued turn of the child', async () => {
  const calls = []
  const parent = { id: 'parent-1' }
  const deliverPrompt = mod.deliverRetryPrompt
  const host = {
    agents: { get: (id) => (id === 'parent-1' ? parent : undefined) },
    subagents: {
      [Symbol.for('dsh.subagent.deliverPrompt')]: async (...args) => {
        calls.push(args)
        return true
      },
    },
  }
  assert.equal(await deliverPrompt(host, 'parent-1', 'child-1', '继续'), true)
  assert.equal(calls.length, 1)
  const [sender, childId, content, source, signal, delivery] = calls[0]
  assert.equal(sender, parent, 'the live parent is the sender the host requires')
  assert.equal(childId, 'child-1')
  assert.deepEqual(content, [{ type: 'text', text: '继续' }])
  assert.deepEqual(source, { kind: 'orchestrator-retry', form: 'notice' })
  assert.equal(delivery, 'queue', 'a retry is a new turn, not a steer into a dead one')
  assert.equal(typeof signal?.aborted, 'boolean')
})

test('the retry prompt refuses a host without the entry, and a parent that is gone', async () => {
  const parent = { id: 'parent-1' }
  await assert.rejects(
    mod.deliverRetryPrompt({ agents: { get: () => parent }, subagents: {} }, 'parent-1', 'child-1', '继续'),
    /does not expose dsh\.subagent\.deliverPrompt/,
  )
  const withEntry = {
    agents: { get: () => undefined },
    subagents: { [Symbol.for('dsh.subagent.deliverPrompt')]: async () => true },
  }
  await assert.rejects(mod.deliverRetryPrompt(withEntry, 'parent-1', 'child-1', '继续'), /is not live/)
})

test('the retry notice has its own source kind, so it cannot mask a supervision notice', async () => {
  const queued = []
  const parent = { id: 'p', session: { id: 'parent-session' }, followup: (message) => queued.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  const supervision = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  assert.equal(await supervision.deliverRetry('p', '重试正文', ['child-1']), 'queued')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].content[0].text, '重试正文')
  assert.deepEqual(queued[0].source, { kind: 'orchestrator-retry', form: 'notice', senderSessionId: 'child-1' })
  // The supervision notice keeps the kind `hasPendingNotice` looks for.
  assert.equal(await supervision.deliver('p', '巡检正文', ['child-1']), 'queued')
  assert.deepEqual(queued[1].source, { kind: mod.SUPERVISE_SOURCE_KIND, form: 'notice', senderSessionId: 'child-1' })
})

// ---- Live tool catalog -----------------------------------------------------------------

test('the plugin publishes the tool catalog at start and refreshes it on tools/change', async () => {
  const harness = start({ catalogNames: ['read', 'delegate'] })
  const change = harness.handlers.get('tools/change')
  assert.equal(typeof change, 'function', 'apply must subscribe to tools/change')
  // The first read runs during apply, so a panel opened before any change has a catalog.
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])
  assert.deepEqual(harness.emitted[0], ['settings/document-updated', 'orchestrator', 1])
  assert.equal(harness.logs.warn.length, 0)

  // An unchanged burst publishes nothing: no write, no announcement and no gate refresh.
  change()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(harness.emitted.length, 1)

  // A plugin registering a tool moves the catalog, with no plugin reload and no restart.
  harness.catalogNames.push('mcp__demo__ping')
  change()
  change()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(harness.catalog(), ['delegate', 'mcp__demo__ping', 'read'])
  assert.equal(harness.emitted.length, 2)
  assert.deepEqual(harness.emitted[1], ['settings/document-updated', 'orchestrator', 2])
})

test('the write that empties the published catalog repairs it in the same event', () => {
  // A volatile field is re-committed from the profile's raw value on every settings write,
  // so a panel write lands with toolCatalog already empty. The write has announced
  // loader/volatile-update by then, so the repair rides that event: no timer, no polling.
  const harness = start({ catalogNames: ['read', 'delegate'] })
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])

  harness.resetCatalog()
  assert.deepEqual(harness.catalog(), [], 'the loader wiped the field')
  harness.handlers.get('loader/volatile-update')()
  assert.deepEqual(harness.catalog(), ['delegate', 'read'], 'the catalog is back before the write returns')

  // The repair is not a one-off: every write repeats the same commit.
  harness.resetCatalog()
  const announced = harness.emitted.length
  harness.handlers.get('loader/volatile-update')()
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])
  // The repair is quiet on purpose: the settings write that carries this event has already
  // invalidated the client's document, so announcing the catalog again would make every open
  // panel re-read every namespace — the second half of the one-second lag a checkbox had.
  assert.equal(harness.emitted.length, announced, 'a repair never announces a second refresh')
})

test('the published catalog includes tools a scope registers for a root agent', async () => {
  const scoped = {
    id: 'root',
    ctx: { tools: { view: () => ({ knownNames: new Set(['subagent']), visible: new Map() }) } },
  }
  const harness = start({
    catalogNames: ['read'],
    agents: { get: () => undefined, roots: () => [scoped] },
  })
  assert.deepEqual(harness.catalog(), ['read', 'subagent'])
})

/**
 * Cross-session isolation. The regression this feature exists for: session A runs with
 * dispatch mode on, session B toggles its own mode, and A's next request and tool calls must
 * be unchanged. Every assertion below drives two real session objects through the same plugin
 * instance, so a shared flag anywhere in the read path would fail here.
 */
test('two conversations keep independent dispatch modes, in both directions', async () => {
  const a = fakeAgent({ id: 'session-a' })
  const b = fakeAgent({ id: 'session-b' })
  const { ctx, created } = start({ agents: { get: () => undefined, roots: () => [a.agent, b.agent] } })
  created({ agent: a.agent, source: 'create' })
  created({ agent: b.agent, source: 'create' })
  const command = ctx.injected.find((entry) => entry.services.includes('commands')).registered[0]

  // A is in dispatch mode, B is not. A's table is the whitelist, B's is the host's.
  await command.handler({ agent: a.agent, rawInput: 'on' })
  await command.handler({ agent: b.agent, rawInput: 'off' })
  assert.deepEqual(namesOf(ctx.tools.definitions(a.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.deepEqual(namesOf(ctx.tools.definitions(b.agent)), SURFACE_TOOLS)

  // B turning its own mode on must not change A... (A is already on, so compare against B).
  await command.handler({ agent: b.agent, rawInput: 'on' })
  assert.deepEqual(namesOf(ctx.tools.definitions(a.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.deepEqual(namesOf(ctx.tools.definitions(b.agent)), mod.DEFAULT_ALLOWED_TOOLS)

  // ...and B turning it back off must not switch A off either.
  await command.handler({ agent: b.agent, rawInput: 'off' })
  assert.deepEqual(namesOf(ctx.tools.definitions(a.agent)), mod.DEFAULT_ALLOWED_TOOLS, 'A is untouched by B turning off')
  assert.deepEqual(namesOf(ctx.tools.definitions(b.agent)), SURFACE_TOOLS, 'only B went back to the host table')
  assert.match(a.guards[0]({ name: 'edit', agent: a.agent }), /not available to the main agent/)
  assert.equal(b.guards[0]({ name: 'edit', agent: b.agent }), undefined, 'B lets the call through')

  // The mirror direction: A going off leaves B untouched when B is on.
  await command.handler({ agent: b.agent, rawInput: 'on' })
  await command.handler({ agent: a.agent, rawInput: 'off' })
  assert.deepEqual(namesOf(ctx.tools.definitions(b.agent)), mod.DEFAULT_ALLOWED_TOOLS, 'B stays on when A turns off')
  assert.deepEqual(namesOf(ctx.tools.definitions(a.agent)), SURFACE_TOOLS)
})

test('the guard resolves the mode from the session that is executing, not the gate owner', async () => {
  // A guard is installed per top-level agent, but a host may report the executing agent on
  // the call. When it does, that session decides; the gate must not fall back to its owner.
  const a = fakeAgent({ id: 'session-a' })
  const b = fakeAgent({ id: 'session-b' })
  const { ctx, created } = start({ agents: { get: () => undefined, roots: () => [a.agent, b.agent] } })
  created({ agent: a.agent, source: 'create' })
  created({ agent: b.agent, source: 'create' })
  const command = ctx.injected.find((entry) => entry.services.includes('commands')).registered[0]
  await command.handler({ agent: a.agent, rawInput: 'on' })
  await command.handler({ agent: b.agent, rawInput: 'off' })

  const guard = a.guards[0]
  assert.equal(guard({ name: 'edit', agent: b.agent }), undefined, 'B is off, so B may edit')
  assert.match(guard({ name: 'edit', agent: a.agent }), /not available to the main agent/)
  // A call with no agent on it falls back to the gate's own conversation.
  assert.match(guard({ name: 'edit' }), /not available to the main agent/)
})

test('a mode change is recorded in the session log, so resume can replay it', async () => {
  const a = fakeAgent({ id: 'session-a' })
  const { ctx, created } = start({ agents: { get: () => undefined, roots: () => [a.agent] } })
  created({ agent: a.agent, source: 'create' })
  const command = ctx.injected.find((entry) => entry.services.includes('commands')).registered[0]
  await command.handler({ agent: a.agent, rawInput: 'on' })
  await command.handler({ agent: a.agent, rawInput: 'off' })

  const records = a.agent.session.log.filter((event) => event.type === 'plugin:dsh-orchestrator/dispatch-mode')
  assert.deepEqual(records.map((event) => event.data), [{ enabled: true }, { enabled: false }])
  // The type follows the host's plugin-record grammar, which is what makes it persistable.
  for (const record of records) assert.match(record.type, /^plugin:[a-z0-9][a-z0-9._-]*/)
})

test('the switch with no argument flips this session, and reads only this session', async () => {
  const a = fakeAgent({ id: 'session-a' })
  const { ctx, created } = start({ agents: { get: () => undefined, roots: () => [a.agent] } })
  created({ agent: a.agent, source: 'create' })
  const command = ctx.injected.find((entry) => entry.services.includes('commands')).registered[0]
  // The default is on, so a bare flip turns it off, and the next flip turns it back on.
  assert.equal((await command.handler({ agent: a.agent, rawInput: '' })).kind, 'success')
  assert.deepEqual(namesOf(ctx.tools.definitions(a.agent)), SURFACE_TOOLS)
  await command.handler({ agent: a.agent, rawInput: '' })
  assert.deepEqual(namesOf(ctx.tools.definitions(a.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  // A session with no agent is refused instead of writing somewhere global.
  assert.equal((await command.handler({ agent: undefined, rawInput: 'on' })).kind, 'error')
})

test('a session that cannot record its mode still switches for the live process', async () => {
  // A host whose session log refuses the record must not leave the switch dead: the in-memory
  // copy keeps the live process consistent, and the failure is reported once.
  const a = fakeAgent({ id: 'session-a' })
  a.agent.session.append = () => {
    throw new Error('log closed')
  }
  const { ctx, created, logs } = start({ agents: { get: () => undefined, roots: () => [a.agent] } })
  created({ agent: a.agent, source: 'create' })
  const command = ctx.injected.find((entry) => entry.services.includes('commands')).registered[0]
  await command.handler({ agent: a.agent, rawInput: 'off' })
  assert.deepEqual(namesOf(ctx.tools.definitions(a.agent)), SURFACE_TOOLS, 'the switch still took effect')
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /applies to this process only/)
})

