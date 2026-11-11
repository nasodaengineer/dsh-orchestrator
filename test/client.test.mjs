import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// A tiny hook runtime for one self-contained component: rendering is synchronous, state
// setters re-render, and effects run after each commit. Components render as plain trees.
let hookOwner = null

function sameDeps(a, b) {
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((dep, i) => Object.is(dep, b[i]))
}

function useState(initial) {
  if (hookOwner === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.states)) owner.states[index] = typeof initial === 'function' ? initial() : initial
  return [
    owner.states[index],
    (next) => {
      const value = typeof next === 'function' ? next(owner.states[index]) : next
      if (Object.is(value, owner.states[index])) return
      owner.states[index] = value
      owner.dirty = true
      if (!owner.rendering) owner.render()
    },
  ]
}

function useReducer(reducer, initial) {
  if (hookOwner === null) return [initial, () => {}]
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.states)) owner.states[index] = initial
  return [
    owner.states[index],
    (action) => {
      const value = reducer(owner.states[index], action)
      if (Object.is(value, owner.states[index])) return
      owner.states[index] = value
      owner.dirty = true
      if (!owner.rendering) owner.render()
    },
  ]
}

function useRef(initial) {
  if (hookOwner === null) return { current: initial }
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.refs)) owner.refs[index] = { current: initial }
  return owner.refs[index]
}

const React = {
  useState,
  useReducer,
  useRef,
  useEffect: (fn, deps) => {
    if (hookOwner !== null) hookOwner.effects.push({ fn, deps })
  },
  createElement: (type, props, ...kids) => ({ type, props, kids }),
}

// The host loader registers `react-dom` beside `react`. Portals come back as ordinary nodes, so
// the same tree walker sees the list that landed in the body.
const portals = []
const ReactDOM = {
  createPortal: (node, target) => {
    portals.push({ node, target })
    return { type: 'portal', props: { target }, kids: [node] }
  },
}

/** Render a component with the hook runtime above; effects are committed after each pass. */
function mount(component, props) {
  const owner = { states: [], refs: [], effects: [], committed: [], index: 0, dirty: false, rendering: false, tree: null }
  const commitEffects = () => {
    const previous = owner.committed
    const next = owner.effects
    for (let i = 0; i < next.length; i += 1) {
      const old = previous[i]
      if (old !== undefined && sameDeps(old.deps, next[i].deps)) {
        next[i].cleanup = old.cleanup
        continue
      }
      if (typeof old?.cleanup === 'function') old.cleanup()
      const cleanup = next[i].fn()
      next[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    for (let i = next.length; i < previous.length; i += 1) {
      if (typeof previous[i]?.cleanup === 'function') previous[i].cleanup()
    }
    owner.committed = next
  }
  const render = () => {
    if (owner.rendering) {
      owner.dirty = true
      return owner.tree
    }
    owner.rendering = true
    try {
      for (let pass = 0; pass < 100; pass += 1) {
        owner.index = 0
        owner.dirty = false
        owner.effects = []
        hookOwner = owner
        try {
          owner.tree = component(props)
        } finally {
          hookOwner = null
        }
        commitEffects()
        if (!owner.dirty) break
      }
    } finally {
      owner.rendering = false
    }
    return owner.tree
  }
  owner.render = render
  render()
  return {
    get tree() {
      return owner.tree
    },
    unmount() {
      for (const effect of owner.committed) {
        if (typeof effect?.cleanup === 'function') effect.cleanup()
      }
    },
  }
}

/** Every host element in a rendered tree. */
function nodes(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, out)
    return out
  }
  out.push(tree)
  for (const child of tree.kids ?? []) nodes(child, out)
  return out
}

function mountField(scope) {
  const view = mount(mod.__test.SuperviseIntervalField, { scope, t })
  return {
    view,
    input: () => nodes(view.tree).find((node) => node.type === 'input'),
    alert: () => nodes(view.tree).find((node) => node.props?.role === 'alert'),
  }
}

let mod
const timers = []
// A stand-in browser: the row measures its own box and the window height before it opens
// the model list, and listens for scroll and resize while it is open.
const fakeWindow = {
  __ModuleLoader__: {
    load: (def) => {
      mod = def.factory((id) => {
        if (id === 'react') return React
        if (id === 'react-dom') return ReactDOM
        throw new Error('unexpected require ' + id)
      })
    },
  },
  innerHeight: 900,
  listeners: [],
  addEventListener(type) {
    fakeWindow.listeners.push(type)
  },
  removeEventListener(type) {
    fakeWindow.listeners = fakeWindow.listeners.filter((entry) => entry !== type)
  },
}
// The portalled list needs a body to mount into, and the row's outside-click test registers a
// capture listener on the document: record both so tests can drive them.
const fakeDocument = {
  body: { nodeName: 'BODY' },
  listeners: [],
  addEventListener(type, fn, capture) {
    fakeDocument.listeners.push({ type, fn, capture })
  },
  removeEventListener(type, fn) {
    fakeDocument.listeners = fakeDocument.listeners.filter((entry) => entry.fn !== fn)
  },
}
/** Deliver one pointerdown to every live document listener. */
const pointerDown = (target) => {
  for (const entry of [...fakeDocument.listeners]) entry.fn({ target })
}
vm.runInNewContext(src, {
  window: fakeWindow,
  document: fakeDocument,
  // The field schedules its transient warning; tests drive the timer by hand.
  setTimeout: (fn, ms) => {
    const timer = { fn, ms }
    timers.push(timer)
    return timer
  },
  clearTimeout: () => {},
})
const T = mod.__test
const t = (k) => k
// Values built inside the vm context have another Object.prototype; compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v))

test('route keys round-trip, including ids with slashes, and reject junk', () => {
  const key = T.routeKey('nexus-claude', 'claude/opus:5.5')
  assert.deepEqual(plain(T.parseRouteKey(key)), { provider: 'nexus-claude', model: 'claude/opus:5.5' })
  assert.equal(T.parseRouteKey('not json'), undefined)
  assert.equal(T.parseRouteKey('[1,2]'), undefined)
  assert.equal(T.parseRouteKey('{}'), undefined)
})

test('routeOf reads the two stored shapes and treats missing fields as empty', () => {
  assert.deepEqual(plain(T.routeOf(T.MAIN.fields, { provider: 'p', model: 'm', reasoningEffort: 'high' })), {
    provider: 'p',
    model: 'm',
    effort: 'high',
  })
  assert.deepEqual(plain(T.routeOf(T.WORKER.fields, { workerProvider: 'w', workerModel: 'x' })), {
    provider: 'w',
    model: 'x',
    effort: '',
  })
  assert.deepEqual(plain(T.routeOf(T.MAIN.fields, undefined)), { provider: '', model: '', effort: '' })
})

test('routeOps sets provider and model, and sets or unsets the effort', () => {
  assert.deepEqual(plain(T.routeOps(T.WORKER.fields, { provider: 'p', model: 'm', effort: 'high' })), [
    { op: 'set', path: ['workerProvider'], value: 'p' },
    { op: 'set', path: ['workerModel'], value: 'm' },
    { op: 'set', path: ['workerReasoningEffort'], value: 'high' },
  ])
  const cleared = T.routeOps(T.MAIN.fields, { provider: 'p', model: 'm', effort: '' })
  assert.deepEqual(plain(cleared[2]), { op: 'unset', path: ['reasoningEffort'] })
})

test('findModel matches provider and model together', () => {
  const groups = [
    { id: 'a', models: [{ id: 'x' }] },
    { id: 'b', models: [{ id: 'x', reasoning: { efforts: [] } }] },
  ]
  assert.equal(T.findModel(groups, { provider: 'b', model: 'x' }), groups[1].models[0])
  assert.equal(T.findModel(groups, { provider: 'a', model: 'nope' }), undefined)
  assert.equal(T.findModel(groups, { provider: 'zzz', model: 'x' }), undefined)
})

/** A fake config scope that applies set/unset ops to a plain object. */
function fakeScope({ writable = true, status = 'ready', reject, drop, inherited = {}, initial = {} } = {}) {
  let revision = 1
  let value = { ...initial }
  const calls = []
  const listeners = new Set()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    calls,
    // `unset` only removes the user's override, so an inherited layer shows through again.
    getSnapshot: () => ({ status, writable, revision, value: { ...inherited, ...value } }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops, expected) => {
      calls.push({ ops, expected })
      if (reject) throw new Error(reject)
      const next = { ...value }
      for (const op of ops) {
        const key = op.path[0]
        if (drop === key) continue
        if (op.op === 'set') next[key] = op.value
        else delete next[key]
      }
      value = next
      revision += 1
      notify()
    },
    /** Simulate the same field changing elsewhere: another panel, the config file, the host. */
    externalSet: (patch) => {
      value = { ...value, ...patch }
      revision += 1
      notify()
    },
  }
}

test('saveRoute writes with the snapshot revision and reports success', async () => {
  const scope = fakeScope()
  const failure = await T.saveRoute(scope, T.WORKER.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  assert.equal(failure, null)
  assert.equal(scope.calls[0].expected, 1)
  assert.deepEqual(plain(T.routeOf(T.WORKER.fields, scope.getSnapshot().value)), { provider: 'p', model: 'm', effort: 'high' })
})

test('saveRoute clears a stored effort when the new choice is the model default', async () => {
  const scope = fakeScope()
  await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  const failure = await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t)
  assert.equal(failure, null)
  assert.equal('reasoningEffort' in scope.getSnapshot().value, false)
})

test('clearing the subagent effort must beat the value the plugin bundle ships with', async () => {
  // The bundled patch ships workerReasoningEffort: high. Unsetting the override would
  // reveal that again, so the effort has to be stored as an explicit empty string.
  const scope = fakeScope({ inherited: { workerReasoningEffort: 'high' } })
  const failure = await T.saveRoute(scope, T.WORKER.fields, { provider: 'p', model: 'm', effort: '' }, t)
  assert.equal(failure, null)
  assert.equal(plain(scope.getSnapshot().value).workerReasoningEffort, '')
})

test('clearing the main agent effort removes the override, since that field has no empty value', async () => {
  const scope = fakeScope()
  await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  assert.equal(await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), null)
  assert.equal('reasoningEffort' in plain(scope.getSnapshot().value), false)
})

test('saveRoute refuses an unwritable or unready scope without calling mutate', async () => {
  for (const scope of [fakeScope({ writable: false }), fakeScope({ status: 'loading' })]) {
    assert.equal(await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), 'route.readonly')
    assert.equal(scope.calls.length, 0)
  }
})

test('saveRoute surfaces a rejected write and a write that did not land', async () => {
  const rejected = fakeScope({ reject: 'settings changed since it was read' })
  assert.match(await T.saveRoute(rejected, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), /settings changed/)
  const dropped = fakeScope({ drop: 'model' })
  assert.equal(await T.saveRoute(dropped, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), 'route.saveFailed')
})

test('apply targets each session with a complete dispatch-mode command', async () => {
  const regs = []
  const commands = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {} },
    configForms: { get: (ns) => ({ ns }) },
    remote: {
      commands: { execute: async (...args) => { commands.push(args); return { ok: true, value: 'handled' } } },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    },
    slots: { inject: (_n, cb) => cb(), register: (opts, comp) => regs.push({ opts, comp }) },
  }
  mod.apply(ctx)
  assert.deepEqual(regs.map((r) => [r.opts.name, r.opts.id, r.opts.order]), [
    ['conversation.input.left', 'orchestrator-plan-toggle', 20],
    ['conversation.input.right', 'orchestrator-route-picker', 11],
  ])
  const propsA = regs[1].opts.inject('session-a')
  const propsB = regs[1].opts.inject('session-b')
  assert.deepEqual([propsA.scopes.main.ns, propsA.scopes.worker.ns, propsA.scopes.orch.ns], ['agent-default-model', 'orchestrator', 'orchestrator'])
  assert.equal(propsA.setPlan, undefined)
  await propsA.setMode(true)
  await propsB.setMode(false)
  assert.deepEqual(plain(commands), [
    ['session-a', '/orchestrator-mode on', []],
    ['session-b', '/orchestrator-mode off', []],
  ])
  assert.deepEqual(plain(mod.inject), ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'configForms'])
})

test('filterGroups matches provider names wholesale and model ids or names otherwise', () => {
  const groups = [
    {
      id: 'nexus-deepseek',
      name: 'Nexus DeepSeek',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'Flash' },
        { id: 'deepseek-v4.1-pro', name: 'Pro' },
      ],
    },
    { id: 'nexus-claude', name: 'Nexus Claude', models: [{ id: 'claude/opus:5.5', name: 'Opus 5.5' }] },
  ]
  assert.equal(plain(T.filterGroups(groups, '   ')).length, 2)
  // A provider hit keeps every model that provider offers.
  const byProvider = plain(T.filterGroups(groups, 'claude'))
  assert.deepEqual(byProvider.map((g) => g.id), ['nexus-claude'])
  assert.equal(byProvider[0].models.length, 1)
  // A model hit keeps only the matching models and drops providers left empty.
  const byModel = plain(T.filterGroups(groups, 'PRO'))
  assert.deepEqual(byModel.map((g) => g.id), ['nexus-deepseek'])
  assert.deepEqual(byModel[0].models.map((m) => m.id), ['deepseek-v4.1-pro'])
  // Display names count too, and nothing matching is an empty catalog, not the full one.
  assert.deepEqual(plain(T.filterGroups(groups, 'opus')).map((g) => g.id), ['nexus-claude'])
  assert.deepEqual(plain(T.filterGroups(groups, 'zzz')), [])
})


test('countModels sums the models each provider offers', () => {
  assert.equal(T.countModels([]), 0)
  assert.equal(T.countModels([{ models: [{ id: 'a' }, { id: 'b' }] }, { models: [{ id: 'c' }] }]), 3)
})

test('the supervision interval field shows the stored value, or 600 when it is absent or malformed', () => {
  const cases = [
    [{}, '600'],
    [{ superviseIntervalSeconds: 1200 }, '1200'],
    [{ superviseIntervalSeconds: 0 }, '600'],
    [{ superviseIntervalSeconds: 'abc' }, '600'],
    [{ superviseIntervalSeconds: null }, '600'],
    [{ superviseIntervalSeconds: 12.5 }, '600'],
  ]
  for (const [initial, shown] of cases) {
    const field = mountField(fakeScope({ initial }))
    const input = field.input()
    assert.equal(input.props.value, shown)
    // Text plus a numeric keypad keeps "abc" observable; a number input would blank it.
    assert.equal(input.props.type, 'text')
    assert.equal(input.props.inputMode, 'numeric')
    assert.equal(input.props.min, 10)
    assert.equal(input.props.max, 86400)
    assert.equal(input.props.step, 1)
    assert.equal(input.props['aria-label'], 'supervise.label')
    field.view.unmount()
  }
})

test('invalid interval input is rejected, restored, and explained', async () => {
  for (const bad of ['9', '86401', '12.5', '1e3', 'abc']) {
    const scope = fakeScope({ initial: { superviseIntervalSeconds: 900 } })
    const field = mountField(scope)
    field.input().props.onChange({ target: { value: bad } })
    await field.input().props.onBlur()
    assert.equal(scope.calls.length, 0, bad)
    assert.equal(field.input().props.value, '900', bad)
    assert.equal(field.alert().kids[0], 'supervise.invalid', bad)
    field.view.unmount()
  }
})

test('a valid interval is written on blur with the snapshot revision', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: ' 900 ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 900 }])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(scope.getSnapshot().value.superviseIntervalSeconds, 900)
  assert.equal(field.input().props.value, '900')
  assert.equal(field.alert(), undefined)
})

test('Enter also commits a valid interval', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '1800' } })
  await field.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 1800 }])
})

test('an empty interval writes the 600 default, since a number field cannot clear to an empty string', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 1200 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '   ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 600 }])
  assert.equal(field.input().props.value, '600')
})

test('an unchanged interval does not mutate the config', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: ' 600 ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '600')
  assert.equal(field.alert(), undefined)
})

test('Escape abandons the edit and restores the stored interval', () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '9000' } })
  field.input().props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '600')
  assert.equal(field.alert(), undefined)
})

test('a rejected interval write is caught and shown without crashing', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read', initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '900' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.equal(field.alert().kids[0], 'supervise.saveFailed')
  assert.equal(field.input().props.value, '600')
})

test('the invalid-input hint disappears when its timer fires', async () => {
  const scope = fakeScope()
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '9' } })
  await field.input().props.onBlur()
  assert.ok(field.alert())
  const timer = timers[timers.length - 1]
  timer.fn()
  assert.equal(field.alert(), undefined)
})


test('the interval field follows a value changed elsewhere', () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  scope.externalSet({ superviseIntervalSeconds: 1200 })
  assert.equal(field.input().props.value, '1200')
})

// ---- The patrol notice count and the unlimited switch --------------------------------

function mountCountField(scope) {
  const view = mount(mod.__test.SuperviseCountField, { scope, t })
  return {
    view,
    input: () => nodes(view.tree).find((node) => node.type === 'input'),
    toggle: () => nodes(view.tree).find((node) => node.type === T.EnableSwitch),
    alert: () => nodes(view.tree).find((node) => node.props?.role === 'alert'),
  }
}

test('the patrol count field shows the stored value, or 3 when it is absent or malformed', () => {
  const cases = [
    [{}, '3'],
    [{ superviseMaxNoticesPerChild: 0 }, '0'],
    [{ superviseMaxNoticesPerChild: 1 }, '1'],
    [{ superviseMaxNoticesPerChild: 20 }, '20'],
    [{ superviseMaxNoticesPerChild: -1 }, '3'],
    [{ superviseMaxNoticesPerChild: 21 }, '3'],
    [{ superviseMaxNoticesPerChild: 12.5 }, '3'],
    [{ superviseMaxNoticesPerChild: '5' }, '3'],
    [{ superviseMaxNoticesPerChild: null }, '3'],
  ]
  for (const [initial, shown] of cases) {
    const field = mountCountField(fakeScope({ initial }))
    const input = field.input()
    assert.equal(input.props.value, shown, JSON.stringify(initial))
    // Text plus a numeric keypad keeps "abc" observable; a number input would blank it.
    assert.equal(input.props.type, 'text')
    assert.equal(input.props.inputMode, 'numeric')
    assert.equal(input.props.min, 0)
    assert.equal(input.props.max, 20)
    assert.equal(input.props.step, 1)
    assert.equal(input.props['aria-label'], 'supervise.countLabel')
    field.view.unmount()
  }
})

test('patrolCountOf and parsePatrolCount agree on the 0-20 range and the 3 default', () => {
  assert.equal(T.patrolCountOf(undefined), 3)
  assert.equal(T.patrolCountOf({ superviseMaxNoticesPerChild: 0 }), 0)
  assert.equal(T.patrolCountOf({ superviseMaxNoticesPerChild: 20 }), 20)
  assert.equal(T.patrolCountOf({ superviseMaxNoticesPerChild: 21 }), 3)
  assert.equal(T.patrolCountOf({ superviseMaxNoticesPerChild: -1 }), 3)
  assert.equal(T.patrolCountOf({ superviseMaxNoticesPerChild: 2.5 }), 3)
  assert.equal(T.patrolCountOf({ superviseMaxNoticesPerChild: '7' }), 3)
  assert.deepEqual(plain(T.parsePatrolCount('')), { ok: true, count: 3, empty: true })
  assert.deepEqual(plain(T.parsePatrolCount('   ')), { ok: true, count: 3, empty: true })
  assert.deepEqual(plain(T.parsePatrolCount(' 0 ')), { ok: true, count: 0, empty: false })
  assert.deepEqual(plain(T.parsePatrolCount('20')), { ok: true, count: 20, empty: false })
  for (const bad of ['-1', '21', 'abc', '1.5', '1e3', '+3']) {
    assert.deepEqual(plain(T.parsePatrolCount(bad)), { ok: false, empty: false }, bad)
  }
})

test('unlimitedOf only accepts a literal true', () => {
  assert.equal(T.unlimitedOf({ superviseUnlimited: true }), true)
  assert.equal(T.unlimitedOf({ superviseUnlimited: false }), false)
  assert.equal(T.unlimitedOf({ superviseUnlimited: 'true' }), false)
  assert.equal(T.unlimitedOf({}), false)
  assert.equal(T.unlimitedOf(undefined), false)
})

test('a valid patrol count, including 0, is written on blur with the snapshot revision', async () => {
  for (const [typed, stored] of [
    ['0', 0],
    ['1', 1],
    ['20', 20],
    [' 7 ', 7],
  ]) {
    const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 3 } })
    const field = mountCountField(scope)
    field.input().props.onChange({ target: { value: typed } })
    await field.input().props.onBlur()
    assert.equal(scope.calls.length, 1, typed)
    assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseMaxNoticesPerChild'], value: stored }])
    assert.equal(scope.calls[0].expected, 1)
    assert.equal(scope.getSnapshot().value.superviseMaxNoticesPerChild, stored)
    assert.equal(field.input().props.value, String(stored))
    assert.equal(field.alert(), undefined)
    field.view.unmount()
  }
})

test('Enter also commits a valid patrol count', async () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 3 } })
  const field = mountCountField(scope)
  field.input().props.onChange({ target: { value: '0' } })
  await field.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseMaxNoticesPerChild'], value: 0 }])
})

test('an empty patrol count writes the 3 default', async () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 9 } })
  const field = mountCountField(scope)
  field.input().props.onChange({ target: { value: '   ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseMaxNoticesPerChild'], value: 3 }])
  assert.equal(field.input().props.value, '3')
})

test('invalid patrol counts are rejected, restored, and explained', async () => {
  for (const bad of ['-1', '21', 'abc', '1.5']) {
    const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 5 } })
    const field = mountCountField(scope)
    field.input().props.onChange({ target: { value: bad } })
    await field.input().props.onBlur()
    assert.equal(scope.calls.length, 0, bad)
    assert.equal(field.input().props.value, '5', bad)
    assert.equal(field.alert().kids[0], 'supervise.countInvalid', bad)
    field.view.unmount()
  }
})

test('an unchanged patrol count does not mutate the config', async () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 3 } })
  const field = mountCountField(scope)
  field.input().props.onChange({ target: { value: ' 3 ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '3')
  assert.equal(field.alert(), undefined)
})

test('Escape abandons the patrol count edit and restores the stored value', () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 4 } })
  const field = mountCountField(scope)
  field.input().props.onChange({ target: { value: '11' } })
  field.input().props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '4')
  assert.equal(field.alert(), undefined)
})

test('a rejected patrol count write is caught and shown without crashing', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read', initial: { superviseMaxNoticesPerChild: 3 } })
  const field = mountCountField(scope)
  field.input().props.onChange({ target: { value: '8' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.equal(field.alert().kids[0], 'supervise.saveFailed')
  assert.equal(field.input().props.value, '3')
})

test('the patrol count field follows a value changed elsewhere', () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 3 } })
  const field = mountCountField(scope)
  scope.externalSet({ superviseMaxNoticesPerChild: 12 })
  assert.equal(field.input().props.value, '12')
})

test('the unlimited switch reuses EnableSwitch and is labelled for the patrol count', () => {
  const field = mountCountField(fakeScope())
  const toggle = field.toggle()
  assert.ok(toggle)
  assert.equal(toggle.props.label, 'supervise.unlimitedLabel')
  assert.equal(toggle.props.checked, false)
  assert.equal(toggle.props.disabled, false)
  // The label text sits beside the switch, not inside it.
  const labels = nodes(field.view.tree).filter((node) => node.type === 'span' && node.kids?.[0] === 'supervise.unlimitedLabel')
  assert.equal(labels.length, 1)
})

test('toggling unlimited writes superviseUnlimited and locks the count field', async () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 5 } })
  const field = mountCountField(scope)
  assert.equal(field.input().props.disabled, false)

  await field.toggle().props.onChange(true)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseUnlimited'], value: true }])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(scope.getSnapshot().value.superviseUnlimited, true)
  assert.equal(field.toggle().props.checked, true)
  // Locked: the count can no longer be edited, and the field is visibly greyed out.
  assert.equal(field.input().props.disabled, true)
  assert.equal(field.input().props.style.opacity, 0.5)
  assert.equal(field.input().props.style.cursor, 'not-allowed')
  assert.equal(field.alert(), undefined)

  await field.toggle().props.onChange(false)
  assert.deepEqual(plain(scope.calls[1].ops), [{ op: 'set', path: ['superviseUnlimited'], value: false }])
  assert.equal(field.toggle().props.checked, false)
  // Unlocked again, and the stored count is still there to edit.
  assert.equal(field.input().props.disabled, false)
  assert.equal(field.input().props.style.opacity, 1)
  assert.equal(field.input().props.value, '5')
})

test('a stored unlimited flag starts with the count field locked', () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 7, superviseUnlimited: true } })
  const field = mountCountField(scope)
  assert.equal(field.toggle().props.checked, true)
  assert.equal(field.input().props.disabled, true)
  assert.equal(field.input().props.value, '7')
})

test('turning unlimited on discards an uncommitted count draft', async () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 6 } })
  const field = mountCountField(scope)
  field.input().props.onChange({ target: { value: '17' } })
  await field.toggle().props.onChange(true)
  assert.equal(field.input().props.value, '6')
  assert.equal(scope.getSnapshot().value.superviseMaxNoticesPerChild, 6)
})

test('a rejected unlimited write is reported and leaves the switch off', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read' })
  const field = mountCountField(scope)
  await field.toggle().props.onChange(true)
  assert.equal(scope.calls.length, 1)
  assert.equal(field.alert().kids[0], 'supervise.saveFailed')
  assert.equal(field.toggle().props.checked, false)
  assert.equal(field.input().props.disabled, false)
})

test('a read-only scope disables both the count field and the unlimited switch', async () => {
  const scope = fakeScope({ writable: false })
  const field = mountCountField(scope)
  assert.equal(field.input().props.disabled, true)
  assert.equal(field.toggle().props.disabled, true)
  await field.toggle().props.onChange(true)
  assert.equal(scope.calls.length, 0)
  assert.equal(field.alert().kids[0], 'supervise.readonly')
})

test('the patrol count hint disappears when its timer fires', async () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 3 } })
  const field = mountCountField(scope)
  field.input().props.onChange({ target: { value: '99' } })
  await field.input().props.onBlur()
  assert.ok(field.alert())
  const timer = timers[timers.length - 1]
  timer.fn()
  assert.equal(field.alert(), undefined)
})

// ---- Allowed tools ------------------------------------------------------------------

// The panel cannot ask the host for a tool catalog (the session remote has no such
// method), so it re-declares the shipped whitelist. Reading the host constant out of the
// source keeps the two copies honest without loading the host entry, whose packages
// this test process does not install.
const hostSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const hostListSource = /export const DEFAULT_ALLOWED_TOOLS = \[([\s\S]*?)\]/.exec(hostSource)
// Strip `//` comments first: an apostrophe inside a comment ("the agent's surface")
// would otherwise pair with a real string quote and skew the extraction.
const hostListBody = hostListSource[1].replace(/\/\/[^\n]*/g, '')
const HOST_DEFAULT_ALLOWED_TOOLS = [...hostListBody.matchAll(/'([^']+)'/g)].map((match) => match[1])

test('the bundled copy of the shipped whitelist matches the host constant', () => {
  assert.deepEqual(plain(T.DEFAULT_ALLOWED_TOOLS), HOST_DEFAULT_ALLOWED_TOOLS)
  // 11 since `orchestrator_agents` replaced the host's `send_message`/`interrupt_agent` pair.
  assert.equal(HOST_DEFAULT_ALLOWED_TOOLS.length, 11)
  // The whitelist names the planning and delegation tools only: no file, search, shell or
  // web tool may appear here, or the main agent could work on the repo by itself.
  for (const name of ['delegate', 'orchestrate', 'orchestrator_agents', 'todo_write', 'ask_user_question', 'compress']) {
    assert.equal(HOST_DEFAULT_ALLOWED_TOOLS.includes(name), true, name)
  }
  // The per-agent host tools stay out of the shipped default: the admin tool replaces them.
  for (const name of ['send_message', 'interrupt_agent']) {
    assert.equal(HOST_DEFAULT_ALLOWED_TOOLS.includes(name), false, name)
  }
  for (const name of ['read', 'edit', 'write', 'bash', 'subagent', 'workflow', 'ralph', 'decompress', 'search_context']) {
    assert.equal(HOST_DEFAULT_ALLOWED_TOOLS.includes(name), false, name)
  }
})

test('the rows start with the shipped whitelist, every box checked', () => {
  const shown = plain(T.toolListOf({}))
  assert.deepEqual(shown, HOST_DEFAULT_ALLOWED_TOOLS)
  // A host tool the whitelist omits is not a row until the host catalog names it.
  for (const name of ['read', 'edit', 'bash', 'subagent', 'workflow']) {
    assert.equal(shown.includes(name), false, name)
  }
  const withCatalog = plain(T.toolListOf({ toolCatalog: ['edit', 'read'] }))
  for (const name of ['edit', 'read']) assert.equal(withCatalog.includes(name), true, name)
})

test('config and catalog names join the rows as extras, after the shipped order and sorted', () => {
  const shown = plain(T.toolListOf({ allowedTools: ['zeta', 'alpha'], toolCatalog: ['read'] }))
  assert.deepEqual(shown.slice(0, HOST_DEFAULT_ALLOWED_TOOLS.length), HOST_DEFAULT_ALLOWED_TOOLS)
  assert.deepEqual(shown.slice(-3), ['alpha', 'read', 'zeta'])
  assert.equal(new Set(shown).size, shown.length)
  // A name a profile checked is offered like any other, whatever it is called.
  assert.equal(plain(T.toolListOf({ allowedTools: ['custom_tool'] })).includes('custom_tool'), true)
})

test('the live catalog from the host joins the rows, deduped and sorted after the shipped list', () => {
  const shown = plain(T.toolListOf({ toolCatalog: ['zeta', 'mcp__github__create_issue', 'edit', 'read'] }))
  // A catalog name the whitelist does not know becomes one extra row, once only.
  assert.equal(shown.filter((name) => name === 'edit').length, 1)
  assert.equal(shown.filter((name) => name === 'delegate').length, 1)
  assert.deepEqual(shown.slice(-4), ['edit', 'mcp__github__create_issue', 'read', 'zeta'])
  // A delegation tool the catalog names is a row like any other, once only.
  assert.equal(plain(T.toolListOf({ toolCatalog: ['delegate'] })).filter((name) => name === 'delegate').length, 1)
})

test('a tool the shipped whitelist never heard of is a row and defaults to disabled', () => {
  const catalog = { toolCatalog: ['mcp__demo__ping', 'ops_new'] }
  const shown = plain(T.toolListOf(catalog))
  assert.ok(shown.includes('mcp__demo__ping'))
  assert.ok(shown.includes('ops_new'))
  // Unchecked, i.e. not allowed: a tool another plugin adds is blocked until the user
  // checks it, which is what makes the whitelist a default-deny rule for new tools too.
  const allowed = T.allowedSetOf(catalog)
  assert.equal(allowed.has('mcp__demo__ping'), false)
  assert.equal(allowed.has('ops_new'), false)
  // Once checked, the panel writes the name and the row reads checked.
  const checked = T.allowedSetOf({ ...catalog, allowedTools: [...HOST_DEFAULT_ALLOWED_TOOLS, 'mcp__demo__ping'] })
  assert.equal(checked.has('mcp__demo__ping'), true)
})

test('an absent or empty catalog keeps the shipped rows', () => {
  const shipped = HOST_DEFAULT_ALLOWED_TOOLS
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: [] })), shipped)
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: 'not-a-list' })), shipped)
  assert.deepEqual(plain(T.toolListOf({})), shipped)
  assert.deepEqual(plain(T.catalogOf({})), [])
  // Junk entries are dropped instead of rendering as empty rows.
  assert.deepEqual(plain(T.catalogOf({ toolCatalog: ['b', '', 7, 'a'] })), ['b', 'a'])
  assert.equal(T.CATALOG_KEY, 'toolCatalog')
  assert.equal(T.ALLOW_KEY, 'allowedTools')
})

test('the default whitelist is the shipped twelve, and nothing else is checked', () => {
  const shipped = T.allowedSetOf({})
  assert.equal(shipped.size, HOST_DEFAULT_ALLOWED_TOOLS.length)
  for (const name of HOST_DEFAULT_ALLOWED_TOOLS) assert.equal(shipped.has(name), true, name)
  // A tool outside the shipped list starts unchecked: a new plugin tool is disabled.
  assert.equal(shipped.has('read'), false)
  assert.equal(shipped.has('mcp__demo__ping'), false)

  // A catalog name is not an allowance: only the stored whitelist decides.
  const withCatalog = T.allowedSetOf({ toolCatalog: ['read', 'mcp__demo__ping'] })
  assert.equal(withCatalog.has('read'), false)
  assert.equal(withCatalog.size, HOST_DEFAULT_ALLOWED_TOOLS.length)
})

test('an explicit whitelist replaces the default, the empty array included', () => {
  const narrowed = T.allowedSetOf({ allowedTools: ['delegate', 'orchestrate'] })
  assert.deepEqual([...narrowed].sort(), ['delegate', 'orchestrate'])
  assert.equal(narrowed.has('compress'), false)

  // Unchecking every box must disable every tool; falling back on the default here would
  // silently re-arm the main agent.
  assert.equal(T.allowedSetOf({ allowedTools: [] }).size, 0)

  // Junk entries are dropped rather than becoming a checked row nobody can see.
  assert.deepEqual([...T.allowedSetOf({ allowedTools: ['delegate', '', 7] })], ['delegate'])
  assert.equal(T.allowedSetOf({ allowedTools: 'not-a-list' }).size, HOST_DEFAULT_ALLOWED_TOOLS.length)
})

test('checking exactly the shipped twelve stores nothing, so the default applies again', () => {
  // The stored value is only the difference from the shipped whitelist: a full default set
  // is written as `unset`, so a later default change still reaches an untouched profile.
  assert.deepEqual(plain(T.allowOps(HOST_DEFAULT_ALLOWED_TOOLS)), [{ op: 'unset', path: ['allowedTools'] }])
  // Order and duplicates do not matter: the same set is the same default.
  assert.deepEqual(plain(T.allowOps([...HOST_DEFAULT_ALLOWED_TOOLS].reverse())), [
    { op: 'unset', path: ['allowedTools'] },
  ])
  assert.deepEqual(plain(T.allowOps([...HOST_DEFAULT_ALLOWED_TOOLS, 'delegate'])), [
    { op: 'unset', path: ['allowedTools'] },
  ])
})

test('a narrowed or widened whitelist is stored as one explicit list, deduped', () => {
  const narrowed = HOST_DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'compress')
  assert.deepEqual(plain(T.allowOps(narrowed)), [{ op: 'set', path: ['allowedTools'], value: narrowed }])

  // An added name joins the same list: there is no second key any more.
  assert.deepEqual(plain(T.allowOps([...HOST_DEFAULT_ALLOWED_TOOLS, 'read'])), [
    { op: 'set', path: ['allowedTools'], value: [...HOST_DEFAULT_ALLOWED_TOOLS, 'read'] },
  ])
  // Duplicates collapse, and the click order is what gets stored.
  assert.deepEqual(plain(T.allowOps(['read', 'read', 'delegate'])), [
    { op: 'set', path: ['allowedTools'], value: ['read', 'delegate'] },
  ])
  // Unchecking every box stores the empty list, which means "allow nothing at all".
  assert.deepEqual(plain(T.allowOps([])), [{ op: 'set', path: ['allowedTools'], value: [] }])
})

test('reset unsets the one key, so the shipped whitelist applies again', () => {
  assert.deepEqual(plain(T.resetAllowOps()), [{ op: 'unset', path: ['allowedTools'] }])
})

test('the search matches a case-insensitive substring of the tool name', () => {
  const names = ['edit', 'read', 'ops_bash', 'web_search']
  assert.deepEqual(plain(T.filterTools(names, '')), names)
  assert.deepEqual(plain(T.filterTools(names, '  ED ')), ['edit'])
  assert.deepEqual(plain(T.filterTools(names, 'ops')), ['ops_bash'])
  assert.deepEqual(plain(T.filterTools(names, 'SEARCH')), ['web_search'])
  assert.deepEqual(plain(T.filterTools(names, 'zzz')), [])
})

/** Mount the switch and expose the nodes the tests reach for. */
function mountSwitch(props) {
  const view = mount(T.EnableSwitch, {
    checked: false,
    disabled: false,
    onChange: () => {},
    label: 'route.enable',
    ...props,
  })
  const input = () => nodes(view.tree).find((node) => node.type === 'input')
  const track = () => nodes(view.tree).find((node) => node.props?.['data-switch'] !== undefined)
  return { view, input, track }
}

test('the switch is a role=switch checkbox with a real aria-checked state', () => {
  const off = mountSwitch({})
  assert.equal(off.input().props.type, 'checkbox')
  assert.equal(off.input().props.role, 'switch')
  assert.equal(off.input().props['aria-checked'], 'false')
  assert.equal(off.input().props.checked, false)
  assert.equal(off.input().props['aria-label'], 'route.enable')
  assert.equal(off.track().props['data-switch'], 'off')

  const on = mountSwitch({ checked: true })
  assert.equal(on.input().props['aria-checked'], 'true')
  assert.equal(on.track().props['data-switch'], 'on')
  // The on-track colour is fixed so it reads the same in both themes.
  assert.equal(on.track().props.style.background, '#C6FFD5')
  // The knob slides rather than jumping, and is ringed so white stays visible on it.
  const knob = on.track().kids[0]
  assert.equal(knob.props.style.transform, 'translateX(16px)')
  assert.match(knob.props.style.transition, /transform/)
  assert.match(knob.props.style.boxShadow, /rgba\(0, 0, 0/)
  const offKnob = off.track().kids[0]
  assert.equal(offKnob.props.style.transform, 'translateX(0)')
  assert.match(off.track().props.style.transition, /background-color/)
})

test('the switch is grey when off and green when on, from theme tokens', () => {
  const off = mountSwitch({})
  assert.match(off.track().props.style.background, /--dsw-alias-border-l3/)
  const on = mountSwitch({ checked: true })
  assert.equal(on.track().props.style.background, '#C6FFD5')
  assert.equal(mountSwitch({ checked: true, disabled: true }).track().props.style.opacity, 0.5)
})

test('Enter toggles the switch, and a disabled switch ignores it', () => {
  const seen = []
  const off = mountSwitch({ onChange: (next) => seen.push(next) })
  off.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  const on = mountSwitch({ checked: true, onChange: (next) => seen.push(next) })
  on.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(seen, [true, false])
  off.input().props.onKeyDown({ key: 'a', preventDefault() {} })
  assert.deepEqual(seen, [true, false])
  const locked = mountSwitch({ disabled: true, onChange: (next) => seen.push(next) })
  locked.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(seen, [true, false])
  // The native checkbox change path is untouched.
  off.input().props.onChange({ target: { checked: true } })
  assert.deepEqual(seen, [true, false, true])
})

test('the switch draws a focus ring only while focused', () => {
  const sw = mountSwitch({})
  assert.equal(sw.track().props.style.boxShadow, 'none')
  sw.input().props.onFocus()
  assert.match(sw.track().props.style.boxShadow, /0 0 0 2px/)
  sw.input().props.onBlur()
  assert.equal(sw.track().props.style.boxShadow, 'none')
})

/** Mount the allowed-tools column and expose the nodes the tests reach for. */
function mountAllowed(scope) {
  const view = mount(T.AllowedToolsPanel, { scope, t })
  // Tool rows only: a plugin header is a label too, but it carries no `data-tool`.
  const rows = () => nodes(view.tree).filter((node) => node.type === 'label' && node.props?.['data-tool'] !== undefined)
  const headers = () => nodes(view.tree).filter((node) => node.type === 'label' && node.props?.['data-plugin-toggle'] !== undefined)
  const search = () => nodes(view.tree).find((node) => node.props?.['data-search'] === 'allowed-tools')
  const button = () => nodes(view.tree).find((node) => node.type === 'button')
  const text = () => nodes(view.tree).map((node) => node.kids?.[0]).filter((kid) => typeof kid === 'string')
  return { view, rows, headers, search, button, text }
}

test('the column is headed Allowed Tools and lists one checked row per shipped tool', () => {
  const panel = mountAllowed(fakeScope())
  assert.equal(panel.text().includes('allowed.title'), true)
  // The heading is literally "Allowed Tools" in the dictionary.
  const title = /'allowed\.title': '([^']+)'/.exec(src)?.[1]
  assert.equal(title, 'Allowed Tools')
  // The column is addressable, so a host layout can find it without guessing a class.
  assert.equal(panel.view.tree.props['data-panel'], 'allowed-tools')

  const rows = panel.rows()
  assert.equal(rows.length, HOST_DEFAULT_ALLOWED_TOOLS.length)
  const first = rows[0]
  assert.equal(first.kids[0].type, 'input')
  assert.equal(first.kids[1].type, 'span')
  assert.equal(first.kids[0].props.type, 'checkbox')
  // A checked box means "allowed for the main agent": the shipped twelve start checked.
  assert.equal(first.kids[0].props.checked, true)
  assert.equal(first.kids[0].props.disabled, false)
  assert.deepEqual(rows.map((row) => row.props['data-tool']), HOST_DEFAULT_ALLOWED_TOOLS)

  // A host tool the whitelist does not cover is a row too, unchecked: a new plugin or MCP
  // tool is disabled by default instead of silently joining the main agent's kit.
  const withCatalog = mountAllowed(fakeScope({ initial: { toolCatalog: ['read', 'edit', 'mcp__demo__ping'] } }))
  const extra = withCatalog.rows().filter((row) => ['read', 'edit', 'mcp__demo__ping'].includes(row.props['data-tool']))
  assert.equal(extra.length, 3)
  for (const row of extra) {
    assert.equal(row.kids[0].type, 'input')
    assert.equal(row.kids[0].props.disabled, false)
    assert.equal(row.kids[0].props.checked, false, row.props['data-tool'])
  }
  // The search box sits above the list.
  assert.equal(panel.search().props.type, 'search')
})

test('every row leads with the checkbox so a long name cannot scroll it out of the column', () => {
  const panel = mountAllowed(
    fakeScope({ initial: { toolCatalog: ['mcp__a_very_long_server__a_very_long_tool_name_that_will_not_fit'] } }),
  )
  const rows = panel.rows()
  assert.ok(rows.length > 0)
  // The list is one column pinned to the container, not an `auto` track that a long name
  // would widen (and scroll) sideways.
  const list = nodes(panel.view.tree).find((node) => node.props?.role === 'group')
  assert.equal(list.props.style.display, 'grid')
  assert.equal(list.props.style.gridTemplateColumns, 'minmax(0, 1fr)')
  for (const row of rows) {
    // Checkbox first, name second: the reading order follows the visual order, so the box
    // stays inside the 232px column however long the name is.
    assert.equal(row.kids[0].type, 'input', row.props['data-tool'])
    assert.equal(row.kids[0].props.type, 'checkbox', row.props['data-tool'])
    assert.equal(row.kids[1].type, 'span', row.props['data-tool'])
    assert.equal(row.kids[1].kids[0], row.props['data-tool'])
    // The row cannot be widened past the column by its content, so nothing scrolls sideways.
    assert.equal(row.props.style.minWidth, 0)
    // The box never shrinks; the name absorbs the remaining width and truncates.
    assert.equal(row.kids[0].props.style.flex, 'none')
    assert.equal(row.kids[1].props.style.flex, '1 1 auto')
    assert.equal(row.kids[1].props.style.minWidth, 0)
    assert.equal(row.kids[1].props.style.overflow, 'hidden')
    assert.equal(row.kids[1].props.style.textOverflow, 'ellipsis')
  }
  // The long name keeps its full value in the tooltip instead of being cut in the markup.
  const long = rows.find((row) => row.props['data-tool'].startsWith('mcp__a_very_long'))
  assert.equal(long.kids[1].props.title, 'mcp__a_very_long_server__a_very_long_tool_name_that_will_not_fit')
})

test('the search narrows the rows case-insensitively and explains an empty result', () => {
  const panel = mountAllowed(
    fakeScope({ initial: { toolCatalog: ['read', 'edit', 'ops_read_files', 'read_image', 'acp_read_original_image'] } }),
  )
  panel.search().props.onChange({ target: { value: 'READ' } })
  assert.deepEqual(
    panel.rows().map((row) => row.props['data-tool']),
    // `session_event_read` is a shipped row, so it comes first; the catalog extras follow sorted.
    ['session_event_read', 'acp_read_original_image', 'ops_read_files', 'read', 'read_image'],
  )
  panel.search().props.onChange({ target: { value: 'zzz' } })
  assert.deepEqual(panel.rows(), [])
  assert.equal(panel.text().includes('allowed.empty'), true)
})

test('a tool published by another plugin is listed, searchable and unchecked', async () => {
  const scope = fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'ops_new_tool'] } })
  const panel = mountAllowed(scope)
  panel.search().props.onChange({ target: { value: 'DEMO' } })
  const rows = panel.rows()
  assert.deepEqual(rows.map((row) => row.props['data-tool']), ['mcp__demo__ping'])
  assert.equal(rows[0].kids[0].props.type, 'checkbox')
  assert.equal(rows[0].kids[0].props.checked, false, 'a new tool starts disabled')

  // Checking it writes the name into the whitelist, on top of the shipped twelve.
  await rows[0].kids[0].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(scope.calls[0].ops), [
    { op: 'set', path: ['allowedTools'], value: [...HOST_DEFAULT_ALLOWED_TOOLS, 'mcp__demo__ping'] },
  ])
})

test('rows are grouped by plugin, and an MCP server is its own group', () => {
  const panel = mountAllowed(
    fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'mcp__demo__pong', 'ops_read_files', 'ops_bash'] } }),
  )
  const keys = panel.headers().map((header) => header.props['data-plugin-toggle'])
  // Grouped by name convention, because the host publishes names only.
  assert.equal(keys.includes('mcp:demo'), true)
  assert.equal(keys.includes('ops'), true)
  // An MCP group reads as the server name, not as the bare `mcp` prefix.
  assert.equal(keys.includes('mcp'), false)
  // Every tool appears exactly once, under its own group.
  const rendered = panel.rows().map((row) => row.props['data-tool'])
  assert.equal(new Set(rendered).size, rendered.length)
  assert.equal(rendered.includes('mcp__demo__ping'), true)
})

test('checking a plugin header selects every tool in that plugin in one write', async () => {
  const scope = fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'mcp__demo__pong'] } })
  const panel = mountAllowed(scope)
  const header = panel.headers().find((entry) => entry.props['data-plugin-toggle'] === 'mcp:demo')
  assert.equal(header.kids[0].props.checked, false)
  await header.kids[0].props.onChange({ target: { checked: true } })
  // One write for the whole group: both tools land in the whitelist together.
  assert.equal(scope.calls.length, 1)
  const value = plain(scope.calls[0].ops[0].value)
  assert.deepEqual(value.filter((name) => name.startsWith('mcp__demo__')), ['mcp__demo__ping', 'mcp__demo__pong'])
})

test('unchecking a plugin header clears every tool in that plugin in one write', async () => {
  const scope = fakeScope({
    initial: { allowedTools: [...HOST_DEFAULT_ALLOWED_TOOLS, 'mcp__demo__ping', 'mcp__demo__pong'] },
  })
  const panel = mountAllowed(scope)
  const header = panel.headers().find((entry) => entry.props['data-plugin-toggle'] === 'mcp:demo')
  assert.equal(header.kids[0].props.checked, true)
  await header.kids[0].props.onChange({ target: { checked: false } })
  assert.equal(scope.calls.length, 1)
  // Unchecking the whole group leaves exactly the shipped default, stored as `unset`.
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'unset', path: ['allowedTools'] }])
  const value = plain(scope.getSnapshot().value.allowedTools ?? HOST_DEFAULT_ALLOWED_TOOLS)
  assert.equal(value.some((name) => name.startsWith('mcp__demo__')), false)
  // Nothing outside the group was touched.
  for (const name of HOST_DEFAULT_ALLOWED_TOOLS) assert.equal(value.includes(name), true, name)
})

test('a partly checked plugin header reports the mixed state and its count', () => {
  const panel = mountAllowed(
    fakeScope({ initial: { allowedTools: [...HOST_DEFAULT_ALLOWED_TOOLS, 'mcp__demo__ping'] , toolCatalog: ['mcp__demo__ping', 'mcp__demo__pong'] } }),
  )
  const header = panel.headers().find((entry) => entry.props['data-plugin-toggle'] === 'mcp:demo')
  // Mixed: the box is not checked, but its counter says how much of the group is on.
  assert.equal(header.kids[0].props.checked, false)
  assert.equal(header.kids[2].kids[0], '1/2')
})

test('two clicks in a row both land, so a fast user is not silently dropped', async () => {
  const scope = fakeScope({ initial: { toolCatalog: ['read', 'edit'] } })
  const panel = mountAllowed(scope)
  const box = (name) => panel.rows().find((row) => row.props['data-tool'] === name).kids[0]
  // Both writes are issued before the first resolves: the second must not be discarded.
  await Promise.all([
    box('read').props.onChange({ target: { checked: true } }),
    box('edit').props.onChange({ target: { checked: true } }),
  ])
  assert.equal(scope.calls.length, 2)
  const stored = scope.getSnapshot().value.allowedTools
  assert.equal(stored.includes('read'), true, 'the first click survived')
  assert.equal(stored.includes('edit'), true, 'the second click landed too')
})

test('unchecking a shipped name drops it from the stored whitelist', async () => {
  const scope = fakeScope()
  const panel = mountAllowed(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'delegate')
  assert.equal(row().kids[0].props.checked, true)
  await row().kids[0].props.onChange({ target: { checked: false } })
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [
    { op: 'set', path: ['allowedTools'], value: HOST_DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'delegate') },
  ])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(row().kids[0].props.checked, false)
})

test('checking the last unchecked name restores the default instead of storing a list', async () => {
  // Re-checking everything must go back to `unset`, so the profile follows the shipped
  // whitelist again rather than pinning today's copy of it.
  const scope = fakeScope({ initial: { allowedTools: HOST_DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'compress') } })
  const panel = mountAllowed(scope)
  const row = panel.rows().find((entry) => entry.props['data-tool'] === 'compress')
  assert.equal(row.kids[0].props.checked, false)
  await row.kids[0].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'unset', path: ['allowedTools'] }])
  assert.equal(panel.rows().find((entry) => entry.props['data-tool'] === 'compress').kids[0].props.checked, true)
})

test('a name a profile checked but the catalog does not list is still a row', async () => {
  const scope = fakeScope({ initial: { allowedTools: [...HOST_DEFAULT_ALLOWED_TOOLS, 'custom_tool'] } })
  const panel = mountAllowed(scope)
  const row = panel.rows().find((entry) => entry.props['data-tool'] === 'custom_tool')
  assert.ok(row, 'a checked name is listed even without a catalog entry')
  assert.equal(row.kids[0].props.checked, true)
  await row.kids[0].props.onChange({ target: { checked: false } })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'unset', path: ['allowedTools'] }])
})

test('reset unsets the whitelist so the shipped twelve apply again', async () => {
  const scope = fakeScope({ initial: { allowedTools: ['delegate'] } })
  const panel = mountAllowed(scope)
  assert.equal(panel.button().kids[0], 'allowed.reset')
  // Only one tool was allowed, so every other shipped row starts unchecked.
  assert.equal(panel.rows().find((entry) => entry.props['data-tool'] === 'compress').kids[0].props.checked, false)
  await panel.button().props.onClick()
  assert.deepEqual(plain(scope.calls[0].ops), plain(T.resetAllowOps()))
  assert.deepEqual(plain(T.resetAllowOps()), [{ op: 'unset', path: ['allowedTools'] }])
  assert.equal(panel.rows().find((entry) => entry.props['data-tool'] === 'compress').kids[0].props.checked, true)
})

test('a read-only scope disables the boxes and never writes', async () => {
  const scope = fakeScope({ writable: false })
  const panel = mountAllowed(scope)
  const box = panel.rows().find((row) => row.props['data-tool'] === 'delegate').kids[0]
  assert.equal(box.props.disabled, true)
  assert.equal(panel.button().props.disabled, true)
  await panel.button().props.onClick()
  assert.equal(scope.calls.length, 0)
})

test('a rejected write is reported without dropping the stored state', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read' })
  const panel = mountAllowed(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'delegate')
  await row().kids[0].props.onChange({ target: { checked: false } })
  const alert = nodes(panel.view.tree).find((node) => node.props?.role === 'alert')
  assert.match(alert.kids[0], /settings changed/)
  assert.equal(row().kids[0].props.checked, true)
})

test('the popover is two columns, the original panel then the allowed tools column', () => {
  const scopes = { main: fakeScope(), worker: fakeScope(), orch: fakeScope() }
  const view = mount(T.RoutePicker, {
    t,
    scopes,
    orch: scopes.orch,
    loadCatalog: async () => ({ ok: true, value: { groups: [] } }),
  })
  // The popover only exists while open; the trigger is the only button before that.
  nodes(view.tree).find((node) => node.type === 'button').props.onClick()
  const dialog = nodes(view.tree).find((node) => node.props?.role === 'dialog')
  assert.ok(dialog)
  assert.equal(dialog.kids.length, 2)
  const [left, right] = dialog.kids
  assert.equal(left.type, 'div')
  assert.equal(left.props.style.width, '340px')
  assert.match(left.props.style.borderRight, /^1px solid/)
  assert.equal(right.type, T.AllowedToolsPanel)
  assert.equal(right.props.scope, scopes.orch)
  // The enable row is label-then-switch, and the switch is the new component.
  const switchRow = nodes(left).find((node) => node.type === T.EnableSwitch)
  assert.ok(switchRow)
  assert.equal(switchRow.props.label, 'route.enable')
  // Both supervision fields live in the left column, interval first then the count.
  const intervalField = nodes(left).find((node) => node.type === T.SuperviseIntervalField)
  const countField = nodes(left).find((node) => node.type === T.SuperviseCountField)
  assert.ok(intervalField)
  assert.ok(countField)
  assert.equal(intervalField.props.scope, scopes.orch)
  assert.equal(countField.props.scope, scopes.orch)
  assert.ok(nodes(left).indexOf(intervalField) < nodes(left).indexOf(countField))
  view.unmount()
})


// ---- The model list inside a clipped popover ------------------------------------------

test('catalogFor keeps the last non-empty catalog, because an empty read is a write in flight', () => {
  assert.deepEqual(plain(T.catalogFor({ toolCatalog: ['a', 'b'] }, ['stale'])), ['a', 'b'])
  // The Loader commits the profile's raw value on every settings write; for an unset key
  // that is [], and a real catalog is never empty.
  assert.deepEqual(plain(T.catalogFor({ toolCatalog: [] }, ['kept'])), ['kept'])
  assert.deepEqual(plain(T.catalogFor({}, ['kept'])), ['kept'])
  assert.deepEqual(plain(T.catalogFor({}, undefined)), [])
  // A remembered catalog never leaks into toolListOf on its own.
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: [] }, ['mcp__demo__ping'])).slice(-1), ['mcp__demo__ping'])
})

test('a catalog that reads empty mid-write does not collapse the panel to the shipped rows', () => {
  const scope = fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'read'] } })
  const panel = mountAllowed(scope)
  const names = () => panel.rows().map((row) => row.props['data-tool'])
  assert.ok(names().includes('mcp__demo__ping'))

  // The host's own settings write empties the field for an instant; the rows must survive it.
  scope.externalSet({ toolCatalog: [] })
  assert.ok(names().includes('mcp__demo__ping'))
  assert.ok(names().includes('delegate'))

  // A genuinely different catalog still replaces the remembered one.
  scope.externalSet({ toolCatalog: ['ops_new'] })
  assert.ok(names().includes('ops_new'))
  assert.equal(names().includes('mcp__demo__ping'), false)
})

test('the model list opens on the side with room and caps its height to that room', () => {
  const rect = { top: 100, bottom: 134, left: 20, width: 300 }
  // Plenty of room below: open downward at the preferred height, aligned to the button.
  const down = plain(T.popupPlacement(rect, 900))
  assert.deepEqual(down, { side: 'down', maxHeight: 260, top: 138, bottom: 'auto', left: 20, width: 300 })

  // At the bottom of the window the room below is small, so it flips upward.
  const up = plain(T.popupPlacement({ top: 700, bottom: 734, left: 20, width: 300 }, 800))
  assert.equal(up.side, 'up')
  assert.equal(up.maxHeight, 260)
  assert.equal(up.top, 'auto')
  assert.equal(up.bottom, 104)

  // Tight on both sides: stay on the roomier side, shrink to it, and scroll inside.
  const tight = plain(T.popupPlacement({ top: 200, bottom: 240, left: 0, width: 200 }, 400))
  assert.equal(tight.side, 'up')
  assert.equal(tight.maxHeight, 188)
  assert.ok(tight.maxHeight < 260)

  // No layout to measure (a test host, a detached render): leave the caller on its own style.
  assert.equal(T.popupPlacement(null, 900), null)
  assert.equal(T.popupPlacement(rect, undefined), null)
  assert.equal(T.popupPlacement({ top: NaN, bottom: 10 }, 900), null)
  // The fallback keeps the list scrollable rather than open-ended.
  assert.equal(T.dropdownStyleOf(null).maxHeight, '260px')
  assert.equal(T.dropdownStyleOf(null).position, 'fixed')
  const placed = T.dropdownStyleOf(T.popupPlacement({ top: 700, bottom: 734, left: 8, width: 240 }, 800))
  assert.equal(placed.maxHeight, '260px')
  assert.equal(placed.bottom, 104)
  assert.equal(placed.right, 'auto')
  assert.equal(placed.width, 240)
})

/** Mount one model row, open its list, and expose what the tests read off it. */
function mountRow({ groups = [], route = { provider: '', model: '', effort: '' }, rect, viewport = 900 } = {}) {
  const changes = []
  fakeWindow.innerHeight = viewport
  const view = mount(T.RouteRow, {
    label: 'worker',
    route,
    groups,
    disabled: false,
    onChange: (next) => changes.push(next),
    t,
  })
  const all = () => nodes(view.tree)
  const trigger = () => all().find((node) => node.props?.['aria-haspopup'] === 'listbox')
  const listbox = () => all().find((node) => node.props?.role === 'listbox')
  const choices = () => all().filter((node) => node.props?.role === 'option')
  const open = () => {
    // The row measures its own box before the list paints; the harness has no layout
    // engine, so the anchor's ref is handed a rect the way React would hand it a node.
    const anchor = all().find((node) => node.props?.ref !== null && typeof node.props?.ref === 'object')
    if (anchor !== undefined && rect !== undefined) anchor.props.ref.current = { getBoundingClientRect: () => rect }
    trigger().props.onClick()
  }
  return { view, changes, trigger, listbox, choices, open }
}

const ROW_GROUPS = [
  {
    id: 'nexus-deepseek',
    name: 'Nexus DeepSeek',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'Flash' },
      { id: 'deepseek-v4.1-pro', name: 'Pro' },
    ],
  },
  { id: 'nexus-claude', name: 'Nexus Claude', models: [{ id: 'claude/opus:5.5', name: 'Opus 5.5' }] },
]

test('the model list flips above the row and stays clickable at the bottom of the window', () => {
  const row = mountRow({
    groups: ROW_GROUPS,
    route: { provider: 'nexus-deepseek', model: 'deepseek-v4.1-pro', effort: '' },
    rect: { top: 700, bottom: 734, left: 40, width: 320 },
    viewport: 800,
  })
  assert.equal(row.listbox(), undefined, 'the list is closed until the row is clicked')
  row.open()

  const list = row.listbox()
  assert.ok(list, 'clicking the row opens the listbox')
  // Upward, because the window bottom leaves 58px below and 688px above.
  assert.equal(list.props['data-side'], 'up')
  assert.equal(list.props.style.position, 'fixed')
  assert.equal(list.props.style.bottom, 104)
  assert.equal(list.props.style.top, 'auto')
  assert.equal(list.props.style.maxHeight, '260px')
  // Capped and scrollable: the last option is reachable instead of clipped away.
  assert.equal(list.props.style.overflowY, 'auto')
  assert.equal(list.props.style.left, 40)
  assert.equal(list.props.style.width, 320)
  // Scroll and resize are watched while it is open, and released when it closes.
  assert.ok(fakeWindow.listeners.includes('resize'))
  assert.ok(fakeWindow.listeners.includes('scroll'))
  row.view.unmount()
  assert.deepEqual(fakeWindow.listeners, [])
})

test('the last model in the list is a real choice, and it saves that model', () => {
  const row = mountRow({
    groups: ROW_GROUPS,
    route: { provider: 'nexus-deepseek', model: 'deepseek-v4.1-pro', effort: '' },
    rect: { top: 700, bottom: 734, left: 40, width: 320 },
    viewport: 800,
  })
  row.open()
  const choices = row.choices()
  // Unset, then three models: the last one is the final provider's only model.
  assert.equal(choices.length, 4)
  const last = choices.at(-1)
  assert.equal(last.kids[0], 'Opus 5.5')
  last.props.onClick()
  assert.deepEqual(plain(row.changes), [{ provider: 'nexus-claude', model: 'claude/opus:5.5', effort: '' }])
  assert.equal(row.listbox(), undefined, 'choosing closes the list')
})

test('a row with no measurable box still opens, on the static upward-or-downward style', () => {
  const row = mountRow({ groups: ROW_GROUPS })
  row.open()
  const list = row.listbox()
  assert.ok(list)
  // No rect was supplied, so no placement was measured and the element keeps the fallback.
  assert.equal(list.props['data-side'], undefined)
  assert.equal(list.props.style.position, 'fixed')
  assert.equal(list.props.style.maxHeight, '260px')
  assert.equal(row.choices().length, 4)
  row.view.unmount()
})

test('the open model list is portalled to the document body, not the composer subtree', () => {
  portals.length = 0
  const row = mountRow({
    groups: ROW_GROUPS,
    rect: { top: 120, bottom: 154, left: 40, width: 320 },
  })
  row.open()
  // The composer's ancestors are the containing block of a fixed child (`container-type` on the
  // row, `will-change: transform` on the seat), so the list has to leave that subtree entirely.
  assert.ok(portals.length >= 1, 'opening the list mounts it through a portal')
  assert.deepEqual(
    portals.map((entry) => entry.target),
    portals.map(() => fakeDocument.body),
  )
  const portal = nodes(row.view.tree).find((node) => node.type === 'portal')
  assert.ok(portal, 'the portal node stays in the rendered tree')
  const list = portal.kids[0]
  assert.equal(list.props.role, 'listbox')
  // The body has no fixed containing block, so the measured viewport rect applies as written.
  assert.equal(list.props.style.position, 'fixed')
  assert.equal(list.props.style.top, 158)
  assert.equal(list.props.style.left, 40)
  assert.equal(list.props.style.width, 320)
  const field = nodes(portal).find((node) => node.type === 'input')
  // The filter is focused from an effect with `preventScroll`; a plain `autoFocus` would make the
  // browser scroll the composer's scroll containers to reveal the field.
  assert.equal(field.props.autoFocus, undefined)
  assert.equal(typeof field.props.ref, 'object')
  row.view.unmount()
})

test('a click inside the portalled list keeps it open, a click outside closes it', () => {
  // Rows opened by earlier tests keep their listeners; start from a clean document.
  fakeDocument.listeners = []
  const row = mountRow({ groups: ROW_GROUPS })
  row.open()
  const list = row.listbox()
  const anchor = nodes(row.view.tree).find((node) => node.props?.style?.position === 'relative')
  const trigger = {}
  const inside = {}
  const elsewhere = {}
  anchor.props.ref.current = { contains: (target) => target === trigger }
  // The list lives under `document.body`, so `box.contains` is false for its own options. Without
  // the list's own ref the pointerdown capture would close it before the option click fired.
  list.props.ref.current = { contains: (target) => target === inside }
  pointerDown(inside)
  assert.ok(row.listbox(), 'a pointerdown inside the list leaves it open')
  pointerDown(trigger)
  assert.ok(row.listbox(), 'a pointerdown on the trigger leaves it open')
  pointerDown(elsewhere)
  assert.equal(row.listbox(), undefined, 'a pointerdown outside closes it')
  row.view.unmount()
  assert.deepEqual(fakeDocument.listeners, [], 'unmounting releases the document listener')
})

test('the list paints above the composer menus once it is portalled', () => {
  assert.equal(T.dropdownStyle.zIndex, 1100)
  assert.equal(T.dropdownStyleOf(null).zIndex, 1100)
})

test('the allowed-tools card fills the stretched column without reporting a content height', () => {
  // The popover is a row flex box with an auto height, so it takes its cross size from the
  // children's intrinsic heights. Flexbox §9.9.1 measures a column container's intrinsic main
  // size from its children's max-content contributions, where neither `flex-basis: 0` nor
  // `height: 0` hides a fifty-row stack: a host with that many tools reported ~1400px and the
  // popover was pushed through the top of the window. Size containment is what zeroes it.
  const column = T.allowedColumnStyle
  assert.equal(column.contain, 'size')
  assert.equal(column.flexDirection, 'column')
  assert.equal(column.width, '232px')
  assert.equal(column.minHeight, 0)
  const card = T.allowedListBoxStyle
  assert.equal(card.contain, 'size')
  // A definite pixel basis, not a percentage: `0%` degrades to `content` while the column's
  // own height is still indefinite, which is exactly the measurement being defended against.
  assert.equal(card.flex, '1 1 0px')
  assert.equal(card.minHeight, 0)
  assert.equal(card.height, undefined)
  assert.equal(card.maxHeight, undefined)
  const list = T.allowedListStyle
  assert.equal(list.contain, 'size')
  assert.equal(list.flex, '1 1 0px')
  assert.equal(list.minHeight, 0)
  assert.equal(list.overflowY, 'auto')
  // The stretch that hands the height down is what makes the three styles above add up.
  assert.equal(T.panelStyle.alignItems, 'stretch')
  // A short window still cannot push the popover past the viewport, and the left column then
  // scrolls instead of being clipped.
  assert.equal(T.panelStyle.maxHeight, 'calc(100vh - 96px)')
  assert.equal(T.panelColumnStyle.display, 'grid')
  assert.equal(T.panelColumnStyle.overflowY, 'auto')
})

test('the popover height is capped to the room above its trigger, not just the viewport', () => {
  // `100vh` alone let the top of the panel hang outside the window when the composer sat low:
  // the panel opens upward, so the measured trigger position is the real ceiling.
  assert.equal(T.panelStyleOf(null).maxHeight, 'calc(100vh - 96px)')
  assert.equal(T.panelStyleOf(undefined).maxHeight, 'calc(100vh - 96px)')
  const measure = T.panelStyleOf(417)
  assert.equal(measure.maxHeight, '417px')
  // Everything else stays the popover's own style, and the static one is not mutated.
  assert.equal(measure.position, 'absolute')
  assert.equal(measure.display, 'flex')
  assert.equal(measure.alignItems, 'stretch')
  assert.equal(T.panelStyle.maxHeight, 'calc(100vh - 96px)')
})

test('the popover reserves the host top chrome, so its rounded top is never clipped', () => {
  // A centred composer in an empty session: trigger.top 493 leaves 437px, which puts the panel's
  // top edge at y = 48 — right under the session header — instead of the 8px that was being
  // painted over the header's 48px and hiding "Enable dispatch mode" and "Allowed Tools".
  assert.equal(T.panelRoom(493, 900), 437)
  // A composer at the bottom of a live session has room for the whole panel, so the left column
  // never needs to scroll there.
  assert.equal(T.panelRoom(820, 900), 764)
  // Floor and viewport guard still apply.
  assert.equal(T.panelRoom(120, 900), 240)
  assert.equal(T.panelRoom(4000, 900), 804)
  assert.equal(T.panelRoom(undefined, 900), null)
  // A vertical scrollbar must never turn into a sideways one in the left column.
  assert.equal(T.panelColumnStyle.gridTemplateColumns, 'minmax(0, 1fr)')
  assert.equal(T.panelColumnStyle.overflowX, 'hidden')
  assert.equal(T.panelColumnStyle.overflowY, 'auto')
  assert.equal(T.panelColumnStyle.gap, '8px')
})


// ---- Plugin grouping and the bulk header ----------------------------------------------

test('a plugin group header allows every tool in the group in one write', async () => {
  // The group owning `session_search` also owns the other session_* tools, so one click on
  // its header is one round trip for the whole plugin instead of one per tool.
  const scope = fakeScope({ initial: { allowedTools: [] } })
  const panel = mountAllowed(scope)
  const header = panel.headers().find((node) => node.props['data-plugin-toggle'] === 'session')
  assert.notEqual(header, undefined, 'the session group has a header')
  assert.equal(header.kids[0].type, 'input')
  assert.equal(header.kids[0].props.type, 'checkbox')
  assert.equal(header.kids[0].props.checked, false)
  await header.kids[0].props.onChange({ target: { checked: true } })
  assert.equal(scope.calls.length, 1, 'one write for the whole group')
  const written = new Set(plain(scope.calls[0].ops)[0].value)
  for (const name of ['session_search', 'session_trace', 'session_event_search', 'session_event_read', 'session_event_trace']) {
    assert.equal(written.has(name), true, name + ' was added by the group')
  }
})

test('a group header unchecks every tool it covers', async () => {
  const scope = fakeScope()
  const panel = mountAllowed(scope)
  const header = () => panel.headers().find((node) => node.props['data-plugin-toggle'] === 'session')
  assert.equal(header().kids[0].props.checked, true, 'the shipped session tools start checked')
  await header().kids[0].props.onChange({ target: { checked: false } })
  const written = plain(scope.calls[0].ops)[0].value
  for (const name of ['session_search', 'session_trace', 'session_event_search', 'session_event_read', 'session_event_trace']) {
    assert.equal(written.includes(name), false, name + ' was removed by the group')
  }
})

test('a partly allowed group reports both counts and never claims to be complete', async () => {
  const scope = fakeScope({ initial: { allowedTools: ['session_search'] } })
  const panel = mountAllowed(scope)
  const header = panel.headers().find((node) => node.props['data-plugin-toggle'] === 'session')
  assert.equal(header.kids[0].props.checked, false, 'partial is not all')
  // The indeterminate dash is what tells the user the group is mixed.
  let marked = null
  const node = {}
  Object.defineProperty(node, 'indeterminate', {
    set: (value) => { marked = value },
    get: () => marked,
  })
  header.kids[0].props.ref(node)
  assert.equal(marked, true)
  const counts = header.kids[2]
  assert.equal(counts.kids[0], '1/5')
})

test('grouping never reorders the rows or the search results', async () => {
  // A grouped row keeps its place: the shipped order stays the published order, and an
  // extra tool keeps its alphabetical slot, so a search reads top to bottom as before.
  const scope = fakeScope({ initial: { toolCatalog: ['read', 'edit'] } })
  const panel = mountAllowed(scope)
  const all = panel.rows().map((row) => row.props['data-tool'])
  assert.deepEqual(all.slice(0, HOST_DEFAULT_ALLOWED_TOOLS.length), HOST_DEFAULT_ALLOWED_TOOLS)
  panel.search().props.onChange({ target: { value: 'session' } })
  assert.deepEqual(panel.rows().map((row) => row.props['data-tool']), [
    'session_search',
    'session_trace',
    'session_event_search',
    'session_event_read',
    'session_event_trace',
  ])
})

test('a single-word tool never merges into a group with anything else', () => {
  // A single-word name is not a plugin prefix, so it heads a group of exactly itself: the
  // header can only ever toggle that one row, and it never swallows a neighbouring tool.
  const panel = mountAllowed(fakeScope())
  const scope = fakeScope({ initial: { allowedTools: [] } })
  const grouped = mountAllowed(scope)
  for (const lone of ['delegate', 'orchestrate', 'compress']) {
    const header = grouped.headers().find((node) => node.props['data-plugin-toggle'] === lone)
    assert.notEqual(header, undefined, lone + ' heads its own group')
    // Exactly one tool under it: the count reads 0/1 for an empty whitelist.
    assert.equal(header.kids[2].kids[0], '0/1', lone + ' covers only itself')
  }
  // A real multi-tool plugin is still grouped under its prefix.
  const session = panel.headers().find((node) => node.props['data-plugin-toggle'] === 'session')
  assert.equal(session.kids[2].kids[0], '5/5')
})


// ---- Optimistic rendering --------------------------------------------------------------

test('a checkbox flips on the click, before the settings round trip answers', async () => {
  // The reported symptom: a click took about a second to show. The write is still a full
  // settings round trip, so the box must not wait for it; it flips immediately and the write
  // settles behind it.
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const scope = fakeScope()
  const mutate = scope.mutate
  scope.mutate = async (ops, expected) => {
    await gate
    return mutate(ops, expected)
  }
  const panel = mountAllowed(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'compress')
  assert.equal(row().kids[0].props.checked, true)
  const settled = row().kids[0].props.onChange({ target: { checked: false } })
  // The round trip has not answered yet, and the box has already moved.
  assert.equal(row().kids[0].props.checked, false, 'the box does not wait for the write')
  release()
  await settled
  assert.equal(row().kids[0].props.checked, false, 'the stored value agrees afterwards')
})

test('a refused write puts the box back where the profile still has it', async () => {
  // An optimistic box must never keep lying after the Host rejects the write.
  const scope = fakeScope({ reject: 'conflict' })
  const panel = mountAllowed(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'compress')
  await row().kids[0].props.onChange({ target: { checked: false } })
  // The stored value never changed, so the overlay is pointless: the box shows the profile.
  assert.equal(row().kids[0].props.checked, true, 'a rejected write is not shown as applied')
  assert.equal(nodes(panel.view.tree).some((node) => node.props?.role === 'alert'), true)
})

test('a group header flips its rows on the click as well', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const scope = fakeScope()
  const mutate = scope.mutate
  scope.mutate = async (ops, expected) => {
    await gate
    return mutate(ops, expected)
  }
  const panel = mountAllowed(scope)
  const header = () => panel.headers().find((node) => node.props['data-plugin-toggle'] === 'session')
  const settled = header().kids[0].props.onChange({ target: { checked: false } })
  assert.equal(header().kids[0].props.checked, false, 'the group box flips immediately')
  assert.equal(header().kids[2].kids[0], '0/5', 'and so do the rows under it')
  release()
  await settled
})
