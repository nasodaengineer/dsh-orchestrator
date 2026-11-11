/**
 * Subagent supervision. Pure functions plus one dependency-injected supervisor,
 * so the whole thing is testable without the DSH runtime.
 *
 * Why this exists: a child agent can run for many minutes and never report back.
 * The host offers no "interrupt the main agent while it is busy" mechanism, and a
 * message sent to an idle agent only starts a new turn. So the plugin reads the
 * child's session log (no model tokens spent), summarizes it, and wakes the main
 * agent through `followup` at most once per interval for all children of that
 * parent. The main agent then decides whether to steer it with `orchestrator_agents`
 * (`action=send`), interrupt it (`action=interrupt`, which only submits the signal),
 * or leave the child alone.
 *
 * Nothing here calls setInterval, imports a host package, or touches ctx: wiring
 * a timer, `readEvents`, `deliver` and the liveness checks is the host adapter's
 * job. The only thing this module knows about the host event log is the shape
 * handled by `eventName` / `eventData` / `eventSeq` / `eventTime` and the two
 * text extractors below, kept in one place because host fields may change.
 */

/**
 * `source.kind` the wiring should put on the queued message, so a second notice
 * for the same parent can be recognized as already pending.
 */
export const SUPERVISE_SOURCE_KIND = 'orchestrator-supervision'

/** Defaults, filled in by the module because config may be partial. */
const DEFAULTS = Object.freeze({
  enabled: true,
  intervalSeconds: 600,
  maxNoticesPerChild: 3,
  unlimited: false,
  notifyOnNoProgress: false,
  repeatThreshold: 3,
  noticeMaxChars: 2000,
})

/** `lastText` is capped here, and a notice may shrink it further. */
const LAST_TEXT_MAX = 300

/**
 * Only the most recent tool calls are inspected for a loop. An old streak of
 * three identical calls should not keep warning forever after the child moved on.
 */
const REPEAT_WINDOW = 20

/** Candidate per-child text lengths tried before dropping children from a notice. */
const TEXT_LIMITS = [LAST_TEXT_MAX, 240, 180, 120, 80, 40, 0]

/**
 * The one instruction the notice ends with. It names only tools on the main agent's
 * whitelist — `orchestrator_agents` — because the host's own `send_message` /
 * `interrupt_agent` are not offered to a main agent in orchestration mode, and telling a
 * model to call them produced a refused call it then had to recover from.
 */
const NOTICE_HINT =
  '请对每个子代理作出决定——A) 方向正确则不干预；B) 跑偏或打转则用 orchestrator_agents（action=send，' +
  'childId 填上面列出的子代理 id）给它具体纠偏指令；C) 需要终止则用 orchestrator_agents（action=interrupt）' +
  '提交中断信号，该信号不保证子代理已经停止，是否停下仍需之后自行确认。' +
  '若无需干预，只回复一行「巡检：正常」并结束本回合，不要调用任何工具。'

// ---------------------------------------------------------------------------
// Event adapters: the one place that knows the host field names.
// ---------------------------------------------------------------------------

/** `type` is what the session log uses today; `name` is accepted for older logs. */
function eventName(event) {
  const name = event?.type ?? event?.name ?? event?.kind
  return typeof name === 'string' ? name : undefined
}

/** Event payload. Missing or non-object payloads read as an empty object. */
function eventData(event) {
  const data = event?.data
  return data !== null && typeof data === 'object' ? data : {}
}

function eventSeq(event) {
  return asNumber(event?.seq)
}

/** Milliseconds since the epoch. Accepts a number, a Date, or a parseable string. */
function eventTime(event) {
  const time = event?.time
  const direct = asNumber(time)
  if (direct !== undefined) return direct
  if (time instanceof Date) {
    const ms = time.getTime()
    return Number.isFinite(ms) ? ms : undefined
  }
  if (typeof time === 'string') {
    const ms = Date.parse(time)
    return Number.isFinite(ms) ? ms : undefined
  }
  return undefined
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** The tool a `tool/call` names, if the event carries one. */
function toolName(event) {
  const data = eventData(event)
  const name = data.name ?? data.toolName ?? data.tool
  return typeof name === 'string' && name !== '' ? name : undefined
}

/**
 * The arguments of a `tool/call`. The session log shape is not declared as a
 * stable API, so the common spellings are accepted; when none is present the
 * call is compared by its tool name alone.
 */
function toolArgs(event) {
  const data = eventData(event)
  const keys = ['arguments', 'args', 'input', 'parameters', 'params', 'toolInput', 'tool_input']
  for (const key of keys) {
    if (data[key] !== undefined) return normalizeArgs(data[key])
  }
  return undefined
}

function normalizeArgs(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Stable string for an arbitrary JSON-ish value: object key order does not matter. */
function stableKey(value) {
  const seen = new WeakSet()
  const walk = (current) => {
    if (current === null) return 'null'
    const type = typeof current
    if (type === 'string') return JSON.stringify(current)
    if (type === 'number') return Number.isFinite(current) ? String(current) : JSON.stringify(String(current))
    if (type === 'boolean') return String(current)
    if (type === 'bigint') return `bigint:${current}`
    if (type === 'undefined') return 'undefined'
    if (type === 'function' || type === 'symbol') return `"${type}"`
    if (seen.has(current)) return '"[circular]"'
    seen.add(current)
    let text
    if (Array.isArray(current)) {
      text = `[${current.map(walk).join(',')}]`
    } else {
      const keys = Object.keys(current).sort()
      text = `{${keys.map((key) => `${JSON.stringify(key)}:${walk(current[key])}`).join(',')}}`
    }
    seen.delete(current)
    return text
  }
  try {
    return walk(value)
  } catch {
    return '"[unserializable]"'
  }
}

/**
 * Plain text out of an assistant message. Handles a string, a content array of
 * `{ type: 'text', text }` parts, and the `{ message: ... }` / `{ content: ... }`
 * wrappers the log may use. Non-text parts are ignored.
 */
function extractText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    let text = ''
    for (const part of value) text += extractText(part)
    return text
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (Array.isArray(value.content)) return extractText(value.content)
    if (value.message !== undefined) return extractText(value.message)
    if (typeof value.delta === 'string') return value.delta
  }
  return ''
}

function assistantText(event) {
  const data = eventData(event)
  for (const candidate of [data.message, data.text, data.content, data.delta]) {
    const text = extractText(candidate)
    if (text.trim() !== '') return text.trim()
  }
  return ''
}

/** Cut to `max` characters, ellipsis included in the limit. */
function clip(text, max) {
  if (typeof text !== 'string' || max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return `${text.slice(0, max - 1)}…`
}

/** Longest run of the same tool+arguments signature in the recent window. */
function maxRepeatCount(signatures) {
  const recent = signatures.slice(-REPEAT_WINDOW)
  let best = 0
  let run = 0
  let previous
  for (const signature of recent) {
    if (signature === previous) {
      run += 1
    } else {
      run = 1
      previous = signature
    }
    if (run > best) best = run
  }
  return best
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

/**
 * Summarize a child's event log.
 *
 * Total counts (`turns`, `steps`, `lastText`, `repeated`) cover the whole log;
 * `toolCalls` and `newEvents` cover only events with `seq > sinceSeq`. `repeated`
 * is computed over the latest `REPEAT_WINDOW` `tool/call` events, so a streak in
 * the distant past stops warning once the child moves on.
 *
 * Missing fields are tolerated: an absent `seq` simply cannot be "new", and an
 * absent `time` leaves the corresponding timestamp undefined.
 */
export function summarize(events, { sinceSeq = 0, now, startedAt } = {}) {
  const list = Array.isArray(events) ? events : []
  const since = asNumber(sinceSeq) ?? 0
  const at = asNumber(now) ?? Date.now()
  const started = asNumber(startedAt)

  let turns = 0
  let steps = 0
  let toolCalls = 0
  let newEvents = 0
  let lastSeq = 0
  let lastActivityAt
  let lastTool
  let lastToolAt
  let lastText = ''
  const signatures = []

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const name = eventName(event)
    const seq = eventSeq(event)
    const time = eventTime(event)

    if (seq !== undefined) {
      if (seq > lastSeq) lastSeq = seq
      if (seq > since) newEvents += 1
    }
    if (time !== undefined && (lastActivityAt === undefined || time > lastActivityAt)) {
      lastActivityAt = time
    }

    if (name === 'turn/start') {
      turns += 1
    } else if (name === 'step/start') {
      steps += 1
    } else if (name === 'tool/call') {
      if (seq !== undefined && seq > since) toolCalls += 1
      const tool = toolName(event)
      if (tool !== undefined) {
        lastTool = tool
        lastToolAt = time
        const args = toolArgs(event)
        signatures.push(`${tool}\u0000${stableKey(args === undefined ? null : args)}`)
      }
    } else if (name === 'assistant/message') {
      const text = assistantText(event)
      if (text !== '') lastText = clip(text, LAST_TEXT_MAX)
    }
  }

  return {
    turns,
    steps,
    runMs: started === undefined ? 0 : Math.max(0, at - started),
    toolCalls,
    lastTool,
    lastToolAt,
    repeated: maxRepeatCount(signatures),
    lastText,
    lastSeq,
    lastActivityAt,
    newEvents,
  }
}

// ---------------------------------------------------------------------------
// composeNotice
// ---------------------------------------------------------------------------

function positiveInteger(value, fallback) {
  const number = asNumber(value)
  if (number === undefined || number <= 0) return fallback
  return Math.floor(number)
}

function nonNegativeInteger(value, fallback) {
  const number = asNumber(value)
  if (number === undefined || number < 0) return fallback
  return Math.floor(number)
}

function formatDuration(ms) {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, '0')}s`
  }
  return `${seconds}s`
}

function renderRow(row, number, textLimit, at, threshold) {
  const childId = typeof row.childId === 'string' && row.childId !== '' ? row.childId : '(未知)'
  const label = typeof row.label === 'string' && row.label !== '' ? row.label : '未命名'
  const started = asNumber(row.startedAt)
  const runMs = started === undefined ? 0 : Math.max(0, at - started)
  const turns = nonNegativeInteger(row.turns, 0)
  const steps = nonNegativeInteger(row.steps, 0)
  const toolCalls = nonNegativeInteger(row.toolCalls, 0)
  const repeated = nonNegativeInteger(row.repeated, 0)
  const tool = typeof row.lastTool === 'string' && row.lastTool !== '' ? row.lastTool : '无'
  const lastText = typeof row.lastText === 'string' ? row.lastText : ''

  const lines = [
    `${number}) 子代理 ${childId}`,
    `   任务：${label}`,
    `   已运行 ${formatDuration(runMs)} ｜ 轮次 ${turns} ｜ 步骤 ${steps}`,
    `   自上次巡检新增工具调用 ${toolCalls} 次 ｜ 最近工具：${tool}`,
  ]
  if (lastText !== '' && textLimit > 0) {
    lines.push(`   最后输出：${clip(lastText, textLimit)}`)
  }
  if (repeated >= threshold) {
    lines.push(`   ⚠ 检测到同一工具调用连续重复 ${repeated} 次，可能原地打转`)
  }
  if (row.newEvents === 0) {
    lines.push('   （自上次巡检无新活动）')
  }
  return lines.join('\n')
}

/**
 * Build the Chinese notice for one parent's due children.
 *
 * The result is strictly at most `maxChars` long. When it does not fit, each
 * child's `lastText` is shortened first; only if that is not enough are children
 * dropped from the end of the list, with a line saying how many were left out.
 * `index`/`max` are the notice number for that child and the per-child budget
 * (`max = 0` means unlimited, rendered as "第 N 次").
 */
export function composeNotice(rows, { now, index, max, maxChars = 2000, repeatThreshold = 3 } = {}) {
  const at = asNumber(now) ?? Date.now()
  const noticeIndex = positiveInteger(index, 1)
  const noticeMax = nonNegativeInteger(max, 0)
  const limitChars = positiveInteger(maxChars, DEFAULTS.noticeMaxChars)
  const threshold = positiveInteger(repeatThreshold, DEFAULTS.repeatThreshold)
  const allRows = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : []

  const header =
    noticeMax > 0
      ? `【插件巡检｜第 ${noticeIndex}/${noticeMax} 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。`
      : `【插件巡检｜第 ${noticeIndex} 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。`

  const build = (keep, textLimit) => {
    const parts = [header]
    for (let i = 0; i < keep; i += 1) {
      parts.push(renderRow(allRows[i], i + 1, textLimit, at, threshold))
    }
    const dropped = allRows.length - keep
    if (dropped > 0) parts.push(`另有 ${dropped} 个子代理未列出。`)
    parts.push(NOTICE_HINT)
    return parts.join('\n')
  }

  for (let keep = allRows.length; keep >= 1; keep -= 1) {
    for (const textLimit of TEXT_LIMITS) {
      const candidate = build(keep, textLimit)
      if (candidate.length <= limitChars) return candidate
    }
  }

  // Either there are no rows, or even one row with no summary text is too long.
  const tail = build(0, 0)
  return tail.length <= limitChars ? tail : tail.slice(0, limitChars)
}

// ---------------------------------------------------------------------------
// createSupervisor
// ---------------------------------------------------------------------------

function readConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: source.enabled !== false,
    intervalSeconds: positiveNumber(source.intervalSeconds, DEFAULTS.intervalSeconds),
    maxNoticesPerChild: nonNegativeInteger(source.maxNoticesPerChild, DEFAULTS.maxNoticesPerChild),
    unlimited: source.unlimited === true,
    notifyOnNoProgress: source.notifyOnNoProgress === true,
    repeatThreshold: positiveInteger(source.repeatThreshold, DEFAULTS.repeatThreshold),
    noticeMaxChars: positiveInteger(source.noticeMaxChars, DEFAULTS.noticeMaxChars),
  }
}

function positiveNumber(value, fallback) {
  const number = asNumber(value)
  if (number === undefined || number <= 0) return fallback
  return number
}

function intervalMsOf(config) {
  return Math.max(1, Math.round(config.intervalSeconds * 1000))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The stateful half. Every host capability is injected:
 *
 * - `config`: a plain object read on every `tick`, so an interval change applies
 *   from the next tick; partially specified fields fall back to `DEFAULTS`.
 *   `intervalSeconds` is the minimum age of a child before it is reported.
 * - `now()`, `isParentAlive(parentId)`, `isChildAlive(childId)`,
 *   `readEvents(childId)`, `hasPendingNotice(parentId)`,
 *   `deliver(parentId, text, childIds)`, `logger`. The async ones may return a
 *   value or a Promise.
 *
 * `tick` never throws because of one child or parent: read, summarize, pending
 * check and delivery failures are logged and skipped (or retried next interval).
 * Two overlapping ticks are serialized by an in-progress flag, so one interval
 * can never produce two notices.
 */
export function createSupervisor(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const entries = new Map()
  let ticking = false

  const logger = opts.logger !== null && typeof opts.logger === 'object' ? opts.logger : {}
  const warn = (message) => {
    try {
      if (typeof logger.warn === 'function') logger.warn(message)
    } catch {
      // A logger must not break supervision.
    }
  }

  const currentTime = () => {
    try {
      const value = typeof opts.now === 'function' ? opts.now() : undefined
      return asNumber(value) ?? Date.now()
    } catch {
      return Date.now()
    }
  }

  const track = (entry) => {
    if (entry === null || typeof entry !== 'object') return
    const childId = entry.childId
    const parentId = entry.parentId
    if (typeof childId !== 'string' || childId === '') return
    if (typeof parentId !== 'string' || parentId === '') return

    const config = readConfig(opts.config)
    const intervalMs = intervalMsOf(config)
    const startedAt = asNumber(entry.startedAt) ?? currentTime()
    const previous = entries.get(childId)
    // A resumed worker is a new run of the same task: the interrupt that stopped it was
    // not the child's fault, so its notice budget starts over. Its log still holds the
    // pre-interrupt history, which must not be reported as fresh activity, so the
    // baseline is the caller's head-of-log mark when it has one.
    const resumed = entry.resumed === true
    const sinceSeq = asNumber(entry.sinceSeq)
    entries.set(childId, {
      childId,
      parentId,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : '',
      startedAt,
      nextDueAt: startedAt + intervalMs,
      // A plain re-track refreshes the task and the deadline but keeps the budget used.
      noticesSent: resumed ? 0 : previous?.noticesSent ?? 0,
      lastSeq: resumed ? sinceSeq ?? previous?.lastSeq ?? 0 : 0,
      intervalMs,
    })
  }

  const forget = (childId) => {
    entries.delete(childId)
  }

  const tick = async (nowOverride) => {
    let config
    try {
      config = readConfig(opts.config)
    } catch (error) {
      // A malformed config object must not break the host's timer.
      warn(`orchestrator: supervision: cannot read config: ${errorMessage(error)}`)
      return
    }
    // Off means fully off: no cleanup, no wake-up, no registry changes.
    if (!config.enabled) return
    // A zero budget is the second way to switch supervision off, unless the unlimited
    // switch overrides it. The registry is deliberately kept: a child that is still
    // running must be supervised again the moment the user raises the budget or turns
    // the unlimited switch on, without waiting for a re-dispatch.
    if (!config.unlimited && config.maxNoticesPerChild === 0) return
    if (ticking) return
    ticking = true
    try {
      const at = asNumber(nowOverride) ?? currentTime()
      const intervalMs = intervalMsOf(config)

      // A parent that is gone takes every registration with it, before any reads.
      const parentIds = new Set()
      for (const entry of entries.values()) parentIds.add(entry.parentId)
      for (const parentId of parentIds) {
        let alive = true
        if (typeof opts.isParentAlive === 'function') {
          try {
            alive = (await opts.isParentAlive(parentId)) !== false
          } catch (error) {
            warn(`orchestrator: supervision: isParentAlive(${parentId}) failed: ${errorMessage(error)}`)
            alive = true
          }
        }
        if (alive) continue
        for (const [childId, entry] of entries) {
          if (entry.parentId === parentId) entries.delete(childId)
        }
      }
      if (entries.size === 0) return

      /** parentId -> [{ entry, summary }] for this tick's due, notifying children. */
      const dueByParent = new Map()

      for (const entry of [...entries.values()]) {
        // A callback may have forgotten it while we awaited a previous entry.
        if (entries.get(entry.childId) !== entry) continue

        let childAlive = true
        if (typeof opts.isChildAlive === 'function') {
          try {
            childAlive = (await opts.isChildAlive(entry.childId)) !== false
          } catch (error) {
            warn(`orchestrator: supervision: isChildAlive(${entry.childId}) failed: ${errorMessage(error)}`)
            childAlive = true
          }
        }
        if (!childAlive) {
          entries.delete(entry.childId)
          continue
        }

        // A changed interval takes effect at once. Shift the deadline by the same
        // delta, so shrinking can make it due right now and growing delays it,
        // without losing an advance already made for a skipped notice.
        if (entry.intervalMs !== intervalMs) {
          const scheduledFrom = entry.nextDueAt - entry.intervalMs
          entry.nextDueAt = scheduledFrom + intervalMs
          entry.intervalMs = intervalMs
        }

        if (at < entry.nextDueAt) continue

        // The budget is spent, but the child is not forgotten: raising the budget or
        // switching to unlimited mid-run must resume supervision of this same child.
        // The deadline is left in the past, so the next scan after such a change
        // notifies at once instead of waiting out a whole interval.
        if (!config.unlimited && entry.noticesSent >= config.maxNoticesPerChild) continue

        let events
        try {
          events = typeof opts.readEvents === 'function' ? await opts.readEvents(entry.childId) : []
        } catch (error) {
          warn(`orchestrator: supervision: readEvents(${entry.childId}) failed: ${errorMessage(error)}`)
          continue // Only this child skips; its deadline stays put and is retried.
        }

        let summary
        try {
          summary = summarize(events, { sinceSeq: entry.lastSeq, now: at, startedAt: entry.startedAt })
        } catch (error) {
          warn(`orchestrator: supervision: summarize(${entry.childId}) failed: ${errorMessage(error)}`)
          continue
        }

        const looping = summary.repeated >= config.repeatThreshold
        // No new events and no loop is not worth a turn, unless asked to always report.
        // Unlimited supervision means "keep reporting until the child stops, delivers or
        // ends", so a quiet child is still reported every interval.
        if (summary.newEvents === 0 && !looping && !config.notifyOnNoProgress && !config.unlimited) {
          entry.nextDueAt = at + intervalMs
          continue
        }

        const batch = dueByParent.get(entry.parentId)
        if (batch === undefined) {
          dueByParent.set(entry.parentId, [{ entry, summary }])
        } else {
          batch.push({ entry, summary })
        }
      }

      // One notice per parent, covering every due child of that parent.
      for (const [parentId, batch] of dueByParent) {
        const live = batch.filter(({ entry }) => entries.get(entry.childId) === entry)
        if (live.length === 0) continue

        let alreadyPending = false
        if (typeof opts.hasPendingNotice === 'function') {
          try {
            alreadyPending = (await opts.hasPendingNotice(parentId)) === true
          } catch (error) {
            warn(`orchestrator: supervision: hasPendingNotice(${parentId}) failed: ${errorMessage(error)}`)
            // Assume pending: a duplicate notice is worse than a delayed one.
            alreadyPending = true
          }
        }
        if (alreadyPending) {
          // Skip the whole parent, spend no budget, but do not re-check every tick.
          for (const { entry } of live) entry.nextDueAt = at + intervalMs
          continue
        }

        const index = live.reduce((highest, { entry }) => Math.max(highest, entry.noticesSent), 0) + 1
        const rows = live.map(({ entry, summary }) => ({
          childId: entry.childId,
          label: entry.label,
          startedAt: entry.startedAt,
          turns: summary.turns,
          steps: summary.steps,
          toolCalls: summary.toolCalls,
          lastTool: summary.lastTool,
          lastToolAt: summary.lastToolAt,
          repeated: summary.repeated,
          lastText: summary.lastText,
          newEvents: summary.newEvents,
        }))
        const text = composeNotice(rows, {
          now: at,
          index,
          // `max: 0` renders "第 N 次" without a denominator, which is exactly what an
          // unlimited run should show.
          max: config.unlimited ? 0 : config.maxNoticesPerChild,
          maxChars: config.noticeMaxChars,
          repeatThreshold: config.repeatThreshold,
        })

        let result
        try {
          result =
            typeof opts.deliver === 'function'
              ? await opts.deliver(
                  parentId,
                  text,
                  live.map(({ entry }) => entry.childId),
                )
              : 'queued'
        } catch (error) {
          warn(`orchestrator: supervision: deliver(${parentId}) failed: ${errorMessage(error)}`)
          for (const { entry } of live) entry.nextDueAt = at + intervalMs
          continue
        }

        if (result === 'queued') {
          for (const { entry, summary } of live) {
            entry.noticesSent += 1
            // A tail window can report a lower max than a previous read; never go backwards.
            entry.lastSeq = Math.max(entry.lastSeq, summary.lastSeq)
            entry.nextDueAt = at + intervalMs
          }
        } else if (result === 'parent-gone') {
          for (const [childId, entry] of entries) {
            if (entry.parentId === parentId) entries.delete(childId)
          }
        } else if (result === 'already-pending') {
          for (const { entry } of live) entry.nextDueAt = at + intervalMs
        } else {
          warn(`orchestrator: supervision: deliver(${parentId}) returned ${String(result)}`)
          for (const { entry } of live) entry.nextDueAt = at + intervalMs
        }
      }
    } catch (error) {
      // Last line of defence: a supervision bug must never propagate into the host.
      warn(`orchestrator: supervision: tick failed: ${errorMessage(error)}`)
    } finally {
      ticking = false
    }
  }

  const has = (childId) => entries.has(childId)
  const size = () => entries.size

  return { track, forget, has, tick, size }
}
