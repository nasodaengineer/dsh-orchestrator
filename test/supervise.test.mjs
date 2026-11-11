import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SUPERVISE_SOURCE_KIND,
  composeNotice,
  createSupervisor,
  summarize,
} from '../lib/supervise.js'

const E = (seq, type, data = {}, time = seq) => ({ seq, type, data, time })
const call = (seq, name, args, time = seq) =>
  E(seq, 'tool/call', args === undefined ? { name } : { name, arguments: args }, time)

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test('summarize counts turns, steps, new tool calls and new events', () => {
  const events = [
    E(1, 'turn/start', {}, 1_000),
    E(2, 'step/start', {}, 1_100),
    call(3, 'read', { path: 'a' }, 1_200),
    E(4, 'tool/result', {}, 1_300),
    E(5, 'assistant/message', { message: 'hello' }, 1_400),
    E(6, 'step/start', {}, 1_500),
    call(7, 'grep', { pattern: 'x' }, 1_600),
    E(8, 'assistant/message', { message: 'done' }, 1_700),
  ]

  const summary = summarize(events, { sinceSeq: 3, now: 2_000, startedAt: 500 })
  assert.equal(summary.turns, 1)
  assert.equal(summary.steps, 2)
  assert.equal(summary.runMs, 1_500)
  assert.equal(summary.toolCalls, 1)
  assert.equal(summary.newEvents, 5)
  assert.equal(summary.lastTool, 'grep')
  assert.equal(summary.lastToolAt, 1_600)
  assert.equal(summary.lastText, 'done')
  assert.equal(summary.lastSeq, 8)
  assert.equal(summary.lastActivityAt, 1_700)
  assert.equal(summary.repeated, 1)
})

test('summarize reads assistant text from a string and from a content array', () => {
  const fromString = summarize([E(1, 'assistant/message', { message: 'plain text' })])
  assert.equal(fromString.lastText, 'plain text')

  const fromArray = summarize([
    E(1, 'assistant/message', {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'tool_use', name: 'read' },
          { type: 'text', text: 'world' },
        ],
      },
    }),
  ])
  assert.equal(fromArray.lastText, 'hello world')

  const fromContent = summarize([
    E(1, 'assistant/message', { content: [{ type: 'text', text: 'via content' }] }),
  ])
  assert.equal(fromContent.lastText, 'via content')
})

test('summarize truncates lastText to about 300 characters', () => {
  const long = 'x'.repeat(600)
  const summary = summarize([E(1, 'assistant/message', { message: long })])
  assert.equal(summary.lastText.length, 300)
  assert.equal(summary.lastText.endsWith('…'), true)
})

test('summarize tolerates missing fields and malformed events', () => {
  const summary = summarize(
    [null, undefined, {}, { type: 'tool/call' }, { type: 'tool/call', data: 'nope' }, { type: 'assistant/message' }],
    { sinceSeq: 0, now: 10, startedAt: 0 },
  )
  assert.equal(summary.turns, 0)
  assert.equal(summary.steps, 0)
  assert.equal(summary.toolCalls, 0)
  assert.equal(summary.newEvents, 0)
  assert.equal(summary.lastSeq, 0)
  assert.equal(summary.lastText, '')
  assert.equal(summary.lastTool, undefined)
  assert.equal(summary.repeated, 0)
  assert.equal(summary.runMs, 10)
  assert.doesNotThrow(() => summarize(undefined))
  assert.doesNotThrow(() => summarize([], { now: undefined, startedAt: undefined }))
})

test('summarize detects a consecutive repeated tool call and ignores argument key order', () => {
  const summary = summarize([
    call(1, 'read', { path: 'a', limit: 2 }),
    call(2, 'read', { limit: 2, path: 'a' }),
    call(3, 'read', { path: 'a', limit: 2 }),
    call(4, 'read', { path: 'b', limit: 2 }),
  ])
  assert.equal(summary.repeated, 3)
  assert.equal(summary.toolCalls, 4)
})

test('summarize breaks a repeat streak when the arguments change', () => {
  const summary = summarize([call(1, 'read', { path: 'a' }), call(2, 'read', { path: 'a' }), call(3, 'read', { path: 'b' })])
  assert.equal(summary.repeated, 2)

  const inputShape = summarize([
    E(1, 'tool/call', { name: 'read', input: { path: 'a' } }),
    E(2, 'tool/call', { name: 'read', input: { path: 'a' } }),
    E(3, 'tool/call', { name: 'read', input: { path: 'a' } }),
  ])
  assert.equal(inputShape.repeated, 3)
})

// ---------------------------------------------------------------------------
// composeNotice
// ---------------------------------------------------------------------------

const NOW = 1_000_000
const row = (overrides = {}) => ({
  childId: 'c1',
  label: '修复登录',
  startedAt: NOW - (23 * 60 + 41) * 1000,
  turns: 2,
  steps: 5,
  toolCalls: 3,
  lastTool: 'read',
  lastText: '正在检查',
  repeated: 0,
  newEvents: 1,
  ...overrides,
})

test('composeNotice writes the required header, with and without a budget', () => {
  const capped = composeNotice([row()], { now: NOW, index: 2, max: 5 })
  assert.equal(
    capped.startsWith('【插件巡检｜第 2/5 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。'),
    true,
  )

  const unlimited = composeNotice([row()], { now: NOW, index: 2, max: 0 })
  assert.equal(
    unlimited.startsWith('【插件巡检｜第 2 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。'),
    true,
  )
  assert.equal(unlimited.includes('2/0'), false)
})

test('composeNotice lists id, label, duration, turns, steps, new tools and text', () => {
  const text = composeNotice([row()], { now: NOW, index: 1, max: 3 })
  assert.equal(text.includes('c1'), true)
  assert.equal(text.includes('修复登录'), true)
  assert.equal(text.includes('23m41s'), true)
  assert.equal(text.includes('轮次 2 ｜ 步骤 5'), true)
  assert.equal(text.includes('自上次巡检新增工具调用 3 次'), true)
  assert.equal(text.includes('最近工具：read'), true)
  assert.equal(text.includes('最后输出：正在检查'), true)
  assert.equal(text.includes('请对每个子代理作出决定'), true)
  assert.equal(text.includes('巡检：正常'), true)
})

test('the notice points at the whitelisted admin tool and never at send_message', () => {
  const text = composeNotice([row()], { now: NOW, index: 1, max: 3 })
  // The main agent's whitelist has no `send_message` / `interrupt_agent`; a notice that named
  // them sent the model into a refused call it then had to recover from.
  assert.equal(text.includes('send_message'), false)
  assert.equal(text.includes('interrupt_agent'), false)
  assert.match(text, /orchestrator_agents（action=send/)
  assert.match(text, /orchestrator_agents（action=interrupt）/)
  // `interrupt` submits a signal; it must never read as a confirmed stop.
  assert.match(text, /不保证子代理已经停止/)
})

test('composeNotice warns about a loop and marks a child with no new activity', () => {
  const text = composeNotice([row({ repeated: 4, newEvents: 0 })], { now: NOW, index: 1, max: 3 })
  assert.equal(text.includes('检测到同一工具调用连续重复 4 次，可能原地打转'), true)
  assert.equal(text.includes('（自上次巡检无新活动）'), true)

  const quiet = composeNotice([row({ repeated: 2, newEvents: 0 })], { now: NOW, index: 1, max: 3 })
  assert.equal(quiet.includes('可能原地打转'), false)
  assert.equal(quiet.includes('（自上次巡检无新活动）'), true)
})

test('composeNotice stays under maxChars by shortening text first, then dropping children', () => {
  const rows = [row({ childId: 'c1' }), row({ childId: 'c2' }), row({ childId: 'c3' })]
  for (const item of rows) item.lastText = 'y'.repeat(300)

  const text = composeNotice(rows, { now: NOW, index: 1, max: 3, maxChars: 280 })
  assert.equal(text.length <= 280, true)
  assert.match(text, /另有 \d+ 个子代理未列出/)
})

test('composeNotice keeps every child when only the summaries need shortening', () => {
  const rows = [row({ childId: 'c1' }), row({ childId: 'c2' })]
  for (const item of rows) item.lastText = 'z'.repeat(300)

  // The budget only has to be big enough for two full child blocks plus the hint; the point
  // of this case is that shortening the summaries keeps both children in the notice.
  const text = composeNotice(rows, { now: NOW, index: 1, max: 3, maxChars: 600 })
  assert.equal(text.length <= 600, true)
  assert.equal(text.includes('c1'), true)
  assert.equal(text.includes('c2'), true)
  assert.equal(text.includes('另有 1 个子代理未列出'), false)
  assert.equal(text.includes('最后输出：'), true)
})

test('composeNotice hard-caps even a tiny maxChars', () => {
  const text = composeNotice([row()], { now: NOW, index: 1, max: 3, maxChars: 10 })
  assert.equal(text.length, 10)
})

// ---------------------------------------------------------------------------
// createSupervisor
// ---------------------------------------------------------------------------

function harness({ config: configOverrides = {} } = {}) {
  let clock = 1_000_000
  const config = {
    enabled: true,
    intervalSeconds: 600,
    maxNoticesPerChild: 3,
    unlimited: false,
    notifyOnNoProgress: false,
    repeatThreshold: 3,
    noticeMaxChars: 2000,
    ...configOverrides,
  }
  const events = new Map()
  const aliveChildren = new Set()
  const aliveParents = new Set()
  const pending = new Set()
  const deliveries = []
  const warnings = []

  const opts = {
    config,
    now: () => clock,
    isParentAlive: (parentId) => aliveParents.has(parentId),
    isChildAlive: (childId) => aliveChildren.has(childId),
    readEvents: (childId) => events.get(childId) ?? [],
    hasPendingNotice: (parentId) => pending.has(parentId),
    deliver: async (parentId, text, childIds) => {
      deliveries.push({ parentId, text, childIds: [...childIds] })
      return 'queued'
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
  }

  const sup = createSupervisor(opts)

  const add = (childId, parentId = 'p1', label = 'task', startedAt = clock) => {
    aliveParents.add(parentId)
    aliveChildren.add(childId)
    sup.track({ childId, parentId, label, startedAt })
  }

  return {
    sup,
    config,
    opts,
    events,
    aliveChildren,
    aliveParents,
    pending,
    deliveries,
    warnings,
    at: () => clock,
    advance: (ms) => {
      clock += ms
    },
    setClock: (value) => {
      clock = value
    },
    add,
  }
}

test('SUPERVISE_SOURCE_KIND is the dedupe key the wiring will use', () => {
  assert.equal(SUPERVISE_SOURCE_KIND, 'orchestrator-supervision')
})

test('createSupervisor defaults to a 600 second (10 minute) interval', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(10 * 60_000 - 1_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.sup.size(), 1)

  h.advance(1_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].childIds[0], 'c1')
  assert.match(h.deliveries[0].text, /第 1\/3 次/)
})

test('createSupervisor does not notify before the deadline', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)
})

test('a finished child is forgotten without a notice', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])
  h.aliveChildren.delete('c1')

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.sup.size(), 0)
})

test('a vanished parent discards every child registered under it', async () => {
  const h = harness()
  h.add('c1', 'p1')
  h.add('c2', 'p1')
  h.aliveParents.delete('p1')

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.sup.size(), 0)
})

test('several due children of one parent merge into one deliver call', async () => {
  const h = harness()
  h.add('c1', 'p1', 'first')
  h.add('c2', 'p1', 'second')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])
  h.events.set('c2', [call(1, 'grep', { pattern: 'b' })])

  h.advance(10 * 60_000)
  await h.sup.tick()

  assert.equal(h.deliveries.length, 1)
  assert.deepEqual(h.deliveries[0].childIds, ['c1', 'c2'])
  assert.equal(h.deliveries[0].text.includes('c1'), true)
  assert.equal(h.deliveries[0].text.includes('c2'), true)
  assert.match(h.deliveries[0].text, /第 1\/3 次/)
})

test('the per-child notice budget stops at three but keeps the child registered', async () => {
  const h = harness({ config: { notifyOnNoProgress: true } })
  h.add('c1')
  h.events.set('c1', [])

  for (let i = 0; i < 3; i += 1) {
    h.advance(10 * 60_000)
    await h.sup.tick()
  }
  assert.equal(h.deliveries.length, 3)
  assert.equal(h.sup.size(), 1)

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 3)
  // The spent budget must not forget the child: raising it mid-run has to resume
  // supervision of the worker that is still running.
  assert.equal(h.sup.size(), 1)

  h.config.maxNoticesPerChild = 5
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 4)
  assert.match(h.deliveries[3].text, /第 4\/5 次/)
})

test('no new activity does not notify but still advances the deadline', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [])

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.sup.size(), 1)

  // New activity right now would be due if the deadline had not moved.
  h.events.set('c1', [call(1, 'read', { path: 'a' })])
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
})

test('a live loop notifies even when there are no new events', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [
    call(1, 'read', { path: 'a' }),
    call(2, 'read', { path: 'a' }),
    call(3, 'read', { path: 'a' }),
  ])

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].text.includes('可能原地打转'), true)

  // lastSeq is now 3, so the second tick has no new events but still sees the loop.
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 2)
  assert.equal(h.deliveries[1].text.includes('检测到同一工具调用连续重复 3 次'), true)
  assert.equal(h.deliveries[1].text.includes('（自上次巡检无新活动）'), true)
})

test('an already pending notice skips the parent without spending budget', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])
  h.pending.add('p1')

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.sup.size(), 1)

  // The skipped deadline moved one interval, so the same instant is not retried.
  h.pending.delete('p1')
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /第 1\/3 次/)
})

test("deliver returning 'parent-gone' drops every registration of that parent", async () => {
  const h = harness()
  let attempts = 0
  h.opts.deliver = async () => {
    attempts += 1
    return 'parent-gone'
  }
  h.add('c1', 'p1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(attempts, 1)
  assert.equal(h.sup.size(), 0)
})

test("deliver returning 'already-pending' skips the batch without spending budget", async () => {
  const h = harness()
  let attempts = 0
  h.opts.deliver = async (parentId, text) => {
    attempts += 1
    h.deliveries.push({ parentId, text })
    return 'already-pending'
  }
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(attempts, 1)
  assert.equal(h.sup.size(), 1)

  await h.sup.tick()
  assert.equal(attempts, 1)

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(attempts, 2)
  assert.match(h.deliveries[1].text, /第 1\/3 次/)
})

test('a throwing deliver is logged, spends no budget and retries next interval', async () => {
  const h = harness()
  let attempts = 0
  h.opts.deliver = async (parentId, text) => {
    attempts += 1
    if (attempts === 1) throw new Error('deliver blew up')
    h.deliveries.push({ parentId, text })
    return 'queued'
  }
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(attempts, 1)
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.sup.size(), 1)
  assert.equal(h.warnings.some((message) => message.includes('deliver blew up')), true)

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(attempts, 2)
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /第 1\/3 次/)
})

test('readEvents throwing only skips that one child', async () => {
  const h = harness()
  h.add('bad', 'p1')
  h.add('good', 'p1')
  h.events.set('good', [call(1, 'read', { path: 'a' })])
  h.opts.readEvents = (childId) => {
    if (childId === 'bad') throw new Error('cannot read bad')
    return h.events.get(childId) ?? []
  }

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.deepEqual(h.deliveries[0].childIds, ['good'])
  assert.equal(h.sup.size(), 2)
  assert.equal(h.warnings.some((message) => message.includes('cannot read bad')), true)
})

test('enabled=false does nothing at all, then resumes when re-enabled', async () => {
  const h = harness({ config: { enabled: false } })
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(20 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.sup.size(), 1)

  h.config.enabled = true
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
})

test('shrinking the interval from 600 to 30 seconds applies on the very next tick', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(60_000)
  h.config.intervalSeconds = 30
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /第 1\/3 次/)
})

test('the shortest allowed interval, 10 seconds, is honoured', async () => {
  const h = harness({ config: { intervalSeconds: 10 } })
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(9_999)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)

  h.advance(1)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
})

test('growing the interval in config delays the next notice', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' })])

  h.advance(60_000)
  h.config.intervalSeconds = 1200
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0)

  h.advance(19 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
})

test('a higher repeatThreshold suppresses the loop warning', async () => {
  const h = harness({ config: { repeatThreshold: 5 } })
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' }), call(2, 'read', { path: 'a' }), call(3, 'read', { path: 'a' })])

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].text.includes('可能原地打转'), false)
})

test('maxNoticesPerChild=0 turns supervision off but keeps the registry', async () => {
  const h = harness({ config: { notifyOnNoProgress: true, maxNoticesPerChild: 0 } })
  h.add('c1')
  h.events.set('c1', [])

  for (let i = 0; i < 4; i += 1) {
    h.advance(10 * 60_000)
    await h.sup.tick()
  }
  assert.equal(h.deliveries.length, 0, 'a zero budget sends nothing')
  assert.equal(h.sup.size(), 1, 'the running child stays registered')

  // Raising the budget mid-run resumes supervision of that same child at once: the
  // deadline was left in the past, so no extra interval has to elapse.
  h.config.maxNoticesPerChild = 2
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /第 1\/2 次/)

  // And turning the unlimited switch on resumes it too, without a denominator.
  h.config.maxNoticesPerChild = 0
  h.config.unlimited = true
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 2)
  assert.match(h.deliveries[1].text, /第 2 次/)
})

test('unlimited ignores the notice cap and keeps reporting until the child ends', async () => {
  const h = harness({ config: { unlimited: true, maxNoticesPerChild: 3 } })
  h.add('c1')
  h.events.set('c1', [])

  // notifyOnNoProgress stays false: unlimited alone must keep the notices coming.
  for (let i = 0; i < 6; i += 1) {
    h.advance(10 * 60_000)
    await h.sup.tick()
  }
  assert.equal(h.deliveries.length, 6)
  assert.equal(h.sup.size(), 1)
  assert.match(h.deliveries[0].text, /第 1 次/)
  assert.match(h.deliveries[5].text, /第 6 次/)
  assert.equal(h.deliveries[5].text.includes('/3'), false, 'no denominator when unlimited')
  assert.match(h.deliveries[5].text, /自上次巡检无新活动/)

  // A child that stops is forgotten, which is what ends an unlimited run.
  h.aliveChildren.delete('c1')
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 6)
  assert.equal(h.sup.size(), 0)
})

test('unlimited overrides a zero budget', async () => {
  const h = harness({ config: { unlimited: true, maxNoticesPerChild: 0 } })
  h.add('c1')
  h.events.set('c1', [])

  for (let i = 0; i < 3; i += 1) {
    h.advance(10 * 60_000)
    await h.sup.tick()
  }
  assert.equal(h.deliveries.length, 3)
  assert.match(h.deliveries[2].text, /第 3 次/)
})

test('turning unlimited off restores the per-child budget', async () => {
  const h = harness({ config: { unlimited: true, maxNoticesPerChild: 2 } })
  h.add('c1')
  h.events.set('c1', [])

  for (let i = 0; i < 3; i += 1) {
    h.advance(10 * 60_000)
    await h.sup.tick()
  }
  assert.equal(h.deliveries.length, 3)

  h.config.unlimited = false
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 3, 'the spent budget now applies again')
  assert.equal(h.sup.size(), 1, 'and the child is still registered')
})

test('two overlapping ticks produce only one notice', async () => {
  const h = harness()
  h.add('c1')
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  h.opts.readEvents = async () => {
    await gate
    return [call(1, 'read', { path: 'a' })]
  }

  h.advance(10 * 60_000)
  const first = h.sup.tick()
  const second = h.sup.tick()
  release()
  await Promise.all([first, second])

  assert.equal(h.deliveries.length, 1)
})

test('re-tracking a child keeps the notices already spent', async () => {
  const h = harness({ config: { notifyOnNoProgress: true } })
  h.add('c1')
  h.events.set('c1', [])

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)

  h.sup.track({ childId: 'c1', parentId: 'p1', label: 'again', startedAt: h.at() })
  assert.equal(h.sup.size(), 1)

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 2)
  assert.match(h.deliveries[1].text, /第 2\/3 次/)
})

test('a resumed child starts with a fresh notice budget', async () => {
  // The interrupt that ended the first run is not the child's fault, and the cold resume
  // creates the worker again: its three notices are available again.
  const h = harness({ config: { notifyOnNoProgress: true } })
  h.add('c1')
  h.events.set('c1', [])
  for (let round = 1; round <= 2; round += 1) {
    h.advance(10 * 60_000)
    await h.sup.tick()
    assert.match(h.deliveries[round - 1].text, new RegExp(`第 ${round}/3 次`))
  }
  // The interrupt releases the registration, exactly as the settled receipt does.
  h.sup.forget('c1')
  assert.equal(h.sup.size(), 0)

  h.sup.track({ childId: 'c1', parentId: 'p1', label: 'resumed', startedAt: h.at(), resumed: true, sinceSeq: 0 })
  assert.equal(h.sup.size(), 1)
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 3)
  assert.match(h.deliveries[2].text, /第 1\/3 次/)
})

test('a resumed child does not report its pre-interrupt history as new activity', async () => {
  const h = harness()
  h.add('c1')
  // Three turns before the interrupt, all summarised by the notice the user already read.
  h.events.set('c1', [call(1, 'read', { path: 'a' }), call(2, 'edit', { path: 'b' }), call(3, 'bash', { cmd: 'ls' })])
  h.sup.track({ childId: 'c1', parentId: 'p1', label: 'slow', startedAt: h.at(), resumed: true, sinceSeq: 3 })

  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 0, 'old events are not progress')
  assert.equal(h.sup.size(), 1, 'the child stays registered')

  // Real progress after the resume is reported once, as the first notice of the new run.
  h.events.get('c1').push(call(4, 'read', { path: 'c' }))
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /第 1\/3 次/)
  assert.match(h.deliveries[0].text, /read/)
})

test('a resumed track without a baseline falls back to the previous mark', async () => {
  const h = harness()
  h.add('c1')
  h.events.set('c1', [call(1, 'read', { path: 'a' }), call(2, 'read', { path: 'b' })])
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)

  // Same child, resumed, with no head mark available (an unreadable log): the mark the
  // last notice reached is the safest baseline, so the two old events are not re-sent.
  h.sup.track({ childId: 'c1', parentId: 'p1', label: 'slow', startedAt: h.at(), resumed: true })
  h.advance(10 * 60_000)
  await h.sup.tick()
  assert.equal(h.deliveries.length, 1)
})

test('has reports whether a child is registered', () => {
  const h = harness()
  assert.equal(h.sup.has('c1'), false)
  h.add('c1')
  assert.equal(h.sup.has('c1'), true)
  h.sup.forget('c1')
  assert.equal(h.sup.has('c1'), false)
})

test('forget is idempotent and size reports the registry', () => {
  const h = harness()
  h.add('c1')
  h.add('c2')
  assert.equal(h.sup.size(), 2)

  h.sup.forget('c1')
  assert.equal(h.sup.size(), 1)
  assert.doesNotThrow(() => h.sup.forget('c1'))
  assert.equal(h.sup.size(), 1)

  h.sup.forget('c2')
  assert.equal(h.sup.size(), 0)
})

test('a throwing liveness callback does not reject the tick', async () => {
  const h = harness()
  h.add('c1')
  h.opts.isChildAlive = () => {
    throw new Error('liveness blew up')
  }

  h.advance(10 * 60_000)
  await assert.doesNotReject(h.sup.tick())
  assert.equal(h.sup.size(), 1)
  assert.equal(h.warnings.some((message) => message.includes('liveness blew up')), true)
})
