/**
 * The live tool catalog the Allowed Tools panel renders, and the candidate set the
 * gate hides from.
 *
 * A web client plugin cannot enumerate the Host's tools: the session remote exposes
 * session/model/skill methods only, and `configForms` exposes this plugin's own config.
 * The catalog therefore travels through that config: a volatile field the Host serves
 * through `settings.describe()` and every open web client mirrors. The plugin commits it
 * in memory — the same reference protocol the Loader uses for a volatile write — and then
 * announces `settings/document-updated`, the event the client-side settings mirror already
 * refreshes on.
 *
 * The catalog is the whole registered tool set, not a subset: the panel needs every name
 * to offer a complete Allowed Tools checklist, and the gate needs the same names to work
 * out which ones the whitelist leaves out. It is read-only and recomputed from the live
 * registry on every `tools/change`, so a plugin or MCP tool that registers later shows up
 * without a restart.
 *
 * Nothing here reaches the profile file: a settings edit writes only the paths it names,
 * and the panel only ever names `allowedTools`. Because the commit does not go through the
 * Loader, it also never emits `loader/volatile-update`, so refreshing the catalog cannot
 * reinstall every main agent's mask.
 */

/** The config field that carries the catalog. */
export const CATALOG_KEY = 'toolCatalog'

/** The shared reference protocol a schemastery `.volatile()` field implements. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a config field is a live volatile reference this plugin may commit. */
export function isVolatileRef(value) {
  if (typeof value !== 'object' || value === null) return false
  return typeof value.get === 'function' && typeof value[VOLATILE_WRITE] === 'function'
}

/**
 * Every name one registry view knows. `knownNames` keeps the names a restriction
 * currently hides — a tool outside the whitelist must stay listable, otherwise the
 * panel could never offer it again — while `visible` adds the scope's own
 * registrations, which a restriction never masks.
 */
export function viewNames(view) {
  const names = new Set()
  if (view === undefined || view === null) return []
  for (const name of view.knownNames ?? []) names.add(name)
  const visible = view.visible
  if (visible !== undefined && visible !== null && typeof visible.keys === 'function') {
    for (const name of visible.keys()) names.add(name)
  }
  return [...names]
}

/** Sorted, de-duplicated union of every name the given views know. */
export function catalogOf(views) {
  const names = new Set()
  for (const view of views ?? []) {
    for (const name of viewNames(view)) {
      if (typeof name === 'string' && name !== '') names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * The views that matter for the panel: the context-global one (every tool a plugin
 * registers at the top level, MCP tools included) plus each live root agent's, the only
 * place a preset tool or a scope-local tool such as the native `subagent` is visible.
 * One unreadable view never drops the others.
 */
export function collectCatalog(ctx) {
  const views = []
  try {
    if (typeof ctx?.tools?.view === 'function') views.push(ctx.tools.view())
  } catch {
    // An older registry without `view()` leaves only the agent scopes.
  }
  let roots = []
  try {
    roots = ctx?.agents?.roots?.() ?? []
  } catch {
    roots = []
  }
  for (const agent of roots) {
    try {
      const view = agent?.ctx?.tools?.view?.(agent)
      if (view !== undefined) views.push(view)
    } catch {
      // A scope that is gone, or cannot be read, contributes nothing.
    }
  }
  return catalogOf(views)
}

/** Report a failure without ever letting the report itself break the host. */
function warn(logger, message) {
  try {
    logger?.warn?.(message)
  } catch {
    // A logger must never break a refresh.
  }
}

/**
 * Keep the published catalog in step with the registry.
 *
 * `publish` reads the live views, compares the result with what is already published,
 * and — only on a real change — commits the new snapshot and announces it. `schedule`
 * debounces a burst of `tools/change` events (a plugin load registers dozens of tools)
 * into one read, so neither a burst nor an unchanged set produces more than one event.
 * `dispose` drops a pending read, so a plugin reload leaves no timer behind.
 *
 * A host whose config field is not writable (an older host, a stand-in in a unit test) is
 * reported once and otherwise ignored: the panel then keeps its built-in fallback.
 */
export function createCatalogPublisher({ ctx, config, key = CATALOG_KEY, debounceMs = 150, collect, logger = ctx?.logger }) {
  const ref = config?.[key]
  const writable = isVolatileRef(ref)
  const read = typeof collect === 'function' ? collect : () => collectCatalog(ctx)
  let published = []
  let announced = 0
  let timer
  let disposed = false
  let warned = false

  /** The settings namespace of this plugin entry: the id the profile gives the entry. */
  const namespace = () => {
    const id = ctx?.fiber?.entry?.id
    return typeof id === 'string' && id !== '' ? id : 'orchestrator'
  }

  const same = (left, right) =>
    left.length === right.length && left.every((name, index) => name === right[index])

  /** Whether the committed reference still holds the catalog (it may have been reset). */
  const refHolds = (names) => {
    try {
      return same(ref.get(), names)
    } catch {
      return false
    }
  }

  /**
   * Read the registry and publish the catalog. A change of content is committed and
   * announced; an unchanged catalog only re-commits the value when a settings write
   * reset the reference (the Loader commits the profile's raw value into every volatile
   * field it was handed), because the panel would otherwise fall back to its built-in
   * copy after every checkbox click.
   *
   * `announce: false` re-commits without emitting `settings/document-updated`. A settings
   * write already invalidates the whole document on the client, and emitting a second
   * invalidation made every open panel re-read every namespace again — the second half of the
   * one-second lag a checkbox used to have. The value is restored either way; only the extra
   * refresh is dropped.
   */
  const publish = ({ announce = true } = {}) => {
    if (disposed) return { changed: false, names: published }
    let names
    try {
      names = read()
    } catch (error) {
      warn(logger, `orchestrator: cannot read the tool catalog: ${error instanceof Error ? error.message : String(error)}`)
      return { changed: false, names: published }
    }
    // An empty read is a failed read, not an empty registry: keep the last catalog (or
    // nothing, which makes the panel fall back to its built-in copy).
    if (!Array.isArray(names) || names.length === 0) return { changed: false, names: published }
    const contentChanged = !same(published, names)
    if (!contentChanged && (!writable || refHolds(names))) return { changed: false, names: published }
    if (!writable) {
      // A host whose field is a plain value cannot be served; report it once and stop.
      published = names
      if (!warned) {
        warned = true
        warn(logger, 'orchestrator: the tool catalog is not publishable: the config field is not a volatile reference')
      }
      return { changed: contentChanged, names: published }
    }
    published = names
    try {
      ref[VOLATILE_WRITE](names)
    } catch (error) {
      warn(logger, `orchestrator: cannot publish the tool catalog: ${error instanceof Error ? error.message : String(error)}`)
      return { changed: false, names: published }
    }
    // A quiet re-commit restores the value the Loader reset; the write already invalidated
    // the client, so a second announcement would only cost another full settings read.
    if (announce === false) return { changed: contentChanged, names }
    announced += 1
    try {
      ctx?.emit?.('settings/document-updated', namespace(), announced)
    } catch (error) {
      warn(logger, `orchestrator: cannot announce the tool catalog: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { changed: contentChanged, names }
  }

  /** Debounce one refresh; a second call while one is pending costs nothing. */
  const schedule = () => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      publish()
    }, debounceMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  const dispose = () => {
    disposed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return { publish, schedule, dispose, published: () => published, writable }
}
