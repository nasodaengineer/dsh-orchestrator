/**
 * The main-agent gate: the execution-time half of the whitelist. Dependency-free, so the
 * whole gate can be tested without the DSH runtime.
 *
 * The gate is whitelist-driven: only the tools named by the live Allowed Tools list stay
 * available to a main agent. The model-facing half lives in `lib/tool-surface.js`, which
 * filters `tools.definitions()` — the one call a request's tool declarations and prompt
 * blocks are built from. This module is what makes the whitelist real when the model asks
 * anyway: `tools.guard` runs before a tool body and refuses every name the list leaves out,
 * including the scope-local tools `tools.restrict` cannot hide (the native `subagent`, every
 * `ops_*` tool) and calls nested inside `run_code`.
 *
 * Why no `tools.restrict` here any more: every restriction (and every dispose) announces
 * `tools/change`, and `dsh-ops` reacts to that event by clearing its official
 * `read`/`glob`/`grep` shadows and re-installing them from an async retry queue. A main
 * agent's ~30 restrictions therefore fanned out into a mask storm, and a request assembled
 * in the window saw a table that gained and lost three tools — rewriting the cached prompt
 * prefix twice. The surface wrapper is event-free, so the guard is all that is left.
 *
 * The gate follows the dispatch switch instead of the moment an agent was created: it is
 * installed for every top-level agent and reads `enabled()` on each call, so turning the
 * switch on in an already open conversation takes effect at once.
 *
 * Every name is allow-listed, the two delegation tools included: the panel offers the whole
 * catalog, only the checked names stay callable, and the guard refuses exactly what the
 * whitelist leaves out.
 *
 * One name needs more than a name check. `run_code` is the PTC transport: it is the one
 * tool a main agent may call directly, and dropping it would take `tools.delegate` with it.
 * The guard lets it through unless the panel checks it explicitly, and reads the call's own
 * arguments instead — see `run-code-guard.js` for the two escapes it closes (a sandbox
 * escalation on the call, and a program that reaches the Node.js runtime instead of going
 * through `tools.*`).
 */

import { DELEGATE_TOOL } from './api.js'
import { RUN_CODE_TOOL, runCodeRefusal } from './run-code-guard.js'

export { DELEGATE_TOOL }

/**
 * Whether an agent is a delegated child. Mirrors the host's `delegationDepthOf`
 * (`Math.max(header.delegationDepth ?? 0, options.subagentDepth ?? 0)`): the
 * persisted session header is the authoritative, monotonic record, and it is the
 * only depth that survives a cold resume. A resumed child is rebuilt from options
 * holding just provider/model/effort, with no `subagentDepth`, so reading the live
 * options alone would misclassify it as the main agent; the runtime value may only
 * deepen the depth, never lower it. A dirty value (negative, fractional, NaN, a
 * string) is treated as absent instead of throwing, because a throw inside the
 * `agent/created` hook would break the host's announce path. A GUI fork is a new
 * root session — it has a `parentSession` but a depth of zero — so it is still
 * gated as a main agent, which is why the test is depth-based, not origin-based.
 */
export function isDelegatedChild(agent) {
  const runtime = agent?.options?.subagentDepth
  const persisted = agent?.session?.header?.delegationDepth
  const floor = Number.isSafeInteger(persisted) && persisted > 0 ? persisted : 0
  const live = Number.isSafeInteger(runtime) && runtime > 0 ? runtime : 0
  return Math.max(floor, live) > 0
}

/**
 * Restrict one tool at a time. `tools.restrict` throws for a name the agent does
 * not inherit, so a single unknown name must not discard the others. Each
 * restriction hands back its disposer, so the gate can be lifted again.
 */
export function restrictEach(agent, names) {
  const applied = []
  const skipped = []
  const disposers = []
  for (const tool of names) {
    try {
      const dispose = agent.ctx.tools.restrict({ deny: [tool] })
      applied.push(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      skipped.push(`${tool} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { applied, skipped, disposers }
}

/** Non-empty strings only, in first-seen order. */
function cleanNames(names) {
  const seen = new Set()
  for (const name of names ?? []) {
    if (typeof name === 'string' && name !== '') seen.add(name)
  }
  return [...seen]
}

/**
 * The effective allow list, read live by the gate.
 *
 * A whitelist is driven only by what it names, so it never merges the shipped default
 * with the profile's value: a profile that spells out `allowedTools` replaces the schema
 * default instead of extending it. `undefined`/`null` means "not configured yet" and falls
 * back to `defaults`; an array — the empty array included — is used as given, so unchecking
 * every box in the panel disables every tool instead of resurrecting the default. Duplicates
 * and non-string entries are dropped.
 */
export function effectiveAllowed(configured, defaults = []) {
  const source = configured === undefined || configured === null ? defaults : configured
  return cleanNames(source)
}

/**
 * The tools a whitelist leaves out: every catalog name that is neither allowed nor the
 * reserved `run_code` transport. Kept as a pure helper (the panel and older callers use it);
 * the model-facing filter itself is `installToolSurface` in `lib/tool-surface.js`.
 */
export function hiddenTools(catalog, allowed) {
  const allowedSet = new Set(cleanNames(allowed))
  const hidden = []
  const seen = new Set()
  for (const name of catalog ?? []) {
    if (typeof name !== 'string' || name === '') continue
    if (name === RUN_CODE_TOOL || allowedSet.has(name) || seen.has(name)) continue
    seen.add(name)
    hidden.push(name)
  }
  return hidden
}

/**
 * The refusal for one tool outside the whitelist. One home for the text, so a name check
 * and the `run_code` argument check can never drift into two slightly different messages.
 */
function refusalFor(tool) {
  return `orchestrator: "${tool}" is not available to the main agent. The main agent only plans; hand every action to a worker with the delegate or orchestrate tools.`
}

/**
 * Build a whitelist guard predicate for a fixed list. Kept separate from `installGate`,
 * which reads its list per call.
 *
 * An allowed name passes untouched, `run_code` included: a profile that checks the
 * transport in the panel gets the plain pass. Only a name outside the list is refused, and
 * `run_code` gets the argument check instead, because the transport itself must stay
 * callable while the arguments that would escape the gate are refused.
 */
export function allowGuard(allowed) {
  const allowedSet = new Set(cleanNames(allowed))
  return (exec) => {
    const tool = exec?.name
    if (typeof tool !== 'string' || tool === '') return undefined
    if (allowedSet.has(tool)) return undefined
    if (tool === RUN_CODE_TOOL) return runCodeRefusal(exec?.arguments, true)
    return refusalFor(tool)
  }
}

/**
 * Install a switch-aware, whitelist-driven guard on one top-level agent.
 *
 * `allowed()` and `enabled()` are read live; `allowed` accepts a plain array too, for tests
 * and callers without a live config. Nothing is restricted: the model-facing half is the
 * `tools.definitions()` wrapper in `lib/tool-surface.js`, and this guard is what refuses a
 * call the model makes anyway — a hallucinated name, a scope-local tool such as `subagent`,
 * or a `run_code` program that would reach the host. A guard failure is reported, not
 * thrown: a broken gate must not break agent creation.
 *
 * `enabled` is asked per call with the session whose tool call is being guarded, so the answer
 * belongs to that conversation alone. Reading one shared switch here was the cross-session
 * bleed: session B flipping dispatch mode changed what session A's next call was allowed to
 * do. The predicate is called with the executing agent's session when the host supplies one,
 * and with this gate's own agent session otherwise, so a host that reports only the agent
 * still gates the right conversation.
 */
export function installGate({ agent, allowed, enabled = () => true }) {
  const liveAllowed = typeof allowed === 'function' ? allowed : () => allowed ?? []
  let guardError
  let guardDispose
  try {
    guardDispose = agent.ctx.tools.guard((exec) => {
      if (!enabled(exec?.agent?.session ?? agent?.session)) return undefined
      const tool = exec?.name
      if (typeof tool !== 'string' || tool === '') return undefined
      const list = liveAllowed()
      if (list.includes(tool)) return undefined
      // `run_code` is the PTC transport: it stays callable unless the panel checks it, and
      // the arguments that would escape the gate are refused instead.
      if (tool === RUN_CODE_TOOL) return runCodeRefusal(exec?.arguments, true)
      return refusalFor(tool)
    })
  } catch (error) {
    guardError = error instanceof Error ? error.message : String(error)
  }
  return {
    allowed: [...liveAllowed()],
    guardError,
    /** Unregister the guard. A second call is a no-op. */
    dispose: () => {
      if (typeof guardDispose === 'function') guardDispose()
    },
  }
}
