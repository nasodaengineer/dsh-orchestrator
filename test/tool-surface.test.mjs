import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_ADMIN_TOOL, DELEGATE_TOOL, ORCHESTRATE_TOOL } from '../lib/api.js'
import { OFFICIAL_SHADOW, installToolSurface } from '../lib/tool-surface.js'

/**
 * The names a host would hand `definitions()`: a mixture of inherited globals and the
 * scope-local tools (`subagent`, the `ops_*` family) that `tools.restrict` cannot hide.
 */
const HOST_SURFACE = [
  'read',
  'glob',
  'grep',
  'edit',
  'bash',
  'ops_bash',
  'ops_edit_file',
  'ops_write_file',
  'subagent',
  'workflow',
  'delegate',
  'orchestrate',
  'orchestrator_agents',
  'send_message',
  'todo_write',
  'compress',
]

const ALLOWED = ['delegate', 'orchestrate', 'send_message', 'todo_write', 'compress']

const mainAgent = { id: 'main', options: {}, session: { header: {} } }
const childAgent = { id: 'child', options: { subagentDepth: 1 }, session: { header: {} } }
const resumedChild = { id: 'resumed', options: {}, session: { header: { delegationDepth: 1 } } }

/** A tools service with the one method the wrapper touches, plus a view of visible names. */
function fakeTools({ names = HOST_SURFACE, known = [], result } = {}) {
  const calls = []
  const service = {
    definitions(scope, toolSet) {
      calls.push([scope, toolSet])
      if (result !== undefined) return result
      return names.map((name) => ({ name }))
    },
    view: () => ({ knownNames: new Set(known), visible: new Map() }),
  }
  return { service, calls }
}

const namesOf = (list) => list.map((definition) => definition.name)

test('a main agent is offered only the live whitelist, own-scope tools included', () => {
  const { service } = fakeTools()
  const dispose = installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(mainAgent))
  assert.deepEqual(names, ALLOWED)
  // Everything a `restrict` could never hide is gone as well.
  for (const name of ['ops_bash', 'ops_edit_file', 'ops_write_file', 'subagent', 'workflow', 'read', 'edit']) {
    assert.equal(names.includes(name), false, name)
  }
  dispose()
})

test('run_code survives the filter, because PTC delegates through it', () => {
  const { service } = fakeTools({ names: [...HOST_SURFACE, 'run_code'] })
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(mainAgent))
  assert.equal(names.includes('run_code'), true)
  assert.equal(names.includes('edit'), false)
})

test('the whitelist is read per call, so a panel write lands on the next request', () => {
  const { service } = fakeTools()
  let allowed = [...ALLOWED]
  installToolSurface({ tools: service, allowed: () => allowed })
  assert.equal(namesOf(service.definitions(mainAgent)).includes('read'), false)

  allowed = [...ALLOWED, 'read']
  assert.equal(namesOf(service.definitions(mainAgent)).includes('read'), true)

  allowed = []
  assert.deepEqual(namesOf(service.definitions(mainAgent)), [])
})

test('the switch off hands the host surface back untouched, for a main agent and a child', () => {
  const { service } = fakeTools()
  let on = false
  installToolSurface({ tools: service, allowed: ALLOWED, enabled: () => on })
  assert.deepEqual(namesOf(service.definitions(mainAgent)), HOST_SURFACE)
  assert.deepEqual(namesOf(service.definitions(childAgent)), HOST_SURFACE)

  on = true
  assert.deepEqual(namesOf(service.definitions(mainAgent)), ALLOWED)
  assert.equal(namesOf(service.definitions(childAgent)).includes(DELEGATE_TOOL), false)
})

test('the context-global view is never filtered, so the panel keeps a complete catalog', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(namesOf(service.definitions()), HOST_SURFACE)
  assert.deepEqual(namesOf(service.definitions(undefined)), HOST_SURFACE)
  assert.deepEqual(namesOf(service.definitions(null)), HOST_SURFACE)
})

test('a child loses the plugin pair and keeps the native and scope-local tools', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: ALLOWED })
  for (const agent of [childAgent, resumedChild]) {
    const names = namesOf(service.definitions(agent))
    assert.equal(names.includes(DELEGATE_TOOL), false)
    assert.equal(names.includes(ORCHESTRATE_TOOL), false)
    for (const name of ['subagent', 'workflow', 'ops_bash', 'ops_edit_file', 'ops_write_file', 'read', 'edit']) {
      assert.equal(names.includes(name), true, `${name} on ${agent.id}`)
    }
  }
})

test('a child is masked even when the whitelist would have allowed the pair', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: [...ALLOWED, 'delegate', 'orchestrate'] })
  const names = namesOf(service.definitions(childAgent))
  assert.equal(names.includes('delegate'), false)
  assert.equal(names.includes('orchestrate'), false)
  assert.equal(names.includes('send_message'), true)
})

test('a child never sees the subagent-management tool, whatever the whitelist says', () => {
  // A worker that could list, message or interrupt its siblings would escape the planner's
  // authority, so the deny list wins over an allow list that names it.
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: [...ALLOWED, AGENT_ADMIN_TOOL] })
  for (const agent of [childAgent, resumedChild]) {
    const names = namesOf(service.definitions(agent))
    assert.equal(names.includes(AGENT_ADMIN_TOOL), false, agent.id)
  }
  // The main agent still gets it when the panel allows it.
  assert.equal(namesOf(service.definitions(mainAgent)).includes(AGENT_ADMIN_TOOL), true)
})

test('the admin tool is part of the default worker deny list', () => {
  const { service } = fakeTools({ names: [...HOST_SURFACE] })
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(childAgent))
  for (const name of [DELEGATE_TOOL, ORCHESTRATE_TOOL, AGENT_ADMIN_TOOL]) {
    assert.equal(names.includes(name), false, name)
  }
})

test('the leaked official tools are shadowed while their dsh-ops replacement exists', () => {
  // The async hide queue means a request can be assembled between "replacement registered"
  // and "official hidden": the wrapper filters the official name itself, so no request
  // ever sees the pair and the tool table never gains or loses three names.
  const { service } = fakeTools({ names: [...HOST_SURFACE, 'ops_inspect_local_file', 'ops_glob', 'ops_grep'] })
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(childAgent))
  for (const [official, replacement] of OFFICIAL_SHADOW) {
    assert.equal(names.includes(official), false, official)
    assert.equal(names.includes(replacement), true, replacement)
  }
})

test('the replacement is also read from the scope view, not only from the list', () => {
  const { service } = fakeTools({ known: ['ops_inspect_local_file'] })
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(childAgent))
  assert.equal(names.includes('read'), false, 'read is shadowed through the view')
  assert.equal(names.includes('glob'), true, 'no ops_glob registered, so glob stays')
})

test('without dsh-ops a child keeps the official read/glob/grep', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(childAgent))
  for (const name of ['read', 'glob', 'grep']) assert.equal(names.includes(name), true, name)
})

test('a main agent that checked an official tool still loses it to its replacement', () => {
  // `dsh-ops` hides `read` whatever the panel says; shadowing it here is the same answer,
  // so the request cannot see a tool the execution side would refuse anyway.
  const { service } = fakeTools({ names: [...HOST_SURFACE, 'ops_inspect_local_file'] })
  installToolSurface({ tools: service, allowed: [...ALLOWED, 'read'] })
  const names = namesOf(service.definitions(mainAgent))
  assert.equal(names.includes('read'), false)
  assert.equal(names.includes('ops_inspect_local_file'), false, 'not whitelisted')
})

test('custom deny and shadow lists are honoured', () => {
  const { service } = fakeTools()
  installToolSurface({
    tools: service,
    allowed: ALLOWED,
    workerDeny: ['workflow'],
    shadow: [['edit', 'ops_edit_file']],
  })
  const names = namesOf(service.definitions(childAgent))
  assert.equal(names.includes('workflow'), false)
  assert.equal(names.includes('edit'), false, 'the custom shadow pair applies too')
  assert.equal(names.includes('delegate'), true, 'the default pair is replaced, not merged')
})

test('dispose restores the original method and a second install is a no-op', () => {
  const { service, calls } = fakeTools()
  const original = service.definitions
  const dispose = installToolSurface({ tools: service, allowed: ALLOWED })
  assert.notEqual(service.definitions, original)

  const second = installToolSurface({ tools: service, allowed: ['edit'] })
  assert.equal(second, dispose, 'the second install hands back the first disposer')
  assert.equal(namesOf(service.definitions(mainAgent)).includes('read'), false, 'one wrapper only')

  dispose()
  assert.equal(service.definitions, original, 'the original method is back')
  dispose()
  assert.equal(service.definitions, original, 'a second dispose is harmless')
  assert.deepEqual(namesOf(service.definitions(mainAgent)), HOST_SURFACE)
  assert.deepEqual(calls[0], [mainAgent, undefined], 'scope and toolSet pass straight through')
})

test('a non-array result and a service without definitions are passed through safely', () => {
  const { service } = fakeTools({ result: { not: 'a list' } })
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(service.definitions(mainAgent), { not: 'a list' })

  const empty = installToolSurface({ tools: undefined, allowed: ALLOWED })
  assert.equal(typeof empty, 'function')
  empty()
  const noMethod = installToolSurface({ tools: {}, allowed: ALLOWED })
  assert.equal(typeof noMethod, 'function')
  noMethod()
})

test('an unreadable view never breaks the filter', () => {
  const service = {
    definitions: () => HOST_SURFACE.map((name) => ({ name })),
    view: () => {
      throw new Error('view is gone')
    },
  }
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(namesOf(service.definitions(mainAgent)), ALLOWED)
})

test('definitions without a name survive the filter instead of crashing it', () => {
  const service = {
    definitions: () => [{ type: 'opaque' }, { name: 'edit' }, { name: 'todo_write' }],
  }
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(namesOf(service.definitions(mainAgent)), [undefined, 'todo_write'])
})
