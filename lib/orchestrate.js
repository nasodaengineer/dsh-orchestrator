/**
 * Declarative fan-out / pipeline orchestration. Dependency-free: `defineTool` and
 * the subagent service are passed in, so scheduling and result shaping are unit
 * testable without the DSH runtime.
 *
 * One worker call per item and stage; stages of one item are strictly sequential,
 * different items are independent (no global stage barrier). Every worker uses the
 * same route — the configured one, unless this call carries an explicit
 * provider/model override the user asked for — `delivery: 'caller'` and, when the
 * stage declares one, `outputSchema`.
 */

import { DELIVERY, LIMITS, ORCHESTRATE_TOOL, ORCHESTRATION_KIND } from './api.js'
import { assertObjectSchema, isJsonValue, validateJsonSchemaValue } from './schema.js'
import { buildSpawnActivation, readRoute, readRouteOverride } from './worker.js'

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(message) {
  throw new Error(`orchestrate: ${message}`)
}

function within(value, bounds) {
  return value >= bounds.min && value <= bounds.max
}

const ARGUMENT_KEYS = Object.freeze([
  'cwd',
  'items',
  'stages',
  'maxConcurrency',
  'provider',
  'model',
  'reasoning_effort',
])
const STAGE_KEYS = Object.freeze(['name', 'prompt', 'schema'])

/**
 * Reject fields the tool does not implement. Silently ignoring a typo (or a
 * route override placed on a stage instead of the call) would run workers with a
 * different configuration than the caller believes, so unknown keys fail up front.
 */
function rejectUnknownKeys(value, allowed, at) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    fail(`${at} has unknown field "${key}" (allowed: ${allowed.join(', ')})`)
  }
}

/**
 * Validate and normalise `execute` arguments. Everything that can fail globally
 * (shape, unknown fields, limits, stage schema) fails here, before any worker starts.
 */
export function parseOrchestrateArgs(args) {
  if (!isPlainObject(args)) fail('arguments must be an object')
  rejectUnknownKeys(args, ARGUMENT_KEYS, 'arguments')

  if (!Array.isArray(args.items)) fail('"items" must be a JSON array')
  if (!within(args.items.length, LIMITS.items)) {
    fail(`"items" must contain ${LIMITS.items.min}..${LIMITS.items.max} entries (got ${args.items.length})`)
  }
  args.items.forEach((item, index) => {
    if (!isJsonValue(item)) fail(`item ${index + 1} is not a lossless JSON value`)
  })

  if (!Array.isArray(args.stages)) fail('"stages" must be an array')
  if (!within(args.stages.length, LIMITS.stages)) {
    fail(`"stages" must contain ${LIMITS.stages.min}..${LIMITS.stages.max} stages (got ${args.stages.length})`)
  }
  const stages = args.stages.map((stage, index) => {
    const at = `stage ${index + 1}`
    if (!isPlainObject(stage)) fail(`${at} must be an object`)
    rejectUnknownKeys(stage, STAGE_KEYS, at)
    if (typeof stage.name !== 'string' || stage.name.trim() === '') fail(`${at} requires a non-empty "name"`)
    if (typeof stage.prompt !== 'string' || stage.prompt.trim() === '') fail(`${at} requires a non-empty "prompt"`)
    if (stage.schema !== undefined) {
      try {
        assertObjectSchema(stage.schema, `${at}.schema`)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
    return {
      name: stage.name,
      prompt: stage.prompt,
      ...(stage.schema === undefined ? {} : { schema: stage.schema }),
    }
  })

  if (args.maxConcurrency !== undefined) {
    if (!Number.isInteger(args.maxConcurrency) || !within(args.maxConcurrency, LIMITS.maxConcurrency)) {
      fail(
        `"maxConcurrency" must be an integer in ${LIMITS.maxConcurrency.min}..${LIMITS.maxConcurrency.max} (got ${JSON.stringify(args.maxConcurrency)})`,
      )
    }
  }

  let cwd
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string') fail('"cwd" must be a string')
    cwd = args.cwd.trim()
    if (cwd === '') fail('"cwd" must be a non-empty string when provided')
  }

  return {
    cwd,
    items: args.items,
    stages,
    maxConcurrency: args.maxConcurrency ?? LIMITS.maxConcurrency.default,
  }
}

/** A worker-visible prompt: stage instruction, original item and previous output. */
export function buildStagePrompt({ stage, stageIndex, stageCount, item, itemIndex, itemCount, previous }) {
  const lines = [
    stage.prompt.trim(),
    '',
    '你在批处理任务中负责其中一个阶段，看不到父会话，所需信息都在下面。',
    '',
    `阶段 "${stage.name}"（${stageIndex + 1}/${stageCount}），条目 ${itemIndex + 1}/${itemCount}。`,
    '',
    '原始条目 (JSON):',
    JSON.stringify(item),
    '',
  ]
  if (previous === undefined) {
    lines.push('这是第一个阶段，请直接产出该条目在本阶段的结果。')
  } else {
    lines.push(`上一阶段 "${previous.stageName}" 输出 (JSON):`)
    lines.push(JSON.stringify(previous.output))
    lines.push('')
    lines.push('在此基础上继续，产出该条目在本阶段的结果。')
  }
  if (stage.schema !== undefined) {
    lines.push('')
    lines.push(
      '本阶段返回一个 JSON 对象：优先调用一次 structured_output 工具，把最终对象传给它，不要用文本作答。',
    )
    lines.push(
      '若 structured_output 不可用，则只输出符合阶段 schema 的 JSON 对象，不要解释、不要 Markdown、不要代码块。',
    )
  }
  return lines.join('\n')
}

/** Text parts of a worker's content output, concatenated in order. */
export function collectText(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  let text = ''
  for (const part of output) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      text += part.text
    }
  }
  return text
}

/**
 * Turn one settled worker result into the stage output.
 *
 * `run.result.structured` is authoritative when present: an invalid structured
 * value fails the stage and is never replaced by the text.
 *
 * A schema stage may also be recovered from text. A host that never dispatches
 * `structured_output` ends a text answer as `error` even though the worker
 * finished, so for schema stages `completed` and `error` are both accepted; any
 * other stop reason (aborted, max-tokens, refusal, ...) is never recovered. The
 * concatenated text must be one strict JSON document that fully validates; the
 * text itself is never echoed, only the schema violations.
 */
export function readStageOutput(stage, result) {
  if (result === null || typeof result !== 'object') throw new Error('worker returned no result')
  const schema = stage.schema
  const recoverable = result.stopReason === 'completed' || (schema !== undefined && result.stopReason === 'error')
  if (!recoverable) {
    throw new Error(`worker stopped with reason "${String(result.stopReason)}" before finishing the stage`)
  }
  const text = collectText(result.output)

  if (schema === undefined) return text

  if (Object.hasOwn(result, 'structured') && result.structured !== undefined) {
    const violations = validateJsonSchemaValue(schema, result.structured)
    if (violations.length > 0) {
      throw new Error(`structured result does not match the stage schema: ${violations.join('; ')}`)
    }
    return result.structured
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      'stage schema requires a structured result, but the worker returned text that is not strictly JSON (or no text)',
    )
  }
  const violations = validateJsonSchemaValue(schema, parsed)
  if (violations.length > 0) {
    throw new Error(`text result does not match the stage schema: ${violations.join('; ')}`)
  }
  return parsed
}

function abortReason(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (reason !== undefined) return new Error(String(reason))
  const error = new Error('orchestrate was aborted')
  error.name = 'AbortError'
  return error
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bounded worker slots. A slot is held from just before `startActivation` until
 * the worker's result has been read and the child disposed, so the cap bounds
 * live workers rather than just calls in flight.
 */
function createLimiter(limit) {
  let active = 0
  const waiters = []
  return {
    get active() {
      return active
    },
    acquire(signal) {
      signal?.throwIfAborted()
      if (active < limit) {
        active += 1
        return Promise.resolve()
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: undefined }
        waiter.onAbort = () => {
          const at = waiters.indexOf(waiter)
          if (at !== -1) waiters.splice(at, 1)
          reject(abortReason(signal))
        }
        signal?.addEventListener('abort', waiter.onAbort, { once: true })
        waiters.push(waiter)
      })
    },
    release() {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        active -= 1
        return
      }
      // The slot moves to the next waiter; `active` stays the same.
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    },
  }
}

/**
 * Run the plan. Returns the unified result, or throws for a global failure
 * (abort, oversized result, an internal error outside per-item isolation).
 */
export async function runOrchestration({ plan, parent, route, maxDepth, subagents, signal }) {
  const { cwd, items, stages, maxConcurrency } = plan
  const limiter = createLimiter(maxConcurrency)
  const results = new Array(items.length).fill(null)
  const errors = []
  const active = new Set()
  const disposals = new Map()
  /**
   * item index -> child id, captured the moment the id is known.
   *
   * The recorded row is written inside a `finally` that awaits teardown, so the id must
   * not depend on that row being written first: a successful item whose dispose chain has
   * not settled yet would otherwise report `null` for a worker that really ran.
   */
  const recordedWorkers = new Map()
  let agentsStarted = 0

  // A handle disposed before its result is read would otherwise leave a rejected
  // result promise unhandled; consume it best effort.
  const observeResult = (handle) => {
    const result = handle.result
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(undefined, () => {})
    }
  }

  const dispose = (handle) => {
    if (handle === null || typeof handle !== 'object' || typeof handle.dispose !== 'function') {
      return Promise.resolve()
    }
    const known = disposals.get(handle)
    if (known !== undefined) return known
    // Disposal is best effort: a worker that already finished needs no cleanup,
    // and an abort must not be blocked by a failing teardown.
    const pending = Promise.resolve()
      .then(() => {
        observeResult(handle)
        return handle.dispose()
      })
      .catch(() => {})
    disposals.set(handle, pending)
    return pending
  }

  const onAbort = () => {
    for (const handle of active) void dispose(handle)
  }
  if (signal.aborted) throw abortReason(signal)
  signal.addEventListener('abort', onAbort, { once: true })

  /**
   * Run one stage. Resolves to the stage output plus the child id of the worker that
   * produced it (`undefined` when the handle reported none), so a result row can name
   * the agent that `orchestrator_agents` should address.
   *
   * `onChild` fires as soon as the id is known — before the output is validated — because
   * a stage can fail after its worker ran, and that worker must still be addressable.
   */
  const runStage = async ({ stage, stageIndex, prompt, itemIndex, onChild }) => {
    let acquired = false
    let started
    try {
      await limiter.acquire(signal)
      acquired = true
      if (signal.aborted) throw abortReason(signal)
      const spec = buildSpawnActivation({
        cwd,
        prompt,
        label: `orchestrate ${stage.name} (item ${itemIndex + 1}/${items.length}, stage ${stageIndex + 1}/${stages.length})`,
        parent,
        route,
        maxDepth,
        signal,
        outputSchema: stage.schema,
        delivery: DELIVERY.orchestrate,
      })
      // Race the start itself against abort: a hanging startActivation must not
      // delay cancellation. A handle that only resolves after the abort is
      // disposed on arrival and is never dispatched.
      const startPromise = Promise.resolve().then(() => subagents.startActivation(spec))
      const settledStart = startPromise.then(
        (handle) => ({ handle }),
        (error) => ({ error }),
      )
      started = await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        settledStart.then((outcome) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) {
            // Late handle: clean it up without dispatching its worker.
            if (outcome.handle !== undefined) void dispose(outcome.handle)
            reject(abortReason(signal))
            return
          }
          if (Object.hasOwn(outcome, 'error')) reject(outcome.error)
          else resolve(outcome.handle)
        })
      })
      if (
        started === null ||
        typeof started !== 'object' ||
        started.result === undefined ||
        typeof started.result.then !== 'function'
      ) {
        throw new Error('subagent startActivation did not return a result promise')
      }
      if (signal.aborted) throw abortReason(signal)
      // Count only handles that are valid and not already aborted, so a late
      // start never appears in agentsStarted.
      agentsStarted += 1
      active.add(started)
      // Reported here, not after the result settles: a worker that starts and then fails or is
      // aborted still ran, and its id is the only way the main agent can reach it. The output
      // row stays `null` in that case; only the id is kept.
      const childId = typeof started.childId === 'string' && started.childId !== '' ? started.childId : undefined
      if (childId !== undefined) onChild?.(childId)
      // Race the worker against the abort signal: cancellation must not wait for a
      // worker that ignores its own signal, and the handle is disposed in `finally`.
      const result = await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        started.result.then(
          (value) => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
      })
      if (signal.aborted) throw abortReason(signal)
      return { output: readStageOutput(stage, result), childId }
    } finally {
      if (started !== undefined) {
        active.delete(started)
        await dispose(started)
      }
      if (acquired) limiter.release()
    }
  }

  const runItem = async (item, index) => {
    let previous
    let output
    let stopReason = 'completed'
    // The first stage's worker is the agent the main agent can address; later stages are
    // separate activations of the same item, so the first one is what a result row names.
    let subagentId
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      if (signal.aborted) throw abortReason(signal)
      const stage = stages[stageIndex]
      const prompt = buildStagePrompt({
        stage,
        stageIndex,
        stageCount: stages.length,
        item,
        itemIndex: index,
        itemCount: items.length,
        previous,
      })
      try {
        const stageResult = await runStage({
          stage,
          stageIndex,
          prompt,
          itemIndex: index,
          // Recorded before the stage output is validated, so a stage that fails after its
          // worker ran still leaves the id behind for the catch below.
          onChild: (id) => {
            if (subagentId === undefined) {
              subagentId = id
              recordedWorkers.set(index, id)
            }
          },
        })
        output = stageResult.output
        previous = { stageName: stage.name, output }
        stopReason = 'completed'
      } catch (error) {
        // An abort of the whole call is not the failure of one item.
        if (signal.aborted) throw abortReason(signal)
        errors.push({ index, stage: stage.name, stageIndex, message: messageOf(error) })
        // A failed item still reports the worker id it got through `recordedWorkers`, so
        // nothing already started is invisible to `orchestrator_agents`. The row stays
        // `null` for the item's output.
        return null
      }
    }
    // Emitted as `null`, never `undefined`: a missing property is what makes a strict host
    // schema (additionalProperties: false) reject an otherwise successful row.
    return { index, output, stopReason, subagentId: subagentId ?? null }
  }

  try {
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        results[index] = await runItem(item, index)
      }),
    )
    if (signal.aborted) throw abortReason(signal)
    const rejected = settled.find((entry) => entry.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  } finally {
    signal.removeEventListener('abort', onAbort)
    await Promise.all([...disposals.values()])
  }

  errors.sort((a, b) => a.index - b.index || a.stageIndex - b.stageIndex)
  /**
   * A worker id the main agent can hand straight to `orchestrator_agents`. An item whose
   * worker never started a stage has none, and `null` is emitted rather than a made-up id,
   * because a wrong id would address another agent's session.
   */
  const subagentIdOf = (index) => {
    const id = recordedWorkers.get(index)
    return typeof id === 'string' && id !== '' ? id : null
  }
  const payload = {
    kind: ORCHESTRATION_KIND,
    agentsStarted,
    results,
    // One entry per item, aligned by `index`, including items that failed after their worker
    // started: those are exactly the agents a main agent most needs to reach.
    workers: items.map((_item, index) => ({ index, subagentId: subagentIdOf(index) })),
    errors: errors.map(({ index, stage, message }) => ({ index, stage, message })),
  }
  const serialized = JSON.stringify(payload)
  if (serialized.length > LIMITS.serializedResultChars) {
    fail(
      `serialized result is ${serialized.length} characters, above the ${LIMITS.serializedResultChars} character limit; reduce items, stages or output size`,
    )
  }
  return payload
}

export function createOrchestrateTool({ defineTool, subagents, config }) {
  // This description does not repeat `mainAgentRule`: only `delegate` opens with it.
  // The plumbing still accepts the whitelist fields a shared factory passes down so a
  // caller does not have to branch, but they are unused here.
  const body =
    '主代理规则同 delegate（主代理只负责规划，可用工具见 delegate 描述）。' +
    '按 item 派发子代理，可选多阶段流水线：只有一个 stage 时即批量扇出；有多个 stage 时每个 item ' +
    '独立走完自己的阶段，不存在全局阶段屏障。每个阶段的 prompt 都是自包含的：阶段指令、原始 item、' +
    '上一阶段输出会一并给出。所有子代理统一走配置的 worker 路由，除非用户显式要求本次调用传 ' +
    'provider/model。stage 声明了 JSON Schema 时，其输出是校验过的 JSON 对象，否则为文本。' +
    '单个 item 失败会置为 null 并记入 errors，不影响其余 item；maxConcurrency 限制同时运行的子代理数。' +
    '返回的 workers 按 index 与 results 对齐，每行的 subagentId 就是该工人对应的子代理 id，' +
    '可直接作为 orchestrator_agents 的 childId 执行 status/send/interrupt；该 item 没有任何工人启动时 subagentId 为 null。' +
    '多个互不相关的批次可在同一轮同时调用（orchestrate 可并发安全调用）；单个简单任务请用 delegate。'

  const tool = defineTool({
    name: ORCHESTRATE_TOOL,
    description: body,
    parameters: {
      cwd: {
        type: 'string',
        description: '子代理初始工作目录（相对路径基于你的当前目录）；省略则继承当前目录。',
      },
      items: {
        type: 'array',
        required: true,
        description: `JSON 条目数组，每个条目对应一个独立的子代理任务（${LIMITS.items.min}..${LIMITS.items.max}）。`,
        items: { type: 'json' },
      },
      stages: {
        type: 'array',
        required: true,
        description: `每个条目顺序执行的阶段（${LIMITS.stages.min}..${LIMITS.stages.max}）；只有一个阶段即批量扇出。`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              required: true,
              description: '阶段名称，用于结果错误信息。',
            },
            prompt: {
              type: 'string',
              required: true,
              description: '阶段指令；原始条目与上一阶段输出会自动附加。',
            },
            schema: {
              type: 'object',
              additionalProperties: true,
              description:
                '可选的对象根 JSON Schema（支持 type/properties/required/additionalProperties/items/enum/const/oneOf）。',
            },
          },
        },
      },
      maxConcurrency: {
        type: 'integer',
        description: `同时运行的子代理上限（${LIMITS.maxConcurrency.min}..${LIMITS.maxConcurrency.max}，默认 ${LIMITS.maxConcurrency.default}）。`,
      },
      provider: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名本次调用所有子代理的 provider 与 model 时才传，且需与 model 同时给出；' +
          '两者都省略时使用调度面板的 worker 路由。严禁自行选择模型。仅限本次派发，禁止复用历史轮次或摘要中的模型。',
      },
      model: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名本次调用所有子代理的 provider 与 model 时才传，且需与 provider 同时给出；' +
          '两者都省略时使用调度面板的 worker 路由。严禁自行选择模型。仅限本次派发，禁止复用历史轮次或摘要中的模型。',
      },
      reasoning_effort: {
        type: 'string',
        description:
          '可选，仅与 provider 和 model 同时使用：本次调用每个子代理的推理强度。省略则由所选模型决定默认值；仅当用户点名时才设置。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: ORCHESTRATION_KIND },
          agentsStarted: { type: 'integer' },
          // Per-item worker ids, aligned with `results` by `index`. `subagentId` is the id
          // `orchestrator_agents` takes as `childId`; `null` when no worker started a stage
          // for that item, so a model never has to invent or guess one.
          workers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                // This host dialect has no union `type`; `oneOf` is how null is spelled.
                subagentId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
          results: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    output: { type: 'json' },
                    stopReason: { type: 'string' },
                    // The id `orchestrator_agents` takes as `childId`. Declared here because
                    // the row really carries it and this object forbids undeclared properties.
                    subagentId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                },
              ],
            },
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                stage: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `orchestration finished: ${value.results.filter((entry) => entry !== null).length}/${value.results.length} items, ` +
            `${value.errors.length} errors, ${value.agentsStarted} workers started; ` +
            `worker ids: ${(value.workers ?? []).map((worker) => `${worker.index}:${worker.subagentId ?? 'null'}`).join(', ') || 'none'}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec?.agent
      if (!parent) throw new Error('orchestrate requires a calling agent (exec.agent was undefined)')
      // Parse first: bad input or schema must fail before any worker starts.
      const plan = parseOrchestrateArgs(args)
      const signal = exec.signal
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new Error('orchestrate requires a cancellation signal')
      }
      signal.throwIfAborted()
      // An explicit per-call override wins and is never read from config; otherwise the
      // route is read at call time, so a changed route applies from this orchestration on.
      const route = readRouteOverride(args, ORCHESTRATE_TOOL) ?? readRoute(config)
      const maxDepth = subagents.resolveMaxDepth(undefined)
      signal.throwIfAborted()
      return runOrchestration({ plan, parent, route, maxDepth, subagents, signal })
    },
  })
  // The host reads `description` while it builds a request; keep it a live getter for the
  // same reason as `delegate`, even though this text no longer depends on the whitelist.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => body,
  })
  return tool
}
