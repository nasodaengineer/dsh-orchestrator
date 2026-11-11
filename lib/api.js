/**
 * Public names, result kind and numeric limits, kept in one place so the tools,
 * the gate and the tests cannot drift apart.
 *
 * Dependency-free on purpose: importing this file must stay cheap and safe from
 * pure unit tests.
 */

export const DELEGATE_TOOL = 'delegate'
export const ORCHESTRATE_TOOL = 'orchestrate'

/**
 * The main agent's control surface over the subagents it dispatched. The name is
 * deliberately unique: the host's own `send_message` and `interrupt_agent` address any
 * agent by id, and a second tool sharing either name would mask the host's definition
 * for the target id. `orchestrator_agents` is also the name the worker deny list hides.
 */
export const AGENT_ADMIN_TOOL = 'orchestrator_agents'

/** The `kind` field of the unified orchestration result. */
export const ORCHESTRATION_KIND = 'orchestration'

/**
 * Where a started child delivers its result. `delegate` answers the parent agent
 * (the existing behaviour); `orchestrate` answers its caller, because the tool
 * itself waits for the result.
 */
export const DELIVERY = Object.freeze({
  delegate: 'parent',
  orchestrate: 'caller',
})

export const LIMITS = Object.freeze({
  /** One item per worker at the start of the fan-out. */
  items: Object.freeze({ min: 1, max: 64 }),
  /** A pipeline stage is one worker call per item. */
  stages: Object.freeze({ min: 1, max: 8 }),
  maxConcurrency: Object.freeze({ min: 1, max: 16, default: 4 }),
  /** A larger serialized result is an explicit error, never a silent truncation. */
  serializedResultChars: 50000,
})