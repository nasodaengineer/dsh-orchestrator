/**
 * Delegation tool. Dependency-free: `defineTool` is passed in, so the request
 * building can be tested without the DSH runtime.
 *
 * Why this exists (see docs/adr/0001): the native `subagent` tool's `agentOptions`
 * are plain config with no volatile field, so a settings write cannot change the
 * default worker route. This tool reads the route from the plugin's own volatile
 * config on every call, so a change applies from the next delegation.
 *
 * Route reading and request shaping live in `worker.js`, shared with `orchestrate`.
 * A delegated child does not inherit this tool any more (`lib/index.js` restricts
 * it away), so the description and the parameters can assume a main-agent reader:
 * there is only one text, and it is written for the planner.
 */

import { DELEGATE_TOOL, DELIVERY } from './api.js'
import { mainAgentRule } from './rules.js'
import { buildSpawnActivation, languageNote, readRoute, readRouteOverride } from './worker.js'

export { DELEGATE_TOOL, languageNote, readRoute, readRouteOverride }

/** The delegate spec: the prompt carries the language note and delivery answers the parent. */
export function buildActivation({ args, parent, route, maxDepth, signal }) {
  return buildSpawnActivation({
    cwd: args.cwd,
    prompt: languageNote(args.prompt) + args.prompt,
    label: args.description,
    parent,
    route,
    maxDepth,
    signal,
    delivery: DELIVERY.delegate,
  })
}

export function createDelegateTool({
  defineTool,
  subagents,
  config,
  onStarted,
  allowedTools,
  deniedTools,
  // Optional dispatch guard (lib/delegate-dedup.js). A caller that does not pass one keeps
  // the old behaviour exactly: no taskKey, no writeScope, no placeholder to release.
  guard,
}) {
  // `allowedTools` is the Allowed Tools whitelist the gate enforces: a function when the
  // host owns the list, read again whenever the description is rendered, so a settings
  // change reaches the prompt without re-registering the tool. A fixed array is still
  // accepted, for tests and callers that have no live config. `deniedTools` is accepted
  // only as a legacy alias, so an older caller cannot silently describe the wrong rule.
  const list = allowedTools ?? deniedTools
  const liveAllowed = typeof list === 'function' ? list : () => list
  const rule = () => mainAgentRule(liveAllowed())
  const body =
    '把一个自包含任务交给子代理执行。子代理看不到本会话，prompt 必须写清目标、允许修改的文件、' +
    '验收命令与兜底方案；它按用户配置的 worker 路由运行，不要自行指定模型。本调用立即返回子代理 id，' +
    '结束时由运行时自动通知你。严禁要求子代理调用 send_message 汇报结果，它的收尾消息会在结束时自动送达。' +
    '多个独立子任务应在同一轮发起全部调用（delegate 可并发安全调用）；同构批量任务请用 orchestrate。' +
    '严禁两个子代理修改同一文件：需要并行时用 taskKey 给任务命名、用 writeScope 声明该子代理会写的路径，' +
    '相同 taskKey 或相交的 writeScope 会在派发前被拒绝，不相交的路径照常并行。' +
    'delegate 返回 subagentId 后，一律用 orchestrator_agents 管理它：status 查状态、send 追加任务或纠偏、' +
    'interrupt 提交中断信号。不要用 send_message / interrupt_agent 管理子代理，它们会因目标 id 遮蔽而失败；' +
    '更不要因为 send_message 失败就重派子代理。长时间运行的子代理会被插件每隔几分钟巡检：' +
    '收到「【插件巡检…】」消息（来自插件，不是用户）时，用 orchestrator_agents 的 send 纠正跑偏的子代理；' +
    '无需处理时单行回复并结束回合。'

  const tool = defineTool({
    name: DELEGATE_TOOL,
    description: rule() + body,
    parameters: {
      cwd: {
        type: 'string',
        description: '子代理初始工作目录（相对路径基于你的当前目录）；省略则继承当前目录。',
      },
      description: {
        type: 'string',
        required: true,
        description: '任务简述（3-5 个词），用于展示。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '交给子代理的完整任务说明；它看不到本会话。',
      },
      provider: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名该子代理的 provider 与 model 时才传，且需与 model 同时给出；' +
          '两者都省略时使用调度面板的 worker 路由。严禁自行选择模型。仅限本次派发，禁止复用历史轮次或摘要中的模型。',
      },
      model: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名该子代理的 provider 与 model 时才传，且需与 provider 同时给出；' +
          '两者都省略时使用调度面板的 worker 路由。严禁自行选择模型。仅限本次派发，禁止复用历史轮次或摘要中的模型。',
      },
      reasoning_effort: {
        type: 'string',
        description:
          '可选，仅与 provider 和 model 同时使用：该子代理的推理强度。省略则由所选模型决定默认值；仅当用户点名时才设置。',
      },
      taskKey: {
        type: 'string',
        description:
          '可选幂等键：同一 taskKey 在活动期间只能有一个派发，重复会在派发前被拒绝。' +
          '给要追踪的任务命名后，可用 orchestrator_agents 的 status/send/interrupt 管理它。省略则不做幂等检查。',
      },
      writeScope: {
        type: 'array',
        items: { type: 'string' },
        description:
          '可选写入范围：该子代理会改写的文件或目录路径（相对或绝对均可，末尾 /** 表示整个目录）。' +
          '两个活动任务的写入范围相交（相同、或一个是另一个的父目录）时会在派发前被拒绝，不相交则可并行。' +
          '省略表示不做范围检查（例如只读任务）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已启动子代理 ${value.subagentId}` }],
    },
    // Workers are independent by contract, so several may be started in one message.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('delegate requires a calling agent (exec.agent was undefined)')
      // Requiredness is declared in the schema, but direct tool use still needs the contract checked.
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') throw new Error('delegate requires a non-empty prompt')
      if (typeof args?.description !== 'string' || args.description.trim() === '') throw new Error('delegate requires a non-empty description')
      // An explicit per-call override wins and is never read from config; otherwise the
      // route is read at call time, so a changed route applies from this delegation on.
      const route = readRouteOverride(args, DELEGATE_TOOL) ?? readRoute(config)
      exec.signal.throwIfAborted()
      // The guard is claimed synchronously, in this same tick and before any `await`, so two
      // calls in one assistant message cannot both be admitted for one taskKey or for two
      // overlapping write scopes. A dispatch that fails below releases it immediately; a
      // successful one releases it when the child's receipt settles.
      const claim =
        guard === undefined
          ? undefined
          : guard.claim({ parentId: parent.id, taskKey: args.taskKey, writeScope: args.writeScope })
      let started
      try {
        const spec = buildActivation({
          args,
          parent,
          route,
          maxDepth: subagents.resolveMaxDepth(undefined),
          signal: exec.signal,
        })
        started = await subagents.startActivation(spec)
      } catch (error) {
        // Nothing was dispatched, so the placeholder must not outlive the failure.
        try {
          claim?.release()
        } catch {
          // A broken guard cannot replace the dispatch error the caller needs to see.
        }
        throw error
      }
      if (claim !== undefined) {
        // Bind the real child id, then release on either settlement. `release` is
        // idempotent, so a receipt that rejects still frees exactly one claim.
        claim.bind(started?.childId)
        const settled = started?.result
        if (settled !== null && typeof settled === 'object' && typeof settled.then === 'function') {
          try {
            settled.then(
              () => claim.release(),
              () => claim.release(),
            )
          } catch {
            // A hostile thenable must not break the dispatch.
          }
        }
      }
      // Supervision is best-effort: a missing or broken callback must neither fail the
      // dispatch nor change what the main agent receives back.
      try {
        const notified = typeof onStarted === 'function' ? onStarted(parent, started, args) : undefined
        // The callback is synchronous, but tolerate an async one without awaiting it.
        if (notified !== undefined && typeof notified.catch === 'function') notified.catch(() => {})
      } catch {
        // Deliberately swallowed: a supervision bug cannot be allowed to affect dispatch.
      }
      return { kind: 'activation', subagentId: started.childId }
    },
  })
  // The host reads `description` while it builds a request (its own run_code tool uses a
  // getter for the same reason), so this keeps the rule text in step with the gate.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => rule() + body,
  })
  return tool
}
