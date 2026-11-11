import assert from 'node:assert/strict'
import test from 'node:test'
import { DELEGATE_TOOL, buildActivation, createDelegateTool, languageNote, readRoute } from '../lib/delegate.js'
import { mainAgentRule } from '../lib/rules.js'

const cfg = (provider, model, effort = '') => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => effort },
})

test('readRoute returns provider and model, and omits an empty effort', () => {
  assert.deepEqual(readRoute(cfg('nexus-deepseek', 'deepseek-v4.1-flash')), {
    provider: 'nexus-deepseek',
    model: 'deepseek-v4.1-flash',
  })
})

test('readRoute carries a named effort and trims whitespace', () => {
  assert.deepEqual(readRoute(cfg(' nexus-claude ', ' claude-opus-5.5 ', ' high ')), {
    provider: 'nexus-claude',
    model: 'claude-opus-5.5',
    reasoningEffort: 'high',
  })
})

test('readRoute refuses an unconfigured route instead of inheriting the parent silently', () => {
  assert.throws(() => readRoute(cfg('', 'm')), /worker route is not configured/)
  assert.throws(() => readRoute(cfg('p', '  ')), /worker route is not configured/)
})

test('buildActivation shapes the spawn request with the route and parent delivery', () => {
  const parent = { id: 'main' }
  const signal = new AbortController().signal
  const route = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const spec = buildActivation({ args: { description: 'fix parser', prompt: 'do it' }, parent, route, maxDepth: 2, signal })
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'fix parser')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.signal, signal)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: languageNote('do it') + 'do it' }])
  assert.equal(spec.request.parent, parent)
  assert.deepEqual(spec.request.agentOptions, route)
  assert.equal(spec.request.maxDepth, 2)
  assert.equal('cwd' in spec.request, false)
})

test('buildActivation passes cwd through and leaves out an undefined depth', () => {
  const spec = buildActivation({ args: { description: 'd', prompt: 'p', cwd: 'sub' }, parent: {}, route: {}, maxDepth: undefined })
  assert.equal(spec.request.cwd, 'sub')
  assert.equal('maxDepth' in spec.request, false)
})

test('the worker header asks for a final summary instead of a send_message report', () => {
  const header = languageNote('把这段代码重构一下')
  assert.match(header, /^用中文回复。/)
  assert.match(header, /完成任务时直接在回复中输出最终总结并结束本回合/)
  assert.match(header, /禁止调用 send_message 向父代理发送完成汇报/)
  assert.match(header, /主代理会自动接收你的收尾消息/)
  // The wording no longer depends on the request, so any prompt gets the same header.
  assert.equal(languageNote('do it'), header)
})

test('the tool is concurrency-safe, named delegate, and takes optional route overrides', () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm') })
  assert.equal(tool.name, DELEGATE_TOOL)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(tool.parameters).sort(), [
    'cwd',
    'description',
    'model',
    'prompt',
    'provider',
    'reasoning_effort',
    'taskKey',
    'writeScope',
  ])
  // The two guard fields are optional, so an old call keeps the old behaviour exactly.
  assert.equal('required' in tool.parameters.taskKey, false)
  assert.equal('required' in tool.parameters.writeScope, false)
  assert.equal(tool.parameters.writeScope.type, 'array')
  assert.equal(tool.parameters.writeScope.items.type, 'string')
  // The author dialect spells requiredness per property, not as a `required` array.
  assert.equal(tool.parameters.prompt.required, true)
  assert.equal(tool.parameters.description.required, true)
  assert.equal('required' in tool.parameters.cwd, false)
  for (const key of ['provider', 'model', 'reasoning_effort']) {
    assert.equal('required' in tool.parameters[key], false)
  }
  for (const key of ['provider', 'model']) {
    assert.match(tool.parameters[key].description, /仅当用户显式点名/)
  }
  assert.match(tool.parameters.reasoning_effort.description, /仅当用户点名时才设置/)
})

test('execute rejects a missing prompt or description before touching the route', async () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm') })
  await assert.rejects(() => tool.execute({ description: 'x' }, { agent: {} }), /non-empty prompt/)
  await assert.rejects(() => tool.execute({ prompt: 'x' }, { agent: {} }), /non-empty description/)
})

test('execute reads the route per call, so a changed route applies to the next delegation', async () => {
  const seen = []
  let route = ['nexus-deepseek', 'deepseek-v4.1-flash']
  const config = {
    workerProvider: { get: () => route[0] },
    workerModel: { get: () => route[1] },
    workerReasoningEffort: { get: () => '' },
  }
  const subagents = {
    resolveMaxDepth: () => 2,
    startActivation: async (spec) => {
      seen.push(spec.request.agentOptions)
      return { childId: 'child-' + seen.length }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const first = await tool.execute({ description: 'a', prompt: 'x' }, exec)
  route = ['nexus-claude', 'claude-opus-5.5']
  await tool.execute({ description: 'b', prompt: 'y' }, exec)
  assert.deepEqual(first, { kind: 'activation', subagentId: 'child-1' })
  assert.equal(seen[0].model, 'deepseek-v4.1-flash')
  assert.equal(seen[1].model, 'claude-opus-5.5')
})

test('execute fails loudly without a calling agent and does not start anything', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm') })
  await assert.rejects(() => tool.execute({ description: 'a', prompt: 'x' }, { signal: new AbortController().signal }), /requires a calling agent/)
  assert.equal(started, false)
})

test('an aborted signal stops execute before a worker is started', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm') })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => tool.execute({ description: 'a', prompt: 'x' }, { agent: {}, signal: ac.signal }))
  assert.equal(started, false)
})

test('a successful start reports the child and leaves the returned result unchanged', async () => {
  const seen = []
  const started = { childId: 'child-9', result: Promise.resolve('done') }
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => started }
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    onStarted(parent, child, args) {
      seen.push({ parent, child, args })
    },
  })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const value = await tool.execute({ description: 'a', prompt: 'x' }, exec)
  assert.deepEqual(value, { kind: 'activation', subagentId: 'child-9' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].parent, exec.agent)
  assert.equal(seen[0].child, started)
  assert.equal(seen[0].args.description, 'a')
})

test('a broken onStarted cannot affect dispatch or its result', async () => {
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => ({ childId: 'child-1' }) }
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }

  const throwing = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    onStarted() {
      throw new Error('supervision is broken')
    },
  })
  assert.deepEqual(await throwing.execute({ description: 'a', prompt: 'x' }, exec), {
    kind: 'activation',
    subagentId: 'child-1',
  })

  // An async callback that rejects is also swallowed, so it cannot surface later.
  const rejecting = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    onStarted: async () => {
      throw new Error('async supervision is broken')
    },
  })
  assert.deepEqual(await rejecting.execute({ description: 'a', prompt: 'x' }, exec), {
    kind: 'activation',
    subagentId: 'child-1',
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const exec = () => ({ agent: { id: 'main' }, signal: new AbortController().signal })

/** A delegate tool whose subagent service records the route every worker starts on. */
function recordingTool(config) {
  const seen = []
  const subagents = {
    resolveMaxDepth: () => 1,
    startActivation: async (spec) => {
      seen.push(spec.request.agentOptions)
      return { childId: 'child-' + seen.length }
    },
  }
  return { seen, tool: createDelegateTool({ defineTool: (d) => d, subagents, config }) }
}

test('without an override the configured route is used unchanged', async () => {
  const { seen, tool } = recordingTool(cfg('nexus-deepseek', 'deepseek-v4.1-flash', 'high'))
  await tool.execute({ description: 'a', prompt: 'x' }, exec())
  assert.deepEqual(seen, [
    { provider: 'nexus-deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  ])
})

test('an explicit provider and model replace the configured route for that worker', async () => {
  // An empty configured route would throw if it were read, so the override must short-circuit it.
  const { seen, tool } = recordingTool(cfg('', ''))
  await tool.execute(
    { description: 'a', prompt: 'x', provider: 'nexus-claude', model: 'claude-opus-5.5' },
    exec(),
  )
  assert.deepEqual(seen, [{ provider: 'nexus-claude', model: 'claude-opus-5.5' }])
})

test('provider and model must be given together, and nothing starts', async () => {
  const { seen, tool } = recordingTool(cfg('nexus-deepseek', 'deepseek-v4.1-flash'))
  for (const args of [
    { provider: 'nexus-claude' },
    { model: 'claude-opus-5.5' },
    { provider: 'nexus-claude', model: '  ' },
    { reasoning_effort: 'high' },
  ]) {
    await assert.rejects(
      () => tool.execute({ description: 'a', prompt: 'x', ...args }, exec()),
      /"provider" and "model" must be given together/,
    )
    assert.equal(seen.length, 0, JSON.stringify(args))
  }
})

test('a non-string override field is refused instead of coerced', async () => {
  const { seen, tool } = recordingTool(cfg('p', 'm'))
  await assert.rejects(
    () => tool.execute({ description: 'a', prompt: 'x', provider: 7, model: 'm' }, exec()),
    /"provider" must be a string/,
  )
  assert.equal(seen.length, 0)
})

test('reasoning_effort passes through with the override and is trimmed', async () => {
  const { seen, tool } = recordingTool(cfg('', ''))
  await tool.execute(
    {
      description: 'a',
      prompt: 'x',
      provider: ' nexus-claude ',
      model: ' claude-opus-5.5 ',
      reasoning_effort: ' high ',
    },
    exec(),
  )
  assert.deepEqual(seen, [
    { provider: 'nexus-claude', model: 'claude-opus-5.5', reasoningEffort: 'high' },
  ])
})

test('the description keeps the main-agent rule, the whitelist and the execute contract', () => {
  // The rule names exactly what the gate lets through, so the test drives it with a
  // whitelist rather than a deny list: every other tool is blocked by not being named.
  const allowed = ['delegate', 'orchestrate', 'todo_write']
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents: {},
    config: cfg('p', 'm'),
    allowedTools: allowed,
  })
  assert.equal(tool.description.startsWith(mainAgentRule(allowed)), true)
  assert.match(tool.description, /主代理可用工具（白名单驱动，其余全部禁用）: delegate, orchestrate, todo_write。/)
  // The planning-only rule, in one dense Chinese paragraph.
  assert.match(tool.description, /主代理规则：主代理只负责规划/)
  assert.match(tool.description, /都只在子代理中通过 delegate（单个任务）或 orchestrate（同构批量）执行/)
  assert.match(tool.description, /也不为试探可用性调用一次/)
  assert.match(tool.description, /子代理不受门禁限制/)
  assert.match(tool.description, /新会话或压缩后无需重新确认/)
  assert.match(tool.description, /独立任务在同一消息内并发派发/)
  assert.match(tool.description, /无需并行时等待子代理完成再进行后续操作/)
  assert.match(tool.description, /不要轮询其状态/)
  assert.match(tool.description, /也不要为同一任务重复派发/)
  assert.match(tool.description, /主代理可以直接调用 compress/)
  // The retry contract: the plugin's own notice text and the A/B-only answer.
  assert.match(tool.description, /插件会在同一会话自动重试/)
  assert.match(tool.description, /结果为空时先确认插件状态，不要立即重派/)
  assert.match(tool.description, /2 分钟内连续 3 次快速断联（插件自动重试 2 次）/)
  assert.ok(
    tool.description.includes(
      '【插件重试｜子代理 <id>】它在 2 分钟内连续 3 次快速断联（failed before it finished / It left no closing message），插件已停止自动重试',
    ),
  )
  assert.match(tool.description, /只提供通知中的 A\/B 选项（A 派生新子代理重做 \/ B 更换子代理模型后重试）并等待用户答复/)
  assert.match(tool.description, /不要建议继续唤醒旧子代理/)
  assert.match(tool.description, /未经用户选择 A 不要另派子代理重复工作/)
  assert.match(tool.description, /也不要私自换模型重发/)
  // run_code cannot reach the host, and the route override is opt-in per dispatch.
  assert.match(tool.description, /严禁通过 run_code 触达宿主/)
  assert.match(tool.description, /禁用 import\/require\/process\/fetch\/eval/)
  assert.match(tool.description, /run_code 内只能调用 delegate 和 orchestrate/)
  assert.match(tool.description, /仅当当前用户消息显式点名时才传 provider\/model\/reasoning_effort/)
  assert.match(tool.description, /点名的模型仅限本次派发/)
  assert.match(tool.description, /严禁复用历史轮次、历史派发或摘要中的模型/)
  assert.match(tool.description, /严禁假定未声明的默认模型/)
  // The body's handoff contract.
  assert.match(tool.description, /prompt 必须写清目标、允许修改的文件、验收命令与兜底方案/)
  assert.match(tool.description, /按用户配置的 worker 路由运行/)
  assert.match(tool.description, /结束时由运行时自动通知你/)
  assert.match(tool.description, /严禁要求子代理调用 send_message 汇报结果/)
  assert.match(tool.description, /收尾消息会在结束时自动送达/)
  assert.match(tool.description, /严禁两个子代理修改同一文件/)
  assert.match(tool.description, /【插件巡检…】/)
  // The route parameters carry the same one-line condition, where a model would be typed.
  for (const param of ['provider', 'model']) {
    const description = tool.parameters[param].description
    assert.match(description, /仅限本次派发，禁止复用历史轮次或摘要中的模型/, param)
    assert.match(description, /严禁自行选择模型/, param)
  }
})

test('a delegated child no longer sees this tool, so there is no worker variant', () => {
  // `lib/index.js` restricts the pair away from a child; the description is written for
  // the planner only and has no role-neutral twin.
  const tool = createDelegateTool({
    defineTool: (definition) => definition,
    subagents: {},
    config: cfg('p', 'm'),
    allowedTools: ['delegate', 'orchestrate'],
  })
  assert.match(tool.description, /主代理规则：主代理只负责规划/)
  assert.equal('workerText' in tool, false)
  for (const key of ['provider', 'model']) {
    assert.match(tool.parameters[key].description, /仅当用户显式点名/)
  }
})

