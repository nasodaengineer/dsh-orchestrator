import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { ORCHESTRATE_TOOL } from './api.js'
import { createCatalogPublisher } from './catalog.js'
import { createDelegateTool } from './delegate.js'
import { effectiveAllowed, installGate, isDelegatedChild } from './gate.js'
import { createOrchestrateTool } from './orchestrate.js'
import { RETRY_SOURCE_KIND, createRetry } from './retry.js'
import { MODE_RECORD_TYPE, createModeProjection, createModeStore } from './session-mode.js'
import { STAGES, initialState, reduceStage } from './stage.js'
import { SUPERVISE_SOURCE_KIND, createSupervisor } from './supervise.js'
import { installToolSurface } from './tool-surface.js'

export { SUPERVISE_SOURCE_KIND }

export const name = 'dsh-orchestrator'

/**
 * Services used here: the projection registry, the tool registry, the subagent
 * service, and the live agent/session registries the supervision adapters read.
 */
export const inject = ['sessionProjections', 'tools', 'subagents', 'agents', 'sessions']

/**
 * Stage projection. The registry calls `.parse` on these schemas, so they must be
 * zod schemas (schemastery objects have no `.parse`), as the native plan projection does.
 */
const stageProjection = {
  key: 'orchestrator',
  stateVersion: 1,
  stateSchema: zod.object({ stage: zod.enum(STAGES), plan: zod.boolean() }).strict(),
  init: (_header, inheritedEventCount) => initialState(inheritedEventCount),
  apply: reduceStage,
  wire: {
    viewSchema: zod.object({ stage: zod.enum(STAGES), plan: zod.boolean() }),
    view: (state) => ({ stage: state.stage, plan: state.plan }),
  },
}

/**
 * The tools a main agent keeps while orchestration mode is on — the shipped whitelist.
 *
 * The gate is whitelist-driven: this list is the whole surface a main agent has, and
 * every other tool the host offers (files, search, shells, fetch, the native
 * `subagent`/`workflow`, and any plugin or MCP tool) is hidden and refused. The order is
 * fixed because the panel and the client fallback mirror it literally.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  // Delegation & worker control — the main agent's core orchestration surface
  'delegate',
  'orchestrate',
  'send_message',
  'interrupt_agent',
  // Planning, user clarification & context compression
  'todo_write',
  'ask_user_question',
  'compress',
  // Read-only session history inspection
  'session_search',
  'session_trace',
  'session_event_search',
  'session_event_read',
  'session_event_trace',
]

/**
 * Every field is volatile so a switch or settings card can rewrite it without
 * editing the profile file. `enabled` and `allowedTools` are read live by the guard,
 * so the switch and the whitelist reach conversations that are already open. The worker
 * route is read on every delegation, so it applies from the next `delegate` call.
 */
export const Config = z.object({
  /**
   * Retired: dispatch mode is now session-scoped, so this profile field no longer decides
   * anything. It is kept (not removed) so an existing profile that spells out `enabled: false`
   * still validates instead of failing the whole plugin load.
   */
  enabled: z.boolean().default(true).volatile(),
  /**
   * The only tool whitelist there is. Whitelist-driven: only the names listed here stay
   * available to the main agent, and every other host, MCP or plugin tool is automatically
   * hidden and blocked. Workers always keep the full tool set.
   *
   * That is only the default: the panel may check any tool the host offers.
   * `tools.restrict` hides the global ones; a guard additionally refuses every name that is
   * not listed at execution time, which is what stops scope-local tools such as the native
   * `subagent` (registered in the agent's own scope, so restrict throws for it). Read on
   * every gated call, so a panel change applies to open conversations.
   */
  allowedTools: z
    .array(z.string())
    .default(DEFAULT_ALLOWED_TOOLS)
    .description(
      'Tools allowed for the main agent while orchestration mode is enabled. ' +
        'Whitelist-driven: only tools in this list are available to the main agent; ' +
        'every other host, MCP, or plugin tool is automatically hidden and blocked. ' +
        'Workers always keep the full tool set.'
    )
    .volatile(),
  /**
   * Read-only mirror of every tool the running host has registered, published by the plugin
   * for the Allowed Tools panel: a web client cannot enumerate tools itself, so the catalog
   * is handed to it through the config form it already reads (lib/catalog.js). It feeds both
   * sides — the panel's complete checklist and the gate's set of names the whitelist leaves
   * out — and is recomputed from the live registry on every `tools/change`. Never written by
   * the panel and never persisted — a settings edit stores only the paths it names — and
   * empty until the first publish, which keeps the panel's built-in fallback on a host that
   * cannot be enumerated.
   */
  toolCatalog: z.array(z.string()).default([]).volatile(),
  /** Route every `delegate` worker runs on. Empty means unconfigured, which fails loudly. */
  workerProvider: z.string().default('').volatile(),
  workerModel: z.string().default('').volatile(),
  /** Optional. Empty leaves the effort out so the worker model resolves its own default. */
  workerReasoningEffort: z.string().default('').volatile(),
  /**
   * Supervision of long-running `delegate` children. Every field is volatile and
   * read again on each scan, so a settings change applies without a restart.
   * `orchestrate` workers are deliberately not supervised: their parent waits
   * inside the tool call, so a notice would always be stale by the time it ran.
   */
  superviseEnabled: z.boolean().default(true).volatile(),
  /** How long a child may run before its parent is woken with one summary notice, in seconds. */
  superviseIntervalSeconds: z.number().min(10).max(86400).step(1).default(600).volatile(),
  /** Notices allowed per child; 0 turns supervision off unless superviseUnlimited is on. */
  superviseMaxNoticesPerChild: z.number().min(0).max(20).default(3).volatile(),
  /** Ignore the notice cap and keep supervising until the child stops, delivers, or ends. */
  superviseUnlimited: z.boolean().default(false).volatile(),
  /** Also notify when a child produced no new events; off saves a model turn. */
  superviseNotifyOnNoProgress: z.boolean().default(false).volatile(),
})

/** Read one config field whether it is a schemastery ref or a plain value. */
function configValue(config, key, fallback) {
  try {
    const field = config?.[key]
    const value = typeof field?.get === 'function' ? field.get() : field
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The host's plugin-record writer, resolved lazily.
 *
 * It is imported at call time rather than at module load: a host that does not expose
 * `@deepseek-ai/dsh-session` (an older build, or a unit test with stand-ins) would otherwise
 * fail the whole plugin at import, taking the tool gate and the delegation tools with it for a
 * feature that is only the persistence half of one switch. A miss falls back to appending a
 * plain ignorable event, which the same projection folds in this process.
 */
let pluginRecordModule
async function loadPluginRecord() {
  if (pluginRecordModule === undefined) {
    pluginRecordModule = import('@deepseek-ai/dsh-session').catch(() => null)
  }
  return pluginRecordModule
}

/**
 * Shape a definition the way the host's `defineTool` does, for a host whose copy of
 * `@deepseek-ai/dsh-tools` the profile cannot resolve.
 *
 * The host's own function is preferred whenever it is reachable, because it owns the
 * argument/output schema conversion and the presenter defaults this fallback only
 * approximates. The fallback covers exactly what the two tools here need: a name, a
 * description, the raw parameter/output spec objects the registry renders from, an
 * `execute` that the registry calls, and pass-through presenters.
 */
function localDefineTool(options) {
  const tool = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output?.schema,
      render: options.output?.render,
      presentationMeta: options.output?.presentationMeta,
    },
    execute: options.execute,
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (options.isConcurrencySafe !== undefined) tool.isConcurrencySafe = options.isConcurrencySafe
  if (options.finalizeContent !== undefined) tool.finalizeContent = options.finalizeContent
  if (options.projectContent !== undefined) tool.projectContent = options.projectContent
  if (options.presentCall !== undefined) tool.presentCall = options.presentCall
  if (options.presentResult !== undefined) tool.presentResult = options.presentResult
  return tool
}

/**
 * The host's `defineTool`, or the local shaper when this host cannot offer it.
 *
 * Resolved with a top-level await rather than a plain static import on purpose.
 *
 * `defineTool` only shapes a definition — schema conversion plus wrapper wiring — and holds
 * no registry state, so either implementation produces a usable tool. A STATIC import,
 * however, forces the profile to resolve `@deepseek-ai/dsh-tools`, and that is what breaks a
 * profile: installing that package explicitly gives the host a SECOND copy of the tool
 * service beside the one the runtime already mounted. Every core tool (`read`, `glob`,
 * `skill`, `subagent`, …) then registers twice and every session fails to resume with
 * `tool "read" is already registered`. Resolving here, with a fallback, keeps this plugin
 * loadable whether or not the profile carries that package.
 *
 * `apply` stays synchronous: the host imports a plugin entry as a module, so top-level
 * await settles before any of its exports are used.
 */
const defineTool = await (async () => {
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    if (typeof module?.defineTool === 'function') return module.defineTool
  } catch {
    // A host without that package is expected: the local shaper covers this plugin's needs.
  }
  return localDefineTool
})()

/** Write one plugin record, honouring the host's writer when it is available. */
export function appendModeRecord(appendPluginRecord, session, type, data) {
  if (typeof appendPluginRecord === 'function') return appendPluginRecord(session, type, data)
  // The fallback is the same envelope the host's writer builds: an ignorable event whose type
  // is outside `SessionEventMap`, so it never enters the model-visible surface.
  return session.append(type, data, { ignorable: true })
}

/**
 * The host's host-protocol entry for one plugin-authored child prompt.
 *
 * `subagents.sendMessage` requires the exact live sender agent, so a plugin cannot use it
 * without impersonating the parent. This symbol-keyed entry is the supported alternative:
 * it takes a durable `source` descriptor, and `'queue'` makes the prompt a distinct new
 * turn — which is what a retry needs, because the child that failed is not running one.
 */
const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt')

/**
 * Queue one plugin-authored turn on a delegated child, cold-resuming it when it is gone.
 * Exported so the adapter can be driven with plain objects instead of a running host.
 */
export async function deliverRetryPrompt(ctx, parentId, childId, text) {
  const deliver = ctx?.subagents?.[DELIVER_PROMPT]
  if (typeof deliver !== 'function') throw new Error('the host does not expose dsh.subagent.deliverPrompt')
  const parent = ctx?.agents?.get?.(parentId)
  if (parent === undefined || parent === null) throw new Error(`the main agent ${parentId} is not live`)
  const source = { kind: RETRY_SOURCE_KIND, form: 'notice' }
  return deliver.call(ctx.subagents, parent, childId, [{ type: 'text', text }], source, new AbortController().signal, 'queue')
}

/**
 * Build the host side of supervision: the four adapters `createSupervisor`
 * needs, bound to the live registries. Exported so tests can drive the
 * adapters with plain objects instead of a running host.
 *
 * `loadLlm` is injectable only so the lazy import can be exercised without the
 * host package: production always uses the dynamic `@deepseek-ai/dsh-llm`
 * import, which is never a top-level import (the plugin must load even when the
 * package is not resolvable in a unit test).
 */
export function createSupervision({ ctx, config, logger = ctx?.logger, loadLlm = () => import('@deepseek-ai/dsh-llm') }) {
  let pendingWarned = false
  let llmWarned = false
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // A logger must never break the timer or a dispatch.
    }
  }

  /** `ctx.agents.get(id)` returning undefined is the host's "not live" answer. */
  const isParentAlive = (parentId) => ctx?.agents?.get?.(parentId) !== undefined
  const isChildAlive = (childId) => ctx?.agents?.get?.(childId) !== undefined

  /**
   * The child's own session log. `Session.log` is the append-only event array
   * (`seq`, `time`, `type`, `data`); the supervisor reads it directly, which
   * costs no model tokens.
   */
  const readEvents = (childId) => {
    const session = ctx?.sessions?.get?.(childId)
    if (session === undefined || session === null) throw new Error(`no live session for child ${childId}`)
    if (!Array.isArray(session.log)) throw new Error(`session ${childId} has no readable event log`)
    return session.log
  }

  /**
   * Whether the parent already has an undelivered supervision notice. The inbox
   * projection state is `{ 'next-turn': Message[], 'next-step': Message[] }`;
   * its shape is not a declared public API, so every failure here is swallowed:
   * returning false risks one duplicate notice, while throwing would make the
   * supervisor treat every parent as always pending.
   */
  const hasPendingNotice = (parentId) => {
    const parent = ctx?.agents?.get?.(parentId)
    if (parent === undefined || parent === null) return false
    try {
      const stateOf = ctx?.sessionProjections?.stateOf
      if (typeof stateOf !== 'function') throw new Error('sessionProjections.stateOf is unavailable')
      const state = stateOf.call(ctx.sessionProjections, parent.session, 'inbox')
      if (state === undefined || state === null) throw new Error('the inbox projection returned no state')
      for (const bucket of ['next-turn', 'next-step']) {
        const pending = state[bucket]
        if (!Array.isArray(pending)) continue
        for (const message of pending) {
          if (message?.source?.kind === SUPERVISE_SOURCE_KIND) return true
        }
      }
      return false
    } catch (error) {
      if (!pendingWarned) {
        pendingWarned = true
        warn(`orchestrator: supervision: cannot read the parent inbox; duplicate notices are possible: ${messageOf(error)}`)
      }
      return false
    }
  }

  /**
   * Queue one notice on the parent with `followup` — never `steer`, which would
   * splice into a user turn that is already running. A missing parent is final
   * (`parent-gone`); a missing `@deepseek-ai/dsh-llm` is not fatal: return
   * `unavailable` so the supervisor logs it and keeps the notice budget.
   *
   * `kind` is the durable `source.kind` the notice carries. Supervision keeps its own
   * kind, because `hasPendingNotice` looks for exactly that kind in the parent inbox;
   * the retry policy uses a second one, so neither ever reads the other's queue.
   */
  const deliverAs = async (kind, parentId, text, childIds) => {
    const parent = ctx?.agents?.get?.(parentId)
    if (parent === undefined || parent === null) return 'parent-gone'
    // The dynamic import is not retried once it failed: the supervisor reschedules
    // without spending the child's budget, and one warning is enough.
    if (llmWarned) return 'unavailable'

    let llm
    try {
      llm = await loadLlm()
    } catch (error) {
      if (!llmWarned) {
        llmWarned = true
        warn(`orchestrator: supervision: cannot load @deepseek-ai/dsh-llm; notices are disabled: ${messageOf(error)}`)
      }
      return 'unavailable'
    }
    if (typeof llm?.createUserMessage !== 'function') {
      if (!llmWarned) {
        llmWarned = true
        warn('orchestrator: supervision: @deepseek-ai/dsh-llm does not export createUserMessage; notices are disabled')
      }
      return 'unavailable'
    }

    const source = { kind, form: 'notice' }
    if (Array.isArray(childIds) && typeof childIds[0] === 'string') source.senderSessionId = childIds[0]
    const message = llm.createUserMessage({ content: [{ type: 'text', text }], source })
    parent.followup(message)
    try {
      const flushed = await ctx?.sessions?.flush?.(parent.session)
      if (flushed === false) warn('orchestrator: supervision: the notice was queued but session flush did not acknowledge it')
    } catch (error) {
      warn(`orchestrator: supervision: the notice was queued but session flush failed: ${messageOf(error)}`)
    }
    return 'queued'
  }

  const deliver = (parentId, text, childIds) => deliverAs(SUPERVISE_SOURCE_KIND, parentId, text, childIds)

  /** The retry notice: same delivery, its own `source.kind`. */
  const deliverRetry = (parentId, text, childIds) => deliverAs(RETRY_SOURCE_KIND, parentId, text, childIds)

  // Live getters: an interval change applies without rebuilding the supervisor.
  const liveConfig = {
    get enabled() {
      return configValue(config, 'superviseEnabled', true) !== false
    },
    get intervalSeconds() {
      return configValue(config, 'superviseIntervalSeconds', 600)
    },
    get maxNoticesPerChild() {
      return configValue(config, 'superviseMaxNoticesPerChild', 3)
    },
    get unlimited() {
      return configValue(config, 'superviseUnlimited', false) === true
    },
    get notifyOnNoProgress() {
      return configValue(config, 'superviseNotifyOnNoProgress', false) === true
    },
  }

  const supervisor = createSupervisor({
    config: liveConfig,
    now: () => Date.now(),
    isParentAlive,
    isChildAlive,
    readEvents,
    hasPendingNotice,
    deliver,
    logger,
  })

  /**
   * The highest `seq` in the child's log right now. A cold-resumed worker re-enters the
   * registry with this as its baseline, so its pre-interrupt history is not summarised
   * again as new activity. An unreadable log is simply "no baseline".
   */
  const headSeq = (childId) => {
    let head = 0
    try {
      for (const event of readEvents(childId)) {
        const seq = event?.seq
        if (typeof seq === 'number' && Number.isFinite(seq) && seq > head) head = seq
      }
    } catch {
      return 0
    }
    return head
  }

  return { supervisor, isParentAlive, isChildAlive, readEvents, headSeq, hasPendingNotice, deliver, deliverRetry }
}

/**
 * The `onStarted` callback for the delegate tool: register the child, and drop
 * it once its receipt settles (either way). `onResumed` re-arms that same child when a
 * `send_message` cold resume recreates it. Exported for the same reason as
 * `createSupervision` — a plain recording object is enough to test it.
 */
export function createSupervisionHooks(supervisor, { headSeq, retry } = {}) {
  const forget = (childId) => {
    try {
      supervisor.forget(childId)
    } catch {
      // A registry failure here cannot affect the dispatch either.
    }
  }

  /**
   * The children this plugin dispatched itself, oldest first. Only these may be re-armed
   * by a cold resume: the host's own `subagent` tool also creates delegated children, and
   * they never entered supervision, so resuming one must not start a timer on it. The map
   * is bounded because a long-lived host never reports a worker gone for good.
   */
  const dispatched = new Map()
  const MAX_DISPATCHED = 128
  const remember = (childId, record) => {
    dispatched.delete(childId)
    dispatched.set(childId, record)
    while (dispatched.size > MAX_DISPATCHED) {
      const oldest = dispatched.keys().next().value
      dispatched.delete(oldest)
    }
  }

  const baselineOf = (childId) => {
    try {
      const value = typeof headSeq === 'function' ? headSeq(childId) : undefined
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }

  return {
    onStarted(parent, started, args) {
      const childId = started?.childId
      const parentId = parent?.id
      if (typeof childId !== 'string' || typeof parentId !== 'string') return
      remember(childId, { parentId, label: args?.description })
      // The retry policy keys on the same record: a child this plugin did not dispatch is
      // never retried, so the host's own `subagent` children stay untouched.
      try {
        retry?.track?.(childId, { parentId, label: args?.description })
      } catch {
        // A retry bookkeeping failure cannot affect the dispatch.
      }
      try {
        supervisor.track({ childId, parentId, label: args?.description, startedAt: Date.now() })
      } catch {
        // Still subscribe to the receipt below: an untracked child is harmless.
      }
      const settled = started?.result
      if (settled !== null && typeof settled === 'object' && typeof settled.then === 'function') {
        try {
          settled.then(() => forget(childId), () => forget(childId))
        } catch {
          // A hostile thenable must not break the dispatch.
        }
      }
    },

    /**
     * A cold resume is a fresh activation of a worker the receipt once released, so the
     * registry has no entry for it any more. Re-arm it from the dispatch record (the host
     * gives no `result` here, so cleanup falls back to the liveness, budget and parent
     * rules inside the supervisor). A child this plugin never dispatched, or one already
     * tracked, is left alone — a repeated event must not restart the clock or the budget.
     */
    onResumed(agent) {
      const childId = agent?.id
      if (typeof childId !== 'string' || childId === '') return
      const record = dispatched.get(childId)
      if (record === undefined) return
      try {
        if (typeof supervisor.has === 'function' && supervisor.has(childId)) return
      } catch {
        // An unreadable registry means "no entry"; re-tracking is idempotent anyway.
      }
      try {
        supervisor.track({
          childId,
          parentId: record.parentId,
          label: record.label,
          startedAt: Date.now(),
          resumed: true,
          sinceSeq: baselineOf(childId),
        })
      } catch {
        // Supervision is best-effort; the resumed worker still runs without it.
      }
    },

    forget,
  }
}

export function apply(ctx, config) {
  ctx.sessionProjections.register(stageProjection)

  /**
   * Dispatch mode is per session. It lives in each conversation's own log as a plugin record,
   * and this projection folds it back — the same mechanism the native `plan` mode uses. No
   * shared switch is read anywhere, so two open conversations can hold two different modes at
   * the same time, which is exactly what the plugin-global `enabled` field got wrong.
   *
   * The registration answers with a promise, so the store starts on its in-memory copy and
   * adopts the real reader as soon as the handle arrives: a request that beats the
   * registration still sees the mode the user just chose.
   */
  // The configured default only decides how a session that never chose a mode starts; it is
  // read once at mount, so a later edit affects new sessions, never a conversation in flight.
  const modeDefault = configValue(config, 'enabled', true) !== false
  const modeStore = createModeStore({ defaultEnabled: modeDefault })
  const modeProjection = ctx.sessionProjections.register(createModeProjection(zod, { defaultEnabled: modeDefault }))
  if (modeProjection !== undefined && modeProjection !== null) {
    void Promise.resolve(modeProjection).then(
      (handle) => modeStore.attach(handle),
      (error) => {
        modeStore.warnOnce(ctx.logger, `orchestrator: the dispatch-mode projection did not register: ${messageOf(error)}`)
      },
    )
  }

  /**
   * Write one session's dispatch mode. The record goes into that session's own log, so the
   * mode survives resume and fork and never touches another conversation. A host without
   * `appendPluginRecord` (or a log that refuses the write) still gets the in-memory copy, so
   * the switch keeps working for the live process even when it cannot be persisted.
   */
  const writeMode = async (session, enabled) => {
    if (session === undefined || session === null) return false
    modeStore.remember(session, enabled)
    try {
      const host = await loadPluginRecord()
      appendModeRecord(host?.appendPluginRecord, session, MODE_RECORD_TYPE, { enabled })
      return true
    } catch (error) {
      modeStore.warnOnce(
        ctx.logger,
        `orchestrator: the dispatch mode could not be recorded in the session log; it applies to this process only: ${messageOf(error)}`,
      )
      return false
    }
  }

  /**
   * The client half of the switch. A web client cannot write per-session config (the settings
   * form is the plugin namespace), so it flips the mode through the command channel the host
   * already carries to a specific agent — the same route the native `/plan` toggle uses.
   */
  const MODE_COMMAND = 'orchestrator-mode'
  // A host that never mounted the commands service simply has no switch channel; the tools
  // and the gate still work, so this is skipped rather than treated as a load failure.
  if (typeof ctx.inject === 'function') ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'orchestrator-mode',
      name: MODE_COMMAND,
      description: 'Turn this session\'s dispatch mode on or off',
      input: { hint: '[on|off]' },
      handler: async ({ agent, rawInput }) => {
        const session = agent?.session
        if (session === undefined || session === null) {
          return { kind: 'error', text: 'This session is not available.' }
        }
        const argument = String(rawInput ?? '').trim()
        // No argument flips the current mode, which is what a one-tap switch needs.
        const next = argument === 'on' ? true : argument === 'off' ? false : !modeStore.enabledOf(session)
        // The in-memory copy is already in place, so the next request is correct even while
        // the record write settles.
        await writeMode(session, next)
        return {
          kind: 'success',
          text: next ? 'Dispatch mode on for this session.' : 'Dispatch mode off for this session.',
        }
      },
    })
  })

  const supervision = createSupervision({ ctx, config })

  // A child that dies without a closing message is woken again on the same durable session,
  // so the work already in the workspace is not thrown away; the policy (lib/retry.js) owns
  // the budget, and waking the main agent reuses the supervision delivery.
  const retry = createRetry({
    deliverPrompt: (parentId, childId, text) => deliverRetryPrompt(ctx, parentId, childId, text),
    wakeParent: supervision.deliverRetry,
    logger: ctx.logger,
  })
  const hooks = createSupervisionHooks(supervision.supervisor, { headSeq: supervision.headSeq, retry })

  // The rule text the delegation tools show names exactly the tools the gate allows,
  // read from the same effective whitelist, so the prompt cannot drift from the
  // enforcement even when a profile checks a different set. The list is a function
  // because `allowedTools` is volatile: the tools re-read it when their description is
  // rendered, and the guard re-reads it on every call.
  const allowedTools = () =>
    effectiveAllowed(configValue(config, 'allowedTools', undefined), DEFAULT_ALLOWED_TOOLS)

  // One registration for every agent; children get it too and are bounded by maxDepth.
  // A child has both names masked away below, so one definition per tool is enough.
  const delegateTool = createDelegateTool({
    defineTool,
    subagents: ctx.subagents,
    config,
    onStarted: hooks.onStarted,
    allowedTools,
  })
  const orchestrateTool = createOrchestrateTool({ defineTool, subagents: ctx.subagents, config })
  ctx.effect(() => ctx.tools.register(delegateTool), 'orchestrator: delegate tool')
  ctx.effect(() => ctx.tools.register(orchestrateTool), `orchestrator: ${ORCHESTRATE_TOOL} tool`)

  /**
   * The live guard of every gated main agent, keyed by agent id. One predicate covers every
   * name — global, scope-local, and calls nested inside `run_code` — so nothing has to be
   * rebuilt when the panel or the registry changes; it is dropped with the agent.
   */
  const gates = new Map()

  /**
   * The dispatch switch, asked per session. Every caller passes the session whose work is
   * being gated, so two conversations can never see each other's mode.
   */
  const modeEnabled = (session) => modeStore.enabledOf(session)

  const installFor = (agent) => installGate({ agent, allowed: allowedTools, enabled: modeEnabled })

  /**
   * The Allowed Tools panel must offer every tool the host really has, including the ones
   * other plugins and MCP servers register after this plugin loaded. A web client cannot
   * enumerate tools, so the catalog is published through this plugin's config
   * (lib/catalog.js) and announced on the settings event the client mirror refreshes on.
   * A burst of registrations is one debounced read, and an unchanged catalog publishes
   * nothing at all. The first read runs here: later registrations announce themselves on
   * `tools/change`.
   */
  const catalog = createCatalogPublisher({ ctx, config })
  ctx.effect(() => () => catalog.dispose(), 'orchestrator: tool catalog')
  ctx.on('tools/change', () => {
    // Publishing keeps the panel's checklist complete. Nothing else has to happen: the
    // model-facing table is filtered per request by the surface wrapper below.
    catalog.schedule()
  })
  catalog.publish()

  /**
   * The model-facing tool table is cut at the single exit the host builds it from:
   * `ctx.tools.definitions(scope, toolSet)`. Wrapping it makes the main agent's whitelist
   * and a child's own deny list apply from the very first request of a session, without a
   * single `tools.restrict` call — and therefore without the `tools/change` storm that used
   * to make `dsh-ops` hide and re-hide the official `read`/`glob`/`grep` on every dispatch
   * (a request built inside that window saw them appear, the next saw them vanish, and the
   * cached prompt prefix was lost each time).
   */
  ctx.effect(
    () =>
      installToolSurface({
        tools: ctx.tools,
        allowed: allowedTools,
        enabled: modeEnabled,
      }),
    'orchestrator: tool surface',
  )

  // The host may not mount cordis-plugin-timer, so use the platform timer through
  // the existing effect lifecycle. The period is fixed at 5 s because a tick only
  // compares clocks; a child's log is read only once it is due, so this keeps the
  // 10-second minimum interval prompt without a configurable scan. `unref` keeps a
  // short-lived CLI test process from hanging on an interval the host would own.
  const scanMs = 5000
  ctx.effect(
    () => {
      const timer = setInterval(() => {
        void Promise.resolve(supervision.supervisor.tick()).catch((error) => {
          ctx.logger?.warn?.(`orchestrator: supervision timer: ${messageOf(error)}`)
        })
      }, scanMs)
      if (typeof timer?.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    },
    'orchestrator: supervision timer',
  )

  /**
   * The settlement edge of every delegated child. A child that stops with `error` and left
   * no text behind is the case lib/retry.js retries; anything else releases its record.
   *
   * The host dispatches this edge with the child's parent as its carrier, so the listener
   * must be global: a context-scoped listener is filtered out for a child-scoped emission.
   * The policy is async (it queues one prompt), and the emitter contains rejections, but the
   * failure is still reported here so a broken retry is visible rather than silent.
   */
  ctx.on(
    'subagent/end',
    (info) => {
      const childId = info?.id
      if (typeof childId !== 'string' || childId === '') return
      void Promise.resolve(retry.settle(childId, info, info?.runId)).catch((error) => {
        try {
          ctx.logger?.warn?.(`orchestrator: retry: cannot apply the settlement of ${childId}: ${messageOf(error)}`)
        } catch {
          // A logging failure must not escape the listener either.
        }
      })
    },
    { global: true },
  )

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    // A new root agent is the only place a preset or scope-local tool becomes visible,
    // so the catalog may have grown even though the registry itself did not change.
    catalog.schedule()
    if (agent === undefined || agent === null) return
    if (isDelegatedChild(agent)) {
      // Nothing is masked here any more: `installToolSurface` derives a child's deny list
      // from the scope itself, so the first request of a worker already lacks the pair and
      // no `tools/change` is announced. A `send_message` cold resume recreates an
      // interrupted worker, and its receipt was already settled, so supervision has
      // forgotten it; only a child this plugin dispatched is re-armed.
      if (payload?.source === 'resume') hooks.onResumed(agent)
      return
    }

    // Installed even while the switch is off: the guard follows the switch per call,
    // so turning dispatch mode on in an open conversation takes effect at once.
    const gate = installFor(agent)
    gates.set(agent.id, gate)
    // A resumed agent with a parentSession that still read as a main agent means the
    // depth test degraded: the cold-resume regression looked exactly like this.
    if (payload?.source === 'resume' && agent.session?.header?.parentSession !== undefined) {
      ctx.logger.warn(
        `orchestrator: agent ${agent.id} resumed with a parentSession but no delegation depth; gated it as a main agent`,
      )
    }
    if (!modeEnabled(agent.session)) return
    ctx.logger.info(
      `orchestrator: main agent ${agent.id}: armed whitelist gate (${gate.allowed.length} allowed: [${gate.allowed.join(', ')}])`,
    )
    if (gate.guardError !== undefined) {
      ctx.logger.warn(`orchestrator: main agent ${agent.id}: guard not installed: ${gate.guardError}`)
    }
  })

  // A gated agent that goes away takes its guard with it: the entry is the only owner of
  // the disposer, so dropping it here must not leave a predicate behind.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    const id = agent?.id
    // A root agent going away can drop its scope-local names from the catalog.
    catalog.schedule()
    if (typeof id !== 'string') return
    // A disposed worker must not keep a supervision slot: until it is resumed its session
    // is gone, and the tick would only read a dead log. A resume re-arms it above.
    if (isDelegatedChild(agent)) hooks.forget(id)
    const gate = gates.get(id)
    if (gate === undefined) return
    gates.delete(id)
    try {
      gate.dispose()
    } catch (error) {
      ctx.logger.warn(`orchestrator: main agent ${id}: cannot lift the gate: ${messageOf(error)}`)
    }
  })

  /**
   * The panel writes `enabled` and `allowedTools` as volatile config: the loader commits
   * those values into the running references and then announces the paths on this fiber.
   * Nothing has to be re-installed — the guard reads the switch per call and the surface
   * wrapper reads the whitelist per request — so this only restores the published catalog,
   * which the Loader resets to the stored default on every settings write.
   */
  ctx.on('loader/volatile-update', () => {
    // Restore it before the write's own settings read answers, so the panel never falls
    // back to its built-in copy after a checkbox click. Quietly: the settings write itself
    // already invalidated the client's document, and announcing the catalog as well made
    // every open panel re-read every namespace — the extra ~second a checkbox click cost.
    catalog.publish({ announce: false })
  })
}
