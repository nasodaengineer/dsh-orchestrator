/**
 * Dispatch guards for `delegate`: an optional per-task idempotency key and an optional
 * write-scope claim. Dependency-free and synchronous, so a claim is taken in the same
 * tick as the decision to dispatch — before any `await`.
 *
 * Why this lives in the plugin and not in the host: `delegate` returns as soon as a
 * child starts, so two calls in one assistant message can both pass a model-side check
 * and start two workers that edit the same file. The guard is the execution-side answer:
 * a placeholder is stored when the call is admitted, released the instant the dispatch
 * fails, and released again when the child's receipt settles.
 *
 * Scope of the guard, stated plainly: it is process-local and it knows only the
 * dispatches this plugin made. A worker started by the host's own `subagent` tool, by
 * `orchestrate`, or by another DSH process is invisible here. That is also why a call
 * without `writeScope` claims nothing rather than everything: the guard only refuses a
 * conflict it can prove, and a false refusal would block work that is safe.
 */

/**
 * Normalise one declared write-scope entry to a comparable path.
 *
 * Slash and dot are two spellings of one path (`lib/a/b.js`, `lib\\a\\b.js`,
 * `./lib/a/../a/b.js`), so every claim is folded: backslashes become slashes, empty and
 * `.` segments are dropped, `..` pops a segment, trailing slashes go, and a trailing
 * `/**` marks a directory claim of the segments before it. Case is preserved — a
 * case-insensitive comparison would refuse two genuinely different paths on a
 * case-sensitive filesystem.
 */
export function normalizeScopePath(raw) {
  if (typeof raw !== 'string') throw new Error('delegate: every "writeScope" entry must be a string')
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('delegate: "writeScope" entries must not be empty')
  const slashed = trimmed.split('\\').join('/')
  const drive = /^[A-Za-z]:/.exec(slashed)
  const root = drive === null ? (slashed.startsWith('/') ? '/' : '') : drive[0] + '/'
  const segments = []
  for (const segment of slashed.slice(root.length).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Above the claim's own root cannot be spelled: `..` at the root is dropped, so
      // `../a` and `a` stay different claims only when the roots differ.
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return { path: root + segments.join('/'), root, segments, directory: false }
}

/** A claim: `normalizeScopePath`, plus a `/**` suffix folded into `directory`. */
function normalizeClaim(raw) {
  if (typeof raw !== 'string') throw new Error('delegate: every "writeScope" entry must be a string')
  const trimmed = raw.trim()
  const star = /[\/\\]\*\*?$/.exec(trimmed)
  if (star === null) return normalizeScopePath(trimmed)
  const base = normalizeScopePath(trimmed.slice(0, star.index))
  return { ...base, directory: true }
}

export { normalizeClaim }

/**
 * Whether two claims can touch the same file.
 *
 * Equal paths always collide. Otherwise one path must contain the other at a segment
 * boundary (`lib/a` contains `lib/a/b.js`, never `lib/ab`). A directory claim and a file
 * claim use the same test: `lib/**` is exactly `lib`, so the suffix only records what the
 * caller meant, it does not change the comparison.
 */
export function scopesOverlap(left, right) {
  if (left.path === right.path) return true
  if (left.path === '/' || right.path === '/') return true
  const contains = (outer, inner) => inner.path.startsWith(outer.path + '/')
  return contains(left, right) || contains(right, left)
}

/** One human-readable scope list, used by both the conflict text and `list`. */
export function describeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return '<unclaimed>'
  return scopes.map((scope) => `"${scope.path}${scope.directory ? '/**' : ''}"`).join(', ')
}

/**
 * The refusal for a conflicting dispatch. It names the key or the path that collided,
 * the task that already holds it, and the two ways out — because a guard that refused
 * silently would be indistinguishable from a broken tool.
 */
export function conflictError({ taskKey, scope, owner }) {
  const held = describeScopes(owner.scopes)
  const by = owner.childId === undefined ? 'a dispatch admitted in this turn' : `subagent ${owner.childId}`
  const what =
    taskKey === undefined
      ? `writeScope "${scope.path}${scope.directory ? '/**' : ''}" overlaps an active task's write scope`
      : `taskKey "${taskKey}" is already running`
  return new Error(
    `delegate: ${what}: ${by}` +
      `${owner.taskKey === undefined ? '' : ` (taskKey "${owner.taskKey}")`} claims ${held}. ` +
      'Wait for that subagent to finish, or pass a different taskKey / a writeScope that does not overlap.',
  )
}

/**
 * The live dispatch registry.
 *
 * One entry per admitted `delegate` task, keyed by the placeholder id the guard minted,
 * never by `taskKey` alone: a task that declared no key still holds its scope. Every
 * entry remembers the child id once the host reports it, so `status` can explain which
 * agent holds a claim and the release path can find it by either identity.
 */
export function createDispatchGuard({ now = () => Date.now() } = {}) {
  let counter = 0
  /** placeholder -> { taskKey, scopes, childId, parentId, startedAt } */
  const entries = new Map()
  /** childId -> placeholder, filled in when the host reports the started child. */
  const byChild = new Map()

  const activeEntries = () => [...entries.values()]

  /**
   * Admit one dispatch synchronously. Returns a claim whose `release` is idempotent,
   * or throws before anything is awaited — which is what makes two concurrent calls
   * in one assistant message unable to both win the same key or an overlapping scope.
   */
  const claim = ({ parentId, taskKey, writeScope } = {}) => {
    const key = typeof taskKey === 'string' && taskKey.trim() !== '' ? taskKey.trim() : undefined
    const scopes = []
    if (writeScope !== undefined) {
      const list = Array.isArray(writeScope) ? writeScope : [writeScope]
      if (list.length === 0) throw new Error('delegate: "writeScope" must name at least one path when provided')
      for (const raw of list) scopes.push(normalizeClaim(raw))
    }

    if (key !== undefined) {
      const owner = activeEntries().find((entry) => entry.taskKey === key)
      if (owner !== undefined) throw conflictError({ taskKey: key, owner })
    }
    for (const scope of scopes) {
      const owner = activeEntries().find((entry) => entry.scopes.some((held) => scopesOverlap(held, scope)))
      if (owner !== undefined) throw conflictError({ scope, owner })
    }

    counter += 1
    const placeholder = `dispatch-${counter}`
    const entry = { placeholder, taskKey: key, scopes, childId: undefined, parentId, startedAt: now() }
    entries.set(placeholder, entry)
    return {
      placeholder,
      entry,
      /**
       * Bind the host's child id to this claim so `snapshot`/`entryOf` can name it.
       *
       * A host that reports no usable id (undefined, '', a non-string) must not lose the
       * bookkeeping: the placeholder itself becomes the id, so the claim stays visible in
       * `snapshot` and `entry.unboundChildId` records what the host actually reported. A
       * silent return here used to leave `childId: undefined`, which read exactly like a
       * claim that was never admitted.
       */
      bind(childId) {
        if (typeof childId !== 'string' || childId === '') {
          entry.unboundChildId = childId === undefined ? 'undefined' : String(childId)
          entry.childId = placeholder
          byChild.set(placeholder, placeholder)
          return false
        }
        entry.childId = childId
        byChild.set(childId, placeholder)
        return true
      },
      /** Release the claim. Idempotent, so a failure and a settle cannot double-free. */
      release() {
        entries.delete(placeholder)
        if (entry.childId !== undefined && byChild.get(entry.childId) === placeholder) {
          byChild.delete(entry.childId)
        }
      },
    }
  }


  const snapshot = () =>
    activeEntries().map((entry) => ({
      taskKey: entry.taskKey,
      childId: entry.childId,
      // Present only when the host reported no usable child id: the claim is still held,
      // and this is what the host said, so the gap is diagnosable instead of invisible.
      ...(entry.unboundChildId === undefined ? {} : { unboundChildId: entry.unboundChildId }),
      parentId: entry.parentId,
      startedAt: entry.startedAt,
      writeScope: entry.scopes.map((scope) => `${scope.path}${scope.directory ? '/**' : ''}`),
    }))

  /** The entry a given child holds, or `undefined` when the child is not guarded. */
  const entryOf = (childId) => {
    const placeholder = byChild.get(childId)
    return placeholder === undefined ? undefined : entries.get(placeholder)
  }

  return {
    claim,
    snapshot,
    entryOf,
    get size() {
      return entries.size
    },
  }
}
