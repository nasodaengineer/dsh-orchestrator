/**
 * The model-facing tool surface. Everything a request carries about tools — the `tools`
 * declaration array, the executor's own sections and a plugin's prompt blocks such as
 * `# Bash command execution: ops_bash` — is built from one host call:
 * `tools.definitions(scope, toolSet)`. Wrapping that call is therefore the only place a
 * mask can be both complete and quiet.
 *
 * Complete, because `tools.restrict` only hides INHERITED (global) tools. A tool a plugin
 * registers in the agent's own scope — every `ops_*` tool, the native `subagent` — stays
 * visible unconditionally, and `restrict` throws `unknown global tool` for it.
 *
 * Quiet, because every `restrict`/dispose pair announces `tools/change`, and listeners
 * react by churning the table: `dsh-ops` clears the official `read`/`glob`/`grep` shadows
 * on that event and re-installs them from an async retry queue (25/100/400/1000 ms). A
 * request assembled inside that window saw the official tools, the next one saw them gone:
 * the table gained 3 and lost 3, the cached prompt prefix was rewritten twice, and the
 * conversation cache was lost with it.
 *
 * The wrapper reads the live whitelist (main agent) or a fixed deny list (delegated child)
 * at request time, so a panel write or a switch flip applies from the very next request
 * without a single event. It also shadows the official `read`/`glob`/`grep` as soon as
 * their `dsh-ops` replacement is registered — the state the async hide queue is heading to
 * — so the transient leak never reaches a request.
 */

import { AGENT_ADMIN_TOOL, DELEGATE_TOOL, ORCHESTRATE_TOOL } from './api.js'
import { viewNames } from './catalog.js'
import { effectiveAllowed, isDelegatedChild } from './gate.js'
import { RUN_CODE_TOOL } from './run-code-guard.js'

/**
 * The official tool a `dsh-ops` replacement stands in for, used only when both are
 * registered. `bash`/`pwsh` are deliberately absent: whether `pwsh` is hidden is a user
 * setting (`hidePwsh`), not a rule, and the observed churn is limited to these three.
 */
export const OFFICIAL_SHADOW = Object.freeze([
  ['read', 'ops_inspect_local_file'],
  ['glob', 'ops_glob'],
  ['grep', 'ops_grep'],
])

/** One wrapper per tool service, so a second install is a no-op with the same disposer. */
const SURFACE = Symbol.for('dsh-orchestrator.toolSurface')

/** A name a definition carries, or `''` for a shape this wrapper does not understand. */
function nameOf(definition) {
  const name = definition?.name
  return typeof name === 'string' ? name : ''
}

/**
 * Install the filtering wrapper on `tools.definitions`.
 *
 * `allowed` is the live Allowed Tools whitelist (a plain array is accepted too), `enabled`
 * is the per-session dispatch switch, asked with the session the request is built for, and
 * `workerDeny` the names a delegated child must not see — the delegation pair plus the
 * main agent's subagent-management tool, because a worker that could send or interrupt its
 * siblings would escape the planner's authority. The call returns a disposer that
 * restores the original `definitions`; a second install on the same service hands back the
 * first disposer instead of stacking wrappers.
 */
export function installToolSurface({
  tools,
  allowed,
  enabled = () => true,
  workerDeny = [DELEGATE_TOOL, ORCHESTRATE_TOOL, AGENT_ADMIN_TOOL],
  shadow = OFFICIAL_SHADOW,
} = {}) {
  if (tools === undefined || tools === null || typeof tools.definitions !== 'function') return () => {}
  const installed = tools[SURFACE]
  if (installed !== undefined) return installed.dispose

  const original = tools.definitions
  const liveAllowed = typeof allowed === 'function' ? allowed : () => allowed ?? []
  const deny = new Set(workerDeny ?? [])
  const pairs = (shadow ?? []).filter((entry) => Array.isArray(entry) && entry.length === 2)

  /**
   * The names this request already carries, plus whatever the scope's registry view knows.
   * The list matters as much as the view: a replacement registered for this very request is
   * in the list even when the view is unreadable.
   */
  const presentNames = (service, scope, list) => {
    const present = new Set()
    for (const definition of list) {
      const name = nameOf(definition)
      if (name !== '') present.add(name)
    }
    try {
      const view = typeof service?.view === 'function' ? service.view(scope) : undefined
      for (const name of viewNames(view)) present.add(name)
    } catch {
      // An unreadable view leaves the list's own names; the filter still applies.
    }
    return present
  }

  /** Official names whose replacement is registered: hide them whatever the queue says. */
  const shadowedOf = (present) => {
    const hidden = new Set()
    for (const [official, replacement] of pairs) {
      if (present.has(replacement)) hidden.add(official)
    }
    return hidden
  }

  const mainSurface = (list, present) => {
    const allow = new Set(effectiveAllowed(liveAllowed(), []))
    const shadowed = shadowedOf(present)
    return list.filter((definition) => {
      const name = nameOf(definition)
      if (name === '') return true
      // `run_code` is the PTC transport: delegate/orchestrate are SDK functions inside it,
      // so dropping it would leave a PTC session with no way to delegate at all. A host in
      // native mode never lists it, and the argument guard still covers the escapes.
      if (name === RUN_CODE_TOOL) return true
      return allow.has(name) && !shadowed.has(name)
    })
  }

  const workerSurface = (list, present) => {
    const shadowed = shadowedOf(present)
    return list.filter((definition) => {
      const name = nameOf(definition)
      if (name === '') return true
      return !deny.has(name) && !shadowed.has(name)
    })
  }

  const definitions = function definitions(scope, toolSet) {
    // `this` is the service the host called through; fall back to the one we wrapped.
    const service = this ?? tools
    const list = original.call(service, scope, toolSet)
    if (!Array.isArray(list)) return list
    // The context-global view feeds the Allowed Tools panel: it must stay complete.
    if (scope === undefined || scope === null) return list
    // The switch belongs to the session this request is being built for. Asking one shared
    // flag here let a second conversation's toggle rewrite this one's tool table.
    if (!enabled(scope?.session)) return list
    const present = presentNames(service, scope, list)
    return isDelegatedChild(scope) ? workerSurface(list, present) : mainSurface(list, present)
  }

  tools.definitions = definitions
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (tools.definitions === definitions) tools.definitions = original
    if (tools[SURFACE]?.dispose === dispose) delete tools[SURFACE]
  }
  tools[SURFACE] = { dispose }
  return dispose
}