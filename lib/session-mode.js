/**
 * Session-scoped dispatch mode.
 *
 * The switch used to be a plugin-global volatile config field. A web client cannot write
 * per-session config (the settings namespace is the plugin entry, not a session), so the
 * only shared value an open conversation A could read was the one conversation B had just
 * written — which is exactly the cross-session bleed this module removes.
 *
 * The host's own session-scoped state channel is the plugin record: a JSON event marked
 * `ignorable`, outside `SessionEventMap`, retained by resume and fork, and folded back by a
 * projection (`dsh-action-cards` and `dsh-experimental-forge-session` store state this way).
 * This module owns that record type, the projection that folds it, and the tiny service the
 * gate and the tool surface read per request.
 *
 * Why a projection and not the raw log: the gate runs on every tool call, so the read must
 * be O(1) and must see the log prefix exactly once. `sessionProjections.register` gives an
 * incremented cell per session — the same mechanism the native `plan` mode uses — so a
 * resumed session replays its records and an untouched session simply reads its initial
 * `false`.
 *
 * Dependency-free on purpose: the plugin entry passes the two host functions in
 * (`appendRecord`, `pluginRecordOf`) so this module stays importable from a plain unit test.
 */

/** The plugin record type this plugin owns. Grammar: `plugin:` + lowercase segments. */
export const MODE_RECORD_TYPE = 'plugin:dsh-orchestrator/dispatch-mode'

/** The projection key its state is published under. */
export const MODE_PROJECTION_KEY = 'orchestratorMode'

/**
 * The state a session starts from before its first record.
 *
 * The default stays a plugin setting (`false` here, raised to the configured default by the
 * entry): a conversation that never recorded a mode should behave like every other untouched
 * conversation, and must not inherit one another conversation happened to flip.
 */
export const DEFAULT_MODE = Object.freeze({ enabled: false })

/** The other start state: a host whose `enabled` default is on. */
export const ENABLED_MODE = Object.freeze({ enabled: true })

/** The start state for one host, given that host's configured default. */
export function initialMode(defaultEnabled = false) {
  return defaultEnabled ? ENABLED_MODE : DEFAULT_MODE
}

/**
 * Fold one committed event into the mode state.
 *
 * Only this plugin's own record moves the state, and `pluginRecordOf` returns `undefined` for
 * every other ignorable event (another plugin's record, a future event type), so an unknown
 * record can never be misread as a mode change.
 */
export function reduceMode(state, event, recordOf = defaultRecordOf) {
  // The type check comes first and costs nothing: a log is mostly other events, and the
  // projection folds every one of them.
  if (event?.type !== MODE_RECORD_TYPE) return state
  const record = recordOf(event)
  if (record?.type !== MODE_RECORD_TYPE) return state
  const enabled = record.data?.enabled
  if (typeof enabled !== 'boolean') return state
  return enabled === state.enabled ? state : { ...state, enabled }
}

/**
 * `pluginRecordOf` as the host implements it: an ignorable event whose type follows the
 * plugin-record grammar. Reproduced here only for the default argument; the plugin entry
 * always passes the host's real function.
 */
function defaultRecordOf(event) {
  if (event?.ignorable !== true) return undefined
  if (typeof event.type !== 'string' || !event.type.startsWith('plugin:')) return undefined
  return { type: event.type, seq: event.seq, time: event.time, data: event.data }
}

/**
 * The projection definition handed to `ctx.sessionProjections.register`.
 *
 * `zod` is injected rather than imported so this file has no dependency at all. The wire view
 * is what a client reads through `useProjection('orchestratorMode')`.
 */
export function createModeProjection(zod, { defaultEnabled = false } = {}) {
  return {
    key: MODE_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: zod.object({ enabled: zod.boolean() }).strict(),
    init: () => initialMode(defaultEnabled),
    apply: (state, event) => reduceMode(state, event),
    wire: {
      viewSchema: zod.object({ enabled: zod.boolean() }),
      view: (state) => ({ enabled: state.enabled }),
    },
  }
}

/**
 * The live mode of one session.
 *
 * `stateOf(session)` is the projection cell; the map is the fallback for a host (or a unit
 * test) whose projection registry does not answer synchronously, so a write still applies to
 * the very next request instead of waiting for the fold. The map is keyed by session object,
 * so it can never leak one session's mode into another.
 */
export function createModeStore({ stateOf, defaultEnabled = false } = {}) {
  const fallback = new WeakMap()
  const initial = initialMode(defaultEnabled)
  let warned = false
  // `sessionProjections.register` answers with a promise, so the reader arrives later than the
  // first request can. Keeping the handle (not a resolved value) lets every read use whatever
  // is available right now, with the in-memory copy covering the gap.
  let attached = typeof stateOf === 'function' ? stateOf : undefined

  const read = (session) => {
    if (session === undefined || session === null) return initial
    let folded
    try {
      folded = attached === undefined ? undefined : attached(session)
    } catch {
      // A projection that is not ready yet must not break a tool call: fall through.
      folded = undefined
    }
    if (folded !== undefined && folded !== null) return folded
    return fallback.get(session) ?? initial
  }

  return {
    /** Adopt the registration handle once it resolves; later reads fold the real log. */
    attach(handle) {
      if (handle === undefined || handle === null || typeof handle.stateOf !== 'function') return
      attached = (session) => handle.stateOf(session)
    },
    /**
     * Whether dispatch mode is on for this session. An absent session is never enabled: a
     * caller without a session (a context-global read) must not inherit anybody's mode.
     */
    enabledOf(session) {
      return read(session).enabled === true
    },
    /** Remember a mode that was just written, so the next request sees it immediately. */
    remember(session, enabled) {
      if (session === undefined || session === null) return
      fallback.set(session, enabled ? ENABLED_MODE : DEFAULT_MODE)
    },
    /** Report once when the projection never answers; the write path still works. */
    warnOnce(logger, message) {
      if (warned) return
      warned = true
      try {
        logger?.warn?.(message)
      } catch {
        // A logger must never break a dispatch.
      }
    },
  }
}
