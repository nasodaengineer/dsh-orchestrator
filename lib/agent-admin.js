/**
 * `orchestrator_agents` — the main agent's control surface over the subagents it
 * dispatched. One tool, four actions: `list`, `status`, `send`, `interrupt`.
 *
 * Why one tool and not four: the host already ships `send_message` and `interrupt_agent`,
 * which address any agent by id. A second tool sharing either name would mask the host's
 * definition, and four new names would blur the trusted boundary. One uniquely named tool
 * with an `action` discriminator keeps the main agent's surface small and keeps the
 * authority check in one place.
 *
 * Everything here is intentionally honest about what the runtime can prove:
 *
 * - `list` reads `ctx.subagents.listDescendants(parentSessionId)`, the durable parent
 *   catalog. `ctx.subagents.list()` returns provider NAMES and is never used as an agent
 *   list. An unreadable catalog is reported as an error, never as an empty list.
 * - `status` reports living-Agent presence (`ctx.agents.get`) and Session presence
 *   (`ctx.sessions.get`) as separate facts. Neither proves that a turn is executing, and
 *   the catalog's own `activity` field only means the Session is resident, so none of them
 *   is ever reported as "running". The turn field is `turnState`, drawn from a closed
 *   vocabulary: `turnStarted` (the child's log records a `turn/start` with no matching
 *   `turn/end`), `idle` (every recorded turn is paired), or `unknown` (no session, an
 *   unreadable log, or turn ids that do not pair). `hostRunState` stays `unknown` and is
 *   never filled in from residency.
 * - `list` may return every descendant at any depth, but `send` and `interrupt` require
 *   `row.depth === 1` after lineage is proven: the host authorises only a direct child.
 * - `send` uses the host's plugin delivery channel and reports the accepted message id.
 * - `interrupt` submits the signal and says so; it cannot observe the child stopping.
 *
 * Dependency-free: the live registry is passed in, so the whole surface is testable with
 * plain objects.
 */

import { AGENT_ADMIN_TOOL } from './api.js'

/**
 * The durable `source.kind` of every message this tool delivers. It is deliberately its
 * own kind, not the retry or supervision notice kind: those two policies read the parent
 * inbox for their own kinds and must never see, or be confused by, a main-agent message.
 */
export const AGENT_ADMIN_SOURCE_KIND = 'orchestrator-agent-admin'

/**
 * The host's plugin delivery entry point. `ctx.subagents.sendMessage` needs the exact live
 * sender Agent, which a plugin cannot supply without impersonating the parent; this
 * symbol-keyed call takes a durable source and a parent Agent instead.
 */
const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt')

export const ACTIONS = Object.freeze(['list', 'status', 'send', 'interrupt'])

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The highest `seq` the log carries; 0 when it has none. */
export function lastSeq(log) {
  let head = 0
  if (!Array.isArray(log)) return head
  for (const event of log) {
    const seq = event?.seq
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > head) head = seq
  }
  return head
}

/**
 * The turn state of one child, read from its own session log and never guessed.
 *
 * Turns are paired by their own id, not by arrival order: a `turn/start` opens its id, a
 * `turn/end` closes only that same id, and an `end` for an id that was never opened (or
 * already closed) closes nothing. The wording says exactly that and no more — a started
 * turn is `turnStarted` / `hostRunState: 'unknown'`, because the log records that the
 * host emitted `turn/start`, not that a turn is executing now.
 *
 * Anything this pairing cannot decide is `unknown`: no session, no readable log, an event
 * whose turn id cannot be read, a turn id opened twice without an end in between, or an
 * end for an id that was never opened. `idle` is claimed only when every event was
 * paired cleanly — calling a corrupt log "idle" would be the same guess, inverted.
 */
export function readTurnState(session) {
  const log = session?.log
  if (!Array.isArray(log)) return { turnState: 'unknown', reason: 'the session log is unreadable' }
  /** Turn ids opened and not yet closed, in the order they were opened. */
  const open = []
  /** A node that stops the pairing from being provable, with why. */
  let blocker
  let lastEnd
  const block = (reason) => {
    if (blocker === undefined) blocker = reason
  }
  const pair = (event, kind) => {
    const turn = event.data?.turn
    if (typeof turn !== 'number' && typeof turn !== 'string') {
      block(`a ${kind} event carries no readable turn id, so turn pairing cannot be proven`)
      return undefined
    }
    return turn
  }
  for (const event of log) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      const turn = pair(event, 'turn/start')
      if (turn === undefined) continue
      if (open.includes(turn)) {
        block(`turn ${String(turn)} was started twice without an end in between`)
        continue
      }
      open.push(turn)
    } else if (event.type === 'turn/end') {
      // Remember the end even when it pairs with nothing: it is still evidence of activity.
      lastEnd = event
      const turn = pair(event, 'turn/end')
      if (turn === undefined) continue
      const at = open.indexOf(turn)
      if (at === -1) {
        block(`a turn/end for turn ${String(turn)} arrived without a matching turn/start`)
        continue
      }
      open.splice(at, 1)
    }
  }
  const seq = lastSeq(log)
  if (blocker !== undefined) {
    return {
      turnState: 'unknown',
      reason: `the turn log is out of order: ${blocker}`,
      lastTurnReason: lastEnd?.data?.reason,
      seq,
    }
  }
  if (open.length === 1) {
    return {
      turnState: 'turnStarted',
      openTurn: open[0],
      hostRunState: 'unknown',
      reason:
        `the child's log records a turn/start for turn ${String(open[0])} with no matching turn/end; ` +
        'that is a log fact, not proof that the host is running a turn now',
      seq,
    }
  }
  if (open.length > 1) {
    return {
      turnState: 'unknown',
      openTurns: [...open],
      reason: `${open.length} turns are open at once, so the current turn cannot be identified`,
      seq,
    }
  }
  return {
    turnState: 'idle',
    hostRunState: 'unknown',
    reason: lastEnd === undefined ? 'no turn has been recorded in this session' : undefined,
    lastTurnReason: lastEnd?.data?.reason,
    seq,
  }
}

/**
 * The lineage resolver. `listDescendants` is the only authority used: the plugin's own
 * `dispatched` map and the dispatch guard are supplementary records, so a descendant this
 * plugin did not dispatch (a nested grandchild, or a worker a host tool started) is still
 * properly authorised.
 */
export function createLineage({ subagents } = {}) {
  const listDescendants = subagents?.listDescendants
  const unsupported = () => {
    const error = new Error(
      'this host does not expose subagents.listDescendants, so descendants cannot be listed',
    )
    error.code = 'UNSUPPORTED'
    return error
  }
  return {
    supported: typeof listDescendants === 'function',
    /**
     * Every descendant of `parentSessionId`, or a thrown error. An unsupported host and an
     * unreadable catalog are different failures and are reported differently: the first is
     * "this host cannot enumerate", the second is the runtime's own message.
     */
    async read(parentSessionId, signal) {
      if (typeof listDescendants !== 'function') throw unsupported()
      const rows = await listDescendants.call(subagents, parentSessionId, signal)
      if (!Array.isArray(rows)) throw new Error('subagents.listDescendants did not return an array')
      return rows
    },
    /** The row for one child, or `undefined` when it is not a descendant of this parent. */
    async find(parentSessionId, childId, signal) {
      const rows = await this.read(parentSessionId, signal)
      return rows.find((row) => row?.id === childId && row?.kind !== 'diagnostic')
    },
  }
}

export function createAgentAdmin({
  defineTool,
  subagents,
  agents,
  sessions,
  describeDispatch = () => undefined,
} = {}) {
  const lineage = createLineage({ subagents })

  /** The session id a parent agent is addressed by, or `undefined` when it has none. */
  const sessionIdOf = (agent) => {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  const requireParent = (parent) => {
    if (parent === undefined || parent === null) {
      throw new Error(`${AGENT_ADMIN_TOOL} requires a calling agent (exec.agent was undefined)`)
    }
    const parentSessionId = sessionIdOf(parent)
    if (parentSessionId === undefined) {
      throw new Error(`${AGENT_ADMIN_TOOL} requires the calling agent to have a session id`)
    }
    return parentSessionId
  }

  /**
   * Resolve `childId` to an authorised descendant. Lineage comes first and is the only
   * authority; when the catalog itself is unavailable the call fails with that reason
   * rather than falling back to the plugin's own bookkeeping, because bookkeeping cannot
   * prove that a child belongs to this parent.
   */
  const requireDescendant = async (parentSessionId, childId, signal) => {
    if (typeof childId !== 'string' || childId.trim() === '') {
      throw new Error(`${AGENT_ADMIN_TOOL}: "childId" must be a non-empty string`)
    }
    const id = childId.trim()
    if (id === parentSessionId) {
      throw new Error(`${AGENT_ADMIN_TOOL}: "${id}" is the calling agent itself, not a descendant`)
    }
    const row = await lineage.find(parentSessionId, id, signal)
    if (row === undefined) {
      throw new Error(
        `${AGENT_ADMIN_TOOL}: "${id}" is not a descendant of the calling session ${parentSessionId}; ` +
          'an arbitrary session id is refused',
      )
    }
    return row
  }

  /**
   * Resolve a descendant that a *mutating* action may address.
   *
   * `list` and `status` may describe any descendant, but the host authorises control
   * (delivery and interrupt) only for a direct child, so `send` and `interrupt` gate on
   * `row.depth === 1` *after* lineage is proven — lineage first, so a foreign id is still
   * refused as foreign, not as deep. A deeper id is refused with its depth and the route to
   * the direct parent, and the text says nothing was delivered or interrupted.
   */
  const requireDirectChild = async (parentSessionId, childId, signal, action) => {
    const row = await requireDescendant(parentSessionId, childId, signal)
    if (row.depth !== 1) {
      const id = childId.trim()
      const depth = row.depth === undefined ? 'unknown' : String(row.depth)
      const outcome = action === 'send' ? 'nothing was delivered' : 'nothing was interrupted'
      throw new Error(
        `${AGENT_ADMIN_TOOL}: "${id}" is a descendant of the calling session at depth ${depth}, ` +
          `but action "${action}" is authorised only for a direct child (depth 1): ${outcome}. ` +
          'The host grants control only to the direct parent, so contact the direct parent of this ' +
          'agent and ask it to send or interrupt its own child, or address that direct child instead.',
      )
    }
    return row
  }

  const actList = async ({ parent, signal }) => {
    const parentSessionId = requireParent(parent)
    const rows = await lineage.read(parentSessionId, signal)
    const descendants = []
    const diagnostics = []
    for (const row of rows) {
      if (row?.kind === 'diagnostic') {
        diagnostics.push({
          kind: 'diagnostic',
          id: row.id,
          parentId: row.parentId,
          depth: row.depth,
          reason: typeof row.reason === 'string' ? row.reason : 'unavailable',
        })
        continue
      }
      const dispatch = describeDispatch(row.id)
      descendants.push({
        kind: 'subagent',
        id: row.id,
        parentId: row.parentId,
        depth: row.depth,
        mode: typeof row.mode === 'string' ? row.mode : undefined,
        // The catalog's own field, renamed so it can never be read as a live turn.
        catalogActivity: typeof row.activity === 'string' ? row.activity : 'unknown',
        hasChildren: row.hasChildren === true,
        dispatchedByOrchestrator: dispatch !== undefined,
        label: dispatch?.label,
        startedAt: dispatch?.startedAt,
      })
    }
    return { action: 'list', parentSessionId, supported: true, count: descendants.length, descendants, diagnostics }
  }

  const actStatus = async ({ parent, args, signal }) => {
    const parentSessionId = requireParent(parent)
    const childId = args?.childId
    let row
    try {
      row = await requireDescendant(parentSessionId, childId, signal)
    } catch (error) {
      // An unsupported host still answers honestly: the plugin's own records cannot prove
      // lineage, so the action reports `authorized: false` with the reason instead of a row.
      if (error?.code === 'UNSUPPORTED') {
        return { action: 'status', parentSessionId, childId, authorized: false, reason: messageOf(error) }
      }
      throw error
    }
    const id = childId.trim()
    const dispatch = describeDispatch(id)
    const live = agents?.get?.(id)
    const session = sessions?.get?.(id) ?? live?.session
    const turn =
      session === undefined || session === null
        ? { turnState: 'unknown', hostRunState: 'unknown', reason: 'no live session is loaded for this child' }
        : readTurnState(session)
    return {
      action: 'status',
      parentSessionId,
      childId: id,
      authorized: true,
      dispatchedByOrchestrator: dispatch !== undefined,
      label: dispatch?.label,
      startedAt: dispatch?.startedAt,
      taskKey: dispatch?.taskKey,
      writeScope: dispatch?.writeScope,
      // Three separate runtime facts. None of them means "running":
      // `agentPresence` is whether an Agent object is registered, `sessionPresence` whether
      // a Session is loaded, `catalogActivity` the catalog's own residency field.
      agentPresence: live === undefined || live === null ? 'absent' : 'resident',
      sessionPresence: session === undefined || session === null ? 'absent' : 'loaded',
      hasChildren: row?.hasChildren === true,
      depth: row?.depth,
      catalogActivity: typeof row?.activity === 'string' ? row.activity : 'unknown',
      ...turn,
    }
  }

  const actSend = async ({ parent, args, signal }) => {
    const parentSessionId = requireParent(parent)
    const id = args?.childId
    await requireDirectChild(parentSessionId, id, signal, 'send')
    const text = args?.text
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`${AGENT_ADMIN_TOOL}: "text" must be a non-empty string for action "send"`)
    }
    const deliver = subagents?.[DELIVER_PROMPT]
    if (typeof deliver !== 'function') {
      throw new Error(
        'this host does not expose the plugin prompt delivery channel ' +
          '(dsh.subagent.deliverPrompt), so a message cannot be queued on a subagent',
      )
    }
    // The channel takes the exact live parent Agent; the host refuses a stale or foreign
    // object, so binding it here is what makes the delivery trustworthy.
    const live = agents?.get?.(parent.id)
    if (live === undefined || live === null) {
      throw new Error(`the calling agent ${parent.id} is not live, so it cannot deliver on its own behalf`)
    }
    const source = { kind: AGENT_ADMIN_SOURCE_KIND, form: 'notice' }
    const messageId = await deliver.call(subagents, live, id.trim(), [{ type: 'text', text }], source, signal, 'queue')
    return {
      action: 'send',
      parentSessionId,
      childId: id.trim(),
      delivered: true,
      messageId: typeof messageId === 'string' || typeof messageId === 'number' ? messageId : undefined,
      source: AGENT_ADMIN_SOURCE_KIND,
    }
  }

  const actInterrupt = async ({ parent, args, signal }) => {
    const parentSessionId = requireParent(parent)
    const id = args?.childId
    await requireDirectChild(parentSessionId, id, signal, 'interrupt')
    const interrupt = subagents?.interrupt
    if (typeof interrupt !== 'function') {
      throw new Error('this host does not expose subagents.interrupt, so a subagent cannot be interrupted')
    }
    const live = agents?.get?.(parent.id)
    if (live === undefined || live === null) {
      throw new Error(`the calling agent ${parent.id} is not live, so it cannot be the interrupting ancestor`)
    }
    // `interrupt` is synchronous and returns void: it submits the signal. The child's stop
    // is a later, separate event this tool cannot observe, so it is never claimed.
    interrupt.call(subagents, id.trim(), { kind: 'ancestor', agent: live })
    return {
      action: 'interrupt',
      parentSessionId,
      childId: id.trim(),
      signalSubmitted: true,
      stopped: 'unknown',
      note: 'The interrupt signal was submitted. Whether the subagent has stopped is not confirmed by this call.',
    }
  }

  const body =
    '主代理管理自己派发的子代理（只对本会话的后代生效，其他 session 一律拒绝）。' +
    'action=list 列出全部后代（任意深度），并附上本插件派发记录的 label/startedAt；' +
    'action=status 报告某个 childId 是否由本插件派发、Agent 是否存在、Session 是否加载、以及 turn 状态；' +
    'turn 状态只有三种取值：turnStarted（日志记了 turn/start 而其 turn/end 未出现）、idle（每个 turn 都成对结束）、' +
    'unknown（无 session、日志不可读，或 turn id 无法配对）。turnStarted 只说明日志里有未闭合的 turn，' +
    '宿主此刻是否真的在跑这个回合是未知的（hostRunState 恒为 unknown），不要把 turnStarted 读成“正在运行”；' +
    'Agent 存在、Session 加载、catalog 的 activity 都只是驻留事实，同样不代表正在运行。' +
    'action=send 向该子代理入队一条文本（走插件投递通道，返回 host message id）；' +
    'action=interrupt 只提交中断信号，不表示子代理已停止。' +
    'send 与 interrupt 只允许直接子代（depth 1）：宿主只把控制权授予直接 parent，' +
    '孙代会被拒绝，此时请联系它的直接 parent 代为操作。' +
    'delegate/orchestrate 返回的 subagentId 可直接用作 childId；orchestrate 结果行里的 subagentId 即该工人的 id。'

  const tool = defineTool({
    name: AGENT_ADMIN_TOOL,
    description: body,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: '要执行的动作：list / status / send / interrupt。',
      },
      childId: {
        type: 'string',
        description:
          'status / send / interrupt 必填：目标子代理的 session id（delegate 或 orchestrate 结果行里的 subagentId）。' +
          'send / interrupt 只接受直接子代（depth 1）：宿主只授权直接 parent 控制，孙代会被拒绝。',
      },
      text: {
        type: 'string',
        description: 'send 必填：要入队给子代理的普通文本，会作为一条新的回合投递。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    // `send`/`interrupt` change a child's state, so several of them must not interleave on
    // one child; `list`/`status` only read.
    isConcurrencySafe: (args) => args?.action === 'list' || args?.action === 'status',
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!ACTIONS.includes(action)) {
        throw new Error(
          `${AGENT_ADMIN_TOOL}: "action" must be one of ${ACTIONS.join(', ')} ` +
            `(got ${JSON.stringify(args?.action)})`,
        )
      }
      const parent = exec?.agent
      const signal = exec?.signal ?? new AbortController().signal
      if (signal?.aborted === true) throw new Error(`${AGENT_ADMIN_TOOL}: the call was aborted before it ran`)
      const context = { parent, args, signal }
      if (action === 'list') return actList(context)
      if (action === 'status') return actStatus(context)
      if (action === 'send') return actSend(context)
      return actInterrupt(context)
    },
  })

  // The host reads `description` while it builds a request; keep it a live getter for the
  // same reason `delegate` does, even though this text does not depend on the whitelist.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => body,
  })
  return tool
}

/** One line a model can read back without parsing the JSON. */
function renderResult(value) {
  if (value === undefined || value === null) return `${AGENT_ADMIN_TOOL}: no result`
  switch (value.action) {
    case 'list':
      return `${AGENT_ADMIN_TOOL}: ${value.count} descendant(s) of ${value.parentSessionId}`
    case 'status':
      return value.authorized === false
        ? `${AGENT_ADMIN_TOOL}: ${value.childId} is not an authorised descendant (${value.reason})`
        : `${AGENT_ADMIN_TOOL}: ${value.childId} agent=${value.agentPresence} session=${value.sessionPresence} ` +
          `turn=${value.turnState} (hostRunState=${value.hostRunState ?? 'unknown'})`
    case 'send':
      return `${AGENT_ADMIN_TOOL}: queued a message on ${value.childId}${value.messageId === undefined ? '' : ` (${value.messageId})`}`
    default:
      return `${AGENT_ADMIN_TOOL}: interrupt submitted for ${value.childId}; stop is unconfirmed`
  }
}
