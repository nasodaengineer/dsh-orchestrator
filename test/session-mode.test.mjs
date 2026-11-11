import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MODE,
  ENABLED_MODE,
  MODE_PROJECTION_KEY,
  MODE_RECORD_TYPE,
  createModeProjection,
  createModeStore,
  initialMode,
  reduceMode,
} from '../lib/session-mode.js'

/** One committed plugin record, shaped the way the host folds it. */
const record = (enabled, seq = 0) => ({
  type: MODE_RECORD_TYPE,
  seq,
  time: 0,
  ignorable: true,
  data: { enabled },
})

test('the record type follows the host plugin-record grammar', () => {
  // The host rejects a type outside this grammar, which would make a mode change fail to
  // persist at all. The check runs here so a renamed constant cannot slip through.
  assert.match(MODE_RECORD_TYPE, /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/)
})

test('records fold in order, and unrelated events never move the state', () => {
  let state = DEFAULT_MODE
  state = reduceMode(state, { type: 'turn/start', data: {}, seq: 0 })
  assert.equal(state.enabled, false, 'an ordinary event changes nothing')
  state = reduceMode(state, record(true, 1))
  assert.equal(state.enabled, true)
  // Another plugin's record, a malformed payload, and an ignored event all leave it alone.
  state = reduceMode(state, { type: 'plugin:other-plugin/mode', data: { enabled: false }, ignorable: true, seq: 2 })
  assert.equal(state.enabled, true, 'another plugin cannot change this mode')
  state = reduceMode(state, { type: MODE_RECORD_TYPE, data: { enabled: 'yes' }, ignorable: true, seq: 3 })
  assert.equal(state.enabled, true, 'a non-boolean payload is ignored')
  state = reduceMode(state, record(false, 4))
  assert.equal(state.enabled, false)
})

test('a fold returns the same object when nothing changed, so the projection stays quiet', () => {
  // The projection compares state by reference to decide whether to emit a change; returning
  // a fresh object for a no-op event would fire a spurious client update on every record.
  const state = reduceMode(ENABLED_MODE, record(true, 1))
  assert.equal(state, ENABLED_MODE)
  const untouched = reduceMode(DEFAULT_MODE, { type: 'assistant/message', data: {} })
  assert.equal(untouched, DEFAULT_MODE)
})

test('init follows the configured default, so untouched sessions agree with each other', () => {
  assert.equal(initialMode().enabled, false)
  assert.equal(initialMode(true).enabled, true)
  assert.equal(initialMode(false), DEFAULT_MODE)
  assert.equal(initialMode(true), ENABLED_MODE)
})

test('the projection publishes the cropped view a client reads', () => {
  const zod = { boolean: () => ({}), object: () => ({ strict: () => ({}) }) }
  const projection = createModeProjection(zod, { defaultEnabled: true })
  assert.equal(projection.key, MODE_PROJECTION_KEY)
  assert.equal(projection.init().enabled, true)
  assert.deepEqual(projection.wire.view(projection.apply(projection.init(), record(false))), { enabled: false })
})

test('the store reads per session and never borrows one session\'s mode for another', () => {
  // The heart of the isolation fix: a WeakMap keyed by the session object cannot cross
  // conversations, and an absent session is never enabled.
  const store = createModeStore()
  const a = {}
  const b = {}
  assert.equal(store.enabledOf(a), false)
  store.remember(a, true)
  assert.equal(store.enabledOf(a), true)
  assert.equal(store.enabledOf(b), false, 'B did not inherit A')
  store.remember(b, false)
  assert.equal(store.enabledOf(a), true, 'B turning off left A on')
  assert.equal(store.enabledOf(undefined), false, 'no session is never enabled')
  assert.equal(store.enabledOf(null), false)
})

test('the store prefers the folded projection once it is attached', () => {
  const store = createModeStore()
  const session = {}
  store.remember(session, true)
  // A host that answers synchronously overrides the in-memory copy, which is what makes a
  // resume replay the recorded mode instead of trusting this process's memory.
  lockStore(store, { enabled: false })
  assert.equal(store.enabledOf(session), false)
})

/** Attach a fixed reader, as the registration handle would after it resolves. */
function lockStore(store, state) {
  store.attach({ stateOf: () => state })
}

test('a store whose projection throws falls back to the in-memory copy', () => {
  const store = createModeStore()
  const session = {}
  store.remember(session, true)
  store.attach({ stateOf: () => { throw new Error('not ready') } })
  assert.equal(store.enabledOf(session), true, 'a broken reader must not break a dispatch')
})

test('warn once reports a single time, whatever the logger does', () => {
  const store = createModeStore()
  const seen = []
  store.warnOnce({ warn: (message) => seen.push(message) }, 'first')
  store.warnOnce({ warn: (message) => seen.push(message) }, 'second')
  assert.deepEqual(seen, ['first'])
  // A throwing logger cannot escape either.
  assert.doesNotThrow(() => store.warnOnce({ warn: () => { throw new Error('boom') } }, 'third'))
  assert.doesNotThrow(() => store.warnOnce(undefined, 'fourth'))
})
