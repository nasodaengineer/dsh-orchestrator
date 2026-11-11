import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_ADMIN_TOOL } from '../lib/api.js'
import {
  ACTIONS,
  AGENT_ADMIN_SOURCE_KIND,
  createAgentAdmin,
  createLineage,
  lastSeq,
  readTurnState,
} from '../lib/agent-admin.js'

const DELIVER = Symbol.for('dsh.subagent.deliverPrompt')

/** A parent agent with a session id, plus the live registry it is looked up in. */
function fakeHost({
  parentId = 'parent-agent',
  parentSessionId = 'session-parent',
  descendents = [],
  listError,
  noListDescendants = false,
  liveAgents = new Map(),
  liveSessions = new Map(),
  delivered,
  interrupts = [],
  dispatch = new Map(),
} = {}) {
  const parent = { id: parentId, session: { id: parentSessionId, log: [] } }
  const calls = { list: [] }
  const agents = new Map(liveAgents)
  agents.set(parentId, parent)
  const subagents = {
    async listDescendants(rootSessionId, signal) {
      calls.list.push({ rootSessionId, signal })
      if (listError !== undefined) throw listError
      return descendents
    },
    interrupt(childId, authority) {
      interrupts.push({ childId, authority })
    },
  }
  if (noListDescendants) delete subagents.listDescendants
  if (delivered !== undefined) subagents[DELIVER] = delivered
  const tool = createAgentAdmin({
    defineTool: (spec) => spec,
    subagents,
    agents: { get: (id) => agents.get(id) },
    sessions: { get: (id) => liveSessions.get(id) },
    describeDispatch: (childId) => dispatch.get(childId),
  })
  return { tool, parent, agents, sessions: liveSessions, subagents, calls, interrupts }
}

const run = (host, args) =>
  host.tool.execute(args, { agent: host.parent, signal: new AbortController().signal })

const childRow = (id, extra = {}) => ({ kind: 'child', id, parentId: 'session-parent', depth: 1, activity: 'running', ...extra })

test('the tool is uniquely named and declares the four actions', () => {
  const host = fakeHost()
  assert.equal(host.tool.name, AGENT_ADMIN_TOOL)
  assert.equal(AGENT_ADMIN_TOOL, 'orchestrator_agents')
  // The name must not shadow the host's own per-agent tools.
  for (const name of ['send_message', 'interrupt_agent', 'list_agents']) {
    assert.notEqual(AGENT_ADMIN_TOOL, name)
  }
  assert.deepEqual([...ACTIONS], ['list', 'status', 'send', 'interrupt'])
  assert.deepEqual(host.tool.parameters.action.enum, [...ACTIONS])
  assert.equal(host.tool.parameters.action.required, true)
  // Read-only actions may overlap; the mutating pair must not.
  assert.equal(host.tool.isConcurrencySafe({ action: 'list' }), true)
  assert.equal(host.tool.isConcurrencySafe({ action: 'status' }), true)
  assert.equal(host.tool.isConcurrencySafe({ action: 'send' }), false)
  assert.equal(host.tool.isConcurrencySafe({ action: 'interrupt' }), false)
})

test('an unknown action is refused before any runtime call', async () => {
  const host = fakeHost({ descendents: [childRow('child-1')] })
  await assert.rejects(() => run(host, { action: 'explode' }), /"action" must be one of list, status, send, interrupt/)
  assert.deepEqual(host.calls.list, [], 'nothing was read')
})

test('a call without a calling agent or session id is refused', async () => {
  const host = fakeHost()
  await assert.rejects(() => host.tool.execute({ action: 'list' }, {}), /requires a calling agent/)
  const noSession = { agent: { id: 'x' }, signal: new AbortController().signal }
  await assert.rejects(() => host.tool.execute({ action: 'list' }, noSession), /session id/)
})

test('list reads descendants of the calling session and joins the dispatch record', async () => {
  const host = fakeHost({
    descendents: [
      childRow('child-1'),
      childRow('child-2', { depth: 2, parentId: 'child-1', hasChildren: false }),
      { kind: 'diagnostic', id: 'child-3', parentId: 'session-parent', depth: 1, reason: 'corrupt' },
    ],
    dispatch: new Map([['child-1', { label: '慢活', startedAt: 1700000000000 }]]),
  })
  const value = await run(host, { action: 'list' })
  assert.equal(value.action, 'list')
  assert.equal(value.parentSessionId, 'session-parent')
  assert.equal(host.calls.list[0].rootSessionId, 'session-parent', 'the calling session is the root')
  assert.equal(value.count, 2)
  assert.equal(value.diagnostics.length, 1)
  assert.equal(value.diagnostics[0].reason, 'corrupt')
  const [first, second] = value.descendants
  assert.equal(first.id, 'child-1')
  assert.equal(first.dispatchedByOrchestrator, true)
  assert.equal(first.label, '慢活')
  assert.equal(first.startedAt, 1700000000000)
  assert.equal(first.catalogActivity, 'running', 'the catalog field is carried verbatim')
  assert.equal(second.dispatchedByOrchestrator, false)
  assert.equal(second.label, undefined)
  // "running" in the catalog means the Session is resident, so it is never the turn state.
  assert.equal('turnState' in first, false)
})

test('list reports an unsupported host instead of pretending the catalog is empty', async () => {
  const host = fakeHost({ noListDescendants: true })
  await assert.rejects(() => run(host, { action: 'list' }), /does not expose subagents.listDescendants/)
})

test('list surfaces a catalog read failure as an error, never as zero descendants', async () => {
  const host = fakeHost({ listError: new Error('SUBAGENT_CONTROL_QUERY_UNAVAILABLE') })
  await assert.rejects(() => run(host, { action: 'list' }), /SUBAGENT_CONTROL_QUERY_UNAVAILABLE/)
})

test('status separates Agent residency, Session presence and turn state', async () => {
  const log = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } },
  ]
  const host = fakeHost({
    descendents: [childRow('child-1')],
    liveAgents: new Map([['child-1', { id: 'child-1', session: { id: 'child-1', log } }]]),
    liveSessions: new Map([['child-1', { id: 'child-1', log }]]),
    dispatch: new Map([['child-1', { label: '慢活', startedAt: 42, taskKey: 't-1', writeScope: ['lib/a'] }]]),
  })
  const value = await run(host, { action: 'status', childId: 'child-1' })
  assert.equal(value.authorized, true)
  assert.equal(value.dispatchedByOrchestrator, true)
  assert.equal(value.taskKey, 't-1')
  assert.deepEqual(value.writeScope, ['lib/a'])
  assert.equal(value.agentPresence, 'resident')
  assert.equal(value.sessionPresence, 'loaded')
  assert.equal(value.turnState, 'idle')
  assert.equal(value.hostRunState, 'unknown', 'a paired log still proves nothing about the host')
  assert.equal(value.lastTurnReason, 'completed')
  assert.equal(value.seq, 2)
  // The claim this tool must never make: a resident Agent is not a running turn.
  assert.equal(value.running, undefined)
  assert.equal(value.agent, undefined, 'the old ambiguous field name is gone')
  assert.equal(value.session, undefined)
  assert.equal(value.catalogActivity, 'running', 'reported under a name that cannot be misread')
})

test('status says unknown when no session is loaded, and idle for an empty log', async () => {
  const noSession = fakeHost({ descendents: [childRow('child-1')] })
  const value = await run(noSession, { action: 'status', childId: 'child-1' })
  assert.equal(value.agentPresence, 'absent')
  assert.equal(value.sessionPresence, 'absent')
  assert.equal(value.turnState, 'unknown')
  assert.equal(value.hostRunState, 'unknown')
  assert.match(value.reason, /no live session/)

  const emptyLog = fakeHost({
    descendents: [childRow('child-1')],
    liveSessions: new Map([['child-1', { id: 'child-1', log: [] }]]),
  })
  const idle = await run(emptyLog, { action: 'status', childId: 'child-1' })
  assert.equal(idle.turnState, 'idle')
  assert.equal(idle.seq, 0)
  assert.match(idle.reason, /no turn has been recorded/)

  const unreadable = fakeHost({
    descendents: [childRow('child-1')],
    liveSessions: new Map([['child-1', { id: 'child-1' }]]),
  })
  assert.equal((await run(unreadable, { action: 'status', childId: 'child-1' })).turnState, 'unknown')
})

test('a turn/start without its turn/end is reported as turnStarted, never as running', () => {
  const value = readTurnState({ log: [{ type: 'turn/start', seq: 4, data: { turn: 2 } }] })
  assert.equal(value.turnState, 'turnStarted')
  assert.equal(value.openTurn, 2)
  assert.equal(value.seq, 4)
  // The distinction the wording has to keep: the log recorded a start, the host is unproven.
  assert.equal(value.hostRunState, 'unknown')
  assert.match(value.reason, /turn\/start for turn 2 with no matching turn\/end/)
  assert.match(value.reason, /not proof that the host is running a turn now/)
  // No field may read as a live execution state.
  for (const forbidden of ['running', 'active', 'busy', 'executing']) {
    assert.equal(value[forbidden], undefined, forbidden)
  }
  assert.equal(value.turnState.includes('open'), false)
})

test('turn ids pair by id, so an end closes only its own turn', () => {
  const balanced = readTurnState({
    log: [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } },
    ],
  })
  assert.equal(balanced.turnState, 'idle')
  assert.equal(balanced.lastTurnReason, 'completed')

  // A later turn opens while an earlier one is still open: the older one stays open, so the
  // current turn is not identifiable and the answer is unknown rather than a guess.
  const twoOpen = readTurnState({
    log: [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'turn/start', seq: 2, data: { turn: 2 } },
    ],
  })
  assert.equal(twoOpen.turnState, 'unknown')
  assert.deepEqual(twoOpen.openTurns, [1, 2])
  assert.match(twoOpen.reason, /turns are open at once/)

  // An end that arrives before its start leaves the start open: the ids never paired.
  const outOfOrder = readTurnState({
    log: [
      { type: 'turn/end', seq: 1, data: { turn: 1 } },
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
    ],
  })
  assert.equal(outOfOrder.turnState, 'unknown')
  assert.match(outOfOrder.reason, /out of order/)
  assert.match(outOfOrder.reason, /without a matching turn\/start/)
})

test('an unpairable turn log is unknown, because neither idle nor turnStarted is provable', () => {
  // An end for a turn that was never opened.
  const orphanEnd = readTurnState({ log: [{ type: 'turn/end', seq: 3, data: { turn: 7 } }] })
  assert.equal(orphanEnd.turnState, 'unknown')
  assert.match(orphanEnd.reason, /turn\/end for turn 7/)

  // The same turn started twice without an end in between.
  const doubleStart = readTurnState({
    log: [
      { type: 'turn/start', seq: 1, data: { turn: 5 } },
      { type: 'turn/start', seq: 2, data: { turn: 5 } },
    ],
  })
  assert.equal(doubleStart.turnState, 'unknown')
  assert.match(doubleStart.reason, /started twice/)

  // An event that carries no readable turn id cannot be paired with anything.
  const unlabelled = readTurnState({ log: [{ type: 'turn/start', seq: 1, data: {} }] })
  assert.equal(unlabelled.turnState, 'unknown')
  assert.match(unlabelled.reason, /no readable turn id/)

  assert.equal(lastSeq([{ seq: 3 }, { seq: 9 }, { seq: 4 }]), 9)
  assert.equal(lastSeq(undefined), 0)
})

test('status refuses a child that is not a descendant, and refuses the caller itself', async () => {
  const host = fakeHost({ descendents: [childRow('child-1')] })
  await assert.rejects(() => run(host, { action: 'status', childId: 'someone-else' }), /is not a descendant of the calling session session-parent/)
  await assert.rejects(() => run(host, { action: 'status', childId: 'session-parent' }), /is the calling agent itself/)
  await assert.rejects(() => run(host, { action: 'status' }), /"childId" must be a non-empty string/)
})

test('status reports authorized:false when the host cannot enumerate lineage', async () => {
  const host = fakeHost({ noListDescendants: true })
  const value = await run(host, { action: 'status', childId: 'child-1' })
  assert.equal(value.authorized, false)
  assert.match(value.reason, /does not expose subagents.listDescendants/)
})

test('send queues ordinary text through the plugin channel with its own source', async () => {
  const delivered = []
  const host = fakeHost({
    descendents: [childRow('child-1')],
    delivered: async (...callArgs) => {
      delivered.push(callArgs)
      return 'message-77'
    },
  })
  const value = await run(host, { action: 'send', childId: 'child-1', text: '  改一下 lib/a.js  ' })
  assert.equal(delivered.length, 1)
  const [sender, childId, content, source, signal, delivery] = delivered[0]
  assert.equal(sender, host.parent, 'the exact live parent agent is the sender')
  assert.equal(childId, 'child-1')
  assert.deepEqual(content, [{ type: 'text', text: '  改一下 lib/a.js  ' }], 'text is passed through verbatim')
  assert.deepEqual(source, { kind: AGENT_ADMIN_SOURCE_KIND, form: 'notice' })
  // It must be its own kind, never the retry or supervision kind.
  assert.notEqual(source.kind, 'retry')
  assert.equal(delivery, 'queue', 'a new turn, not a steer')
  assert.ok(signal !== undefined)
  assert.equal(value.delivered, true)
  assert.equal(value.messageId, 'message-77')
  assert.equal(value.childId, 'child-1')
})

test('send proves lineage before delivering and refuses a foreign session', async () => {
  const delivered = []
  const host = fakeHost({
    descendents: [childRow('child-1')],
    delivered: async () => {
      delivered.push(1)
      return 'm'
    },
  })
  await assert.rejects(() => run(host, { action: 'send', childId: 'foreign', text: 'hi' }), /arbitrary|is not a descendant/)
  assert.deepEqual(delivered, [], 'nothing is delivered to a non-descendant')
  await assert.rejects(() => run(host, { action: 'send', childId: 'child-1' }), /"text" must be a non-empty string/)
  await assert.rejects(() => run(host, { action: 'send', childId: 'child-1', text: '   ' }), /"text" must be a non-empty string/)
  assert.deepEqual(delivered, [])
})

test('send refuses a grandchild: only a direct child is authorised', async () => {
  const delivered = []
  const host = fakeHost({
    descendents: [childRow('child-1'), childRow('grandchild-1', { depth: 2, parentId: 'child-1' })],
    delivered: async () => {
      delivered.push(1)
      return 'm'
    },
  })
  const error = await run(host, { action: 'send', childId: 'grandchild-1', text: 'hi' }).then(
    () => undefined,
    (reason) => reason,
  )
  assert.ok(error instanceof Error, 'a grandchild must be refused')
  // The refusal must name the depth and the route, and must not read as a delivery receipt.
  assert.match(error.message, /at depth 2/)
  assert.match(error.message, /direct child \(depth 1\)/)
  assert.match(error.message, /nothing was delivered/)
  assert.match(error.message, /contact the direct parent/)
  assert.doesNotMatch(error.message, /queued|delivered: true|messageId/)
  assert.deepEqual(delivered, [], 'nothing is delivered to a grandchild')
})

test('interrupt refuses a grandchild without submitting a signal', async () => {
  const host = fakeHost({
    descendents: [childRow('child-1'), childRow('grandchild-1', { depth: 2, parentId: 'child-1' })],
  })
  const error = await run(host, { action: 'interrupt', childId: 'grandchild-1' }).then(
    () => undefined,
    (reason) => reason,
  )
  assert.ok(error instanceof Error, 'a grandchild must be refused')
  assert.match(error.message, /at depth 2/)
  assert.match(error.message, /direct child \(depth 1\)/)
  assert.match(error.message, /nothing was interrupted/)
  assert.match(error.message, /contact the direct parent/)
  assert.doesNotMatch(error.message, /interrupt submitted|signalSubmitted|stop is unconfirmed/)
  assert.deepEqual(host.interrupts, [], 'no signal reaches the runtime')
})

test('a direct child keeps working for both mutating actions', async () => {
  const delivered = []
  const host = fakeHost({
    descendents: [childRow('child-1'), childRow('grandchild-1', { depth: 2, parentId: 'child-1' })],
    delivered: async (...callArgs) => {
      delivered.push(callArgs)
      return 'message-9'
    },
  })
  const sent = await run(host, { action: 'send', childId: 'child-1', text: 'go' })
  assert.equal(sent.delivered, true)
  assert.equal(sent.messageId, 'message-9')
  assert.equal(delivered.length, 1)
  const interrupted = await run(host, { action: 'interrupt', childId: 'child-1' })
  assert.equal(interrupted.signalSubmitted, true)
  assert.equal(host.interrupts.length, 1)
})

test('lineage is checked before depth, so a foreign id is still refused as foreign', async () => {
  const host = fakeHost({ descendents: [childRow('grandchild-1', { depth: 2, parentId: 'x' })] })
  await assert.rejects(() => run(host, { action: 'send', childId: 'foreign', text: 'hi' }), /is not a descendant/)
  await assert.rejects(() => run(host, { action: 'interrupt', childId: 'foreign' }), /is not a descendant/)
})

test('status still describes a grandchild, even though send and interrupt refuse it', async () => {
  const host = fakeHost({
    descendents: [childRow('child-1'), childRow('grandchild-1', { depth: 2, parentId: 'child-1' })],
  })
  const value = await run(host, { action: 'status', childId: 'grandchild-1' })
  assert.equal(value.authorized, true)
  assert.equal(value.depth, 2)
})

test('send fails clearly when the host exposes no delivery channel', async () => {
  const host = fakeHost({ descendents: [childRow('child-1')] })
  await assert.rejects(() => run(host, { action: 'send', childId: 'child-1', text: 'hi' }), /does not expose the plugin prompt delivery channel/)
  assert.equal(host.subagents[DELIVER], undefined)
})

test('send refuses when the calling agent is not live', async () => {
  const host = fakeHost({
    descendents: [childRow('child-1')],
    delivered: async () => 'm',
  })
  host.agents.delete('parent-agent')
  await assert.rejects(() => run(host, { action: 'send', childId: 'child-1', text: 'hi' }), /is not live/)
})

test('interrupt submits the ancestor signal and never claims the child stopped', async () => {
  const host = fakeHost({ descendents: [childRow('child-1')] })
  const value = await run(host, { action: 'interrupt', childId: 'child-1' })
  assert.equal(host.interrupts.length, 1)
  assert.equal(host.interrupts[0].childId, 'child-1')
  assert.equal(host.interrupts[0].authority.kind, 'ancestor')
  assert.equal(host.interrupts[0].authority.agent, host.parent, 'the authority is the exact live parent')
  assert.equal(value.signalSubmitted, true)
  assert.equal(value.stopped, 'unknown')
  assert.match(value.note, /Whether the subagent has stopped is not confirmed/)
  // No field may assert the outcome.
  assert.equal(value.interrupted, undefined)
  assert.equal(value.done, undefined)
})

test('interrupt refuses a non-descendant before calling the runtime', async () => {
  const host = fakeHost({ descendents: [childRow('child-1')] })
  await assert.rejects(() => run(host, { action: 'interrupt', childId: 'foreign' }), /is not a descendant/)
  assert.deepEqual(host.interrupts, [])
})

test('an authorization failure from the runtime is reported, not swallowed', async () => {
  const host = fakeHost({ descendents: [childRow('child-1')] })
  host.subagents.interrupt = () => {
    const error = new Error('interrupting "child-1" requires the exact live ancestor agent')
    error.code = 'UNAUTHORIZED'
    throw error
  }
  await assert.rejects(() => run(host, { action: 'interrupt', childId: 'child-1' }), /requires the exact live ancestor agent/)
})

test('interrupt fails clearly when the host cannot interrupt at all', async () => {
  const host = fakeHost({ descendents: [childRow('child-1')] })
  delete host.subagents.interrupt
  await assert.rejects(() => run(host, { action: 'interrupt', childId: 'child-1' }), /does not expose subagents.interrupt/)
})

test('lineage is the only authority: it is read from listDescendants, never subagents.list()', () => {
  const listed = []
  let providerListCalled = false
  const lineage = createLineage({
    subagents: {
      async listDescendants(root, signal) {
        listed.push({ root, signal })
        return [childRow('child-1')]
      },
      list() {
        providerListCalled = true
        return ['spawn', 'in-process']
      },
    },
  })
  assert.equal(lineage.supported, true)
  return lineage.find('session-parent', 'child-1', undefined).then((row) => {
    assert.equal(row.id, 'child-1')
    assert.equal(listed[0].root, 'session-parent')
    assert.equal(providerListCalled, false, 'provider names are never used as an agent list')
  })
})

test('a diagnostic row is never treated as an authorised child', async () => {
  const host = fakeHost({ descendents: [{ kind: 'diagnostic', id: 'child-9', parentId: 'session-parent', depth: 1, reason: 'unsupported' }] })
  await assert.rejects(() => run(host, { action: 'status', childId: 'child-9' }), /is not a descendant/)
})
