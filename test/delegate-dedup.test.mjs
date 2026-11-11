import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelegateTool } from '../lib/delegate.js'
import {
  conflictError,
  createDispatchGuard,
  describeScopes,
  normalizeClaim,
  normalizeScopePath,
  scopesOverlap,
} from '../lib/delegate-dedup.js'

const cfg = (provider, model) => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => '' },
})

const exec = () => ({ agent: { id: 'main' }, signal: new AbortController().signal })

/** A delegate tool whose worker start can be resolved or rejected by the test. */
function guarded({ start } = {}) {
  const guard = createDispatchGuard()
  const starts = []
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      starts.push(spec)
      if (start !== undefined) return start(spec, starts.length)
      return { childId: `child-${starts.length}`, result: Promise.resolve('done') }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm'), guard })
  return { tool, guard, starts }
}

test('normalizeScopePath folds slash and dot spellings of one path', () => {
  const spellings = ['lib/a/b.js', 'lib\\a\\b.js', './lib/a/b.js', 'lib/a/./b.js', 'lib/a/x/../b.js', '/lib/a/b.js'.slice(1)]
  for (const spelling of spellings) {
    assert.equal(normalizeScopePath(spelling).path, 'lib/a/b.js', spelling)
  }
  assert.equal(normalizeScopePath('lib//a///b.js').path, 'lib/a/b.js')
  assert.equal(normalizeScopePath('  lib/a/b.js  ').path, 'lib/a/b.js')
  // A Windows drive and an absolute POSIX path keep their root.
  assert.equal(normalizeScopePath('C:\\work\\a.js').path, 'C:/work/a.js')
  assert.equal(normalizeScopePath('/work/a.js').path, '/work/a.js')
  // `..` cannot climb above the claim's own root, so it cannot spell a sibling's path.
  assert.equal(normalizeScopePath('../a.js').path, 'a.js')
  assert.throws(() => normalizeScopePath(''), /must not be empty/)
  assert.throws(() => normalizeScopePath('   '), /must not be empty/)
  assert.throws(() => normalizeScopePath(7), /must be a string/)
})

test('a trailing /** marks a directory claim without changing the comparison', () => {
  const directory = normalizeClaim('lib/a/**')
  assert.equal(directory.directory, true)
  assert.equal(directory.path, 'lib/a')
  assert.equal(normalizeClaim('lib/a').directory, false)
  assert.equal(describeScopes([directory, normalizeClaim('lib/b.js')]), '"lib/a/**", "lib/b.js"')
  assert.equal(describeScopes([]), '<unclaimed>')
})

test('scopes overlap only at a segment boundary', () => {
  const path = (value) => normalizeScopePath(value)
  assert.equal(scopesOverlap(path('lib/a/b.js'), path('lib/a/b.js')), true, 'identical')
  assert.equal(scopesOverlap(path('lib/a'), path('lib/a/b.js')), true, 'parent contains child')
  assert.equal(scopesOverlap(path('lib/a/b.js'), path('lib/a')), true, 'symmetric')
  assert.equal(scopesOverlap(path('lib/a'), path('lib/ab')), false, 'no mid-name prefix match')
  assert.equal(scopesOverlap(path('lib/ab'), path('lib/a/b.js')), false)
  assert.equal(scopesOverlap(path('lib/a/b.js'), path('test/a/b.js')), false)
  assert.equal(scopesOverlap(path('/'), path('anything')), true, 'a root claim covers everything')
})

test('a duplicate active taskKey is refused and the message names the key', () => {
  const guard = createDispatchGuard()
  const first = guard.claim({ parentId: 'main', taskKey: 'build' })
  assert.throws(
    () => guard.claim({ parentId: 'main', taskKey: 'build' }),
    /taskKey "build" is already running/,
  )
  // A different key is independent.
  const second = guard.claim({ parentId: 'main', taskKey: 'test' })
  first.release()
  // Once released the key is free again.
  const third = guard.claim({ parentId: 'main', taskKey: 'build' })
  for (const claim of [second, third]) claim.release()
  assert.equal(guard.size, 0)
})

test('overlapping write scopes are refused and name the colliding path', () => {
  const guard = createDispatchGuard()
  const first = guard.claim({ parentId: 'main', taskKey: 'a', writeScope: ['lib/a'] })
  assert.throws(
    () => guard.claim({ parentId: 'main', taskKey: 'b', writeScope: ['lib/a/b.js'] }),
    /writeScope "lib\/a\/b\.js" overlaps an active task's write scope/,
  )
  assert.throws(
    () => guard.claim({ parentId: 'main', taskKey: 'c', writeScope: ['lib/a/b.js'] }),
    /overlaps an active task's write scope/,
  )
  // The error names the holder and its key.
  const message = (() => {
    try {
      guard.claim({ parentId: 'main', taskKey: 'b', writeScope: ['lib/a/deep/x.js'] })
      return ''
    } catch (error) {
      return error.message
    }
  })()
  assert.match(message, /taskKey "a"/)
  assert.match(message, /lib\/a/)
  first.release()
})

test('disjoint write scopes run in parallel', () => {
  const guard = createDispatchGuard()
  const claims = [
    guard.claim({ parentId: 'main', taskKey: 'one', writeScope: ['lib/a'] }),
    guard.claim({ parentId: 'main', taskKey: 'two', writeScope: ['lib/b'] }),
    guard.claim({ parentId: 'main', taskKey: 'three', writeScope: ['test/a.test.mjs'] }),
  ]
  assert.equal(guard.size, 3)
  for (const claim of claims) claim.release()
  assert.equal(guard.size, 0)
})

test('a call without taskKey or writeScope claims nothing but still holds a placeholder', () => {
  const guard = createDispatchGuard()
  const claim = guard.claim({ parentId: 'main' })
  assert.equal(claim.entry.taskKey, undefined)
  assert.deepEqual(claim.entry.scopes, [])
  // Two unclaimed tasks never conflict with each other.
  const second = guard.claim({ parentId: 'main' })
  assert.equal(guard.size, 2)
  claim.release()
  second.release()
})

test('an empty writeScope array is refused instead of meaning "no scope"', () => {
  const guard = createDispatchGuard()
  assert.throws(() => guard.claim({ writeScope: [] }), /must name at least one path/)
})

test('the placeholder is claimed before the first await, so two concurrent calls conflict', async () => {
  const guard = createDispatchGuard()
  const releases = []
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation() {
      // Hold the dispatch open so the second call arrives while the first is in flight.
      return new Promise((resolve) => {
        releases.push(() => resolve({ childId: 'child-1', result: new Promise(() => {}) }))
      })
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm'), guard })
  const first = tool.execute({ description: 'a', prompt: 'x', taskKey: 'same' }, exec())
  await assert.rejects(
    () => tool.execute({ description: 'b', prompt: 'y', taskKey: 'same' }, exec()),
    /taskKey "same" is already running/,
  )
  releases[0]()
  await first
})

test('a failed dispatch releases its claim immediately', async () => {
  const guard = createDispatchGuard()
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation() {
      throw new Error('capacity exhausted')
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm'), guard })
  await assert.rejects(
    () => tool.execute({ description: 'a', prompt: 'x', taskKey: 'k', writeScope: ['lib/a'] }, exec()),
    /capacity exhausted/,
  )
  assert.equal(guard.size, 0, 'the placeholder must not outlive the failure')
  // The same key and scope are free again.
  const again = guard.claim({ taskKey: 'k', writeScope: ['lib/a'] })
  again.release()
})

test('a successful dispatch releases its claim when the receipt settles', async () => {
  let settle
  const guard = createDispatchGuard()
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation() {
      return {
        childId: 'child-9',
        result: new Promise((resolve) => {
          settle = resolve
        }),
      }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm'), guard })
  const value = await tool.execute({ description: 'a', prompt: 'x', taskKey: 'k', writeScope: ['lib/a'] }, exec())
  assert.deepEqual(value, { kind: 'activation', subagentId: 'child-9' })
  assert.equal(guard.size, 1, 'the claim is held while the worker runs')
  // The child is bound, so status can name the task key holding the scope.
  assert.equal(guard.entryOf('child-9').taskKey, 'k')
  settle('done')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(guard.size, 0, 'the receipt released it')
})

test('a rejected receipt releases the claim too, without an unhandled rejection', async () => {
  let fail
  const guard = createDispatchGuard()
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation() {
      return {
        childId: 'child-8',
        result: new Promise((_, reject) => {
          fail = reject
        }),
      }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm'), guard })
  await tool.execute({ description: 'a', prompt: 'x', taskKey: 'k' }, exec())
  assert.equal(guard.size, 1)
  fail(new Error('worker died'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(guard.size, 0)
})

test('a release is idempotent and never frees another task', () => {
  const guard = createDispatchGuard()
  const first = guard.claim({ taskKey: 'a' })
  const second = guard.claim({ taskKey: 'b' })
  first.release()
  first.release()
  assert.equal(guard.size, 1)
  assert.equal(guard.entryOf(second.entry.childId), undefined)
  second.release()
  assert.equal(guard.size, 0)
})

test('a bound claim is released exactly once, by the claim itself', () => {
  const guard = createDispatchGuard()
  const claim = guard.claim({ taskKey: 'k' })
  assert.equal(claim.bind('child-3'), true)
  assert.equal(guard.entryOf('child-3').taskKey, 'k', 'the child id resolves back to its claim')
  claim.release()
  claim.release()
  assert.equal(guard.size, 0, 'a second release is a no-op')
  assert.equal(guard.entryOf('child-3'), undefined)
})

test('an unusable child id keeps the claim visible instead of silently dropping it', () => {
  const guard = createDispatchGuard()
  const claim = guard.claim({ parentId: 'main', taskKey: 'k', writeScope: ['lib/a'] })
  // The host reported nothing usable: the claim must still be held and accounted for.
  assert.equal(claim.bind(undefined), false)
  assert.equal(guard.size, 1, 'the claim is still held')
  const [row] = guard.snapshot()
  assert.equal(row.taskKey, 'k')
  assert.equal(row.childId, claim.placeholder, 'the placeholder is the fallback identity')
  assert.equal(row.unboundChildId, 'undefined', 'what the host actually reported is recorded')
  assert.deepEqual(row.writeScope, ['lib/a'])
  // The placeholder identity still resolves, and the claim still frees itself.
  assert.equal(guard.entryOf(claim.placeholder).taskKey, 'k')
  claim.release()
  assert.equal(guard.size, 0)
})

test('an empty or non-string child id is recorded with its reported value', () => {
  const guard = createDispatchGuard()
  const empty = guard.claim({ taskKey: 'a' })
  assert.equal(empty.bind(''), false)
  assert.equal(guard.snapshot()[0].unboundChildId, '')
  const numeric = guard.claim({ taskKey: 'b' })
  assert.equal(numeric.bind(42), false)
  assert.equal(guard.snapshot()[1].unboundChildId, '42')
  empty.release()
  numeric.release()
  assert.equal(guard.size, 0)
})

test('an omitted guard keeps the old delegate behaviour exactly', async () => {
  const starts = []
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      starts.push(spec)
      return { childId: 'child-1', result: Promise.resolve('done') }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm') })
  const value = await tool.execute({ description: 'a', prompt: 'x' }, exec())
  assert.deepEqual(value, { kind: 'activation', subagentId: 'child-1' })
  assert.equal(starts.length, 1)
  // A guard-free tool accepts the fields and simply ignores them.
  const again = await tool.execute({ description: 'b', prompt: 'y', taskKey: 'k', writeScope: ['lib/a'] }, exec())
  assert.deepEqual(again, { kind: 'activation', subagentId: 'child-1' })
})

test('the guard passes the two fields through without touching the activation spec', async () => {
  const { tool, starts } = guarded()
  await tool.execute({ description: 'a', prompt: 'x', taskKey: 'k', writeScope: ['lib/a'] }, exec())
  assert.equal(starts.length, 1)
  assert.equal('taskKey' in starts[0], false, 'guard fields never reach the host spec')
  assert.equal('writeScope' in starts[0], false)
})

test('conflictError explains the collision in terms a model can act on', () => {
  const owner = {
    taskKey: 'a',
    childId: 'child-2',
    scopes: [normalizeScopePath('lib/a')],
  }
  const text = conflictError({ scope: normalizeScopePath('lib/a/b.js'), owner }).message
  assert.match(text, /writeScope "lib\/a\/b\.js" overlaps an active task's write scope/)
  assert.match(text, /subagent child-2/)
  assert.match(text, /taskKey "a"/)
  assert.match(text, /different taskKey \/ a writeScope that does not overlap/)
  const unnamed = conflictError({ scope: normalizeScopePath('x'), owner: { scopes: [], childId: undefined } }).message
  assert.match(unnamed, /<unclaimed>/)
  assert.match(unnamed, /a dispatch admitted in this turn/)
})
