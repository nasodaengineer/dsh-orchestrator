# dsh-orchestrator 隐式状态机穷举

> 范围：`lib/` 全部 15 个模块（5639 行）+ `test/` 12 个测试文件（318 断言）。
> 方法：逐行精读全部源码，用 `codebase-memory` 索引（610 节点 / 1794 边）定位结构，再用测试用例反向校验状态枚举的完整性。
> 基线：`node --test test/*.test.mjs` → **318 pass / 0 fail**。

## 什么是"隐式状态机"

本项目只有一处**显式声明**的状态机（`lib/stage.js` 的 `STAGES` 常量 + `reduceStage` 纯函数）。
其余状态机都没有状态枚举、没有 switch，状态散落在**闭包变量、Map 记录、布尔标志、计数器**里，
靠 `if` 守卫推进。这类结构一旦改错，没有类型系统或枚举能兜住——本文把它们逐台摊开。

下面的编号 M1–M12 是本文的索引，源码里并不存在这些名字。

---

## 总览

| # | 状态机 | 载体 | 状态形态 | 显式? | 推进者 |
|---|--------|------|----------|-------|--------|
| M1 | 阶段投影 | 投影状态 `{stage, plan}` | 6 枚举 | **是** | 会话事件流 fold |
| M2 | 巡检子代理 | `entries` Map 记录 | 6 字段复合 | 否 | 5s 定时 tick |
| M3 | 重试预算 | `records` + `seenRuns` | 4 字段复合 | 否 | `subagent/end` 事件 |
| M4 | 工具目录发布 | 6 个闭包变量 | 4 标志 | 否 | `tools/change` + 定时器 |
| M5 | 门禁生命周期 | `gates` Map | 3 状态 | 否 | `agent/created` / `agent/disposed` |
| M6 | 工具表面包装 | 单例 `disposed` | 2 状态 | 否 | `installToolSurface` |
| M7 | 编排条目/阶段 | 局部 `previous`/`output` | 3 真空值 | 否 | 顺序 await |
| M8 | 并发信号量 | `active`/`waiters` | 计数+队列 | 否 | acquire/release |
| M9 | 中止传播 | AbortSignal | 2 状态 | 否 | 多路竞速 |
| M10 | run_code 词法扫描 | `previous` + `stack` | 2 + 栈 | 否 | 字符流 |
| M11 | 客户端字段编辑 | React state | 5 状态 | 否 | 用户输入 |
| M12 | 客户端配置快照 | `scope.getSnapshot()` | 3 状态 | 否（宿主） | 订阅 |

---

## M1 阶段投影（唯一显式状态机）

**载体** `lib/stage.js:12-23`；注册于 `lib/index.js:28-38`（`stateVersion: 1`）。

### 状态

| 状态 | 含义 | 客户端文案 |
|------|------|-----------|
| `idle` | 新会话，尚无回合 | 默认 |
| `clarify` | 首个回合已开始 | 澄清 |
| `planning` | 计划模式已开启 | 规划 |
| `awaiting` | 计划已提交，等待确认 | 待确认 |
| `executing` | 已委派，正在执行 | 执行 |
| `na` | 派生会话（继承了父历史），不适用 | 不适用 |

`plan` 是与 `stage` 并列的第二个布尔状态位，**不等价于** `stage === 'planning'`：
`awaiting` 时 `plan` 仍为 `true`，`planning` 被手动退出时 `plan` 变 `false`。

### 迁移表（`reduceStage`，lib/stage.js:32-61）

| 当前 | 事件 | 下一 | 代码位置 |
|------|------|------|----------|
| 任意 | `stage === 'na'` | **保持不变（全局守卫）** | 33 |
| `idle` | `turn/start` | `clarify` | 35-37 |
| 非 `idle` | `turn/start` | 不变 | 36 |
| 任意 | `plan/mode` `active:true` | `planning` + `plan:true` | 40 |
| `awaiting` | `plan/mode` `active:false` | `executing` + `plan:false`（视为批准） | 42 |
| `planning` | `plan/mode` `active:false` | `clarify` + `plan:false`（手动放弃） | 44 |
| 其他 | `plan/mode` `active:false` | 仅 `plan:false`，stage 不变 | 45 |
| `idle`/`clarify` | `todo_write` | `planning` | 51-53 |
| 任意 | `exit_plan_mode` 且 `plan` | `awaiting` | 54-56 |
| 任意 | `exit_plan_mode` 且 `!plan` | 不变（守卫） | 55 |
| 非 `planning`/`awaiting` | `subagent`/`subagent_fork`/`workflow`/`orchestrate` | `executing` | 57-60 |
| `planning`/`awaiting` | 上述委派工具 | **不变**（探索≠执行） | 59 |

### 终局性

`na` 是**吸收态**（line 33 直接 return）。派生会话继承父历史，
若 fold 其工具调用会得出误导性阶段，因此整体拒绝演化。

`executing` **不是**终局态：`plan/mode active:true` 可把它拉回 `planning`。

### 事件识别

`calledTool` (lib/stage.js:26-30) 只认两种事件名：`tool/call` 与 `tool/ptc-dispatch-start`。
**PTC 分派的名字挂在 start 事件上**，漏掉第二种会让所有 `run_code` 内的委派隐形。

`DELEGATE_TOOLS` (lib/stage.js:15) 是四个名字的 Set：
`subagent` / `subagent_fork` / `workflow` / `orchestrate`。

### 不可推导的缺口（作者自陈，lib/stage.js:7-9）

> 不存在"评审/验收"阶段。日志里没有任何事件标记"worker 都跑完了、主代理正在检查"，
> 作者选择留空而不是猜。

---

## M2 巡检子代理状态机（lib/supervise.js:449-710）

**载体** `createSupervisor` 闭包内的 `entries: Map<childId, Entry>`。

```
Entry = { childId, parentId, label, startedAt, nextDueAt, noticesSent, lastSeq, intervalMs }
```

### 状态（由 4 个字段联合决定，无枚举）

| 隐式状态 | 判定条件 | 允许推进 |
|----------|----------|----------|
| 未登记 | `entries.has(id) === false` | `track` |
| 冷却中 | `now < nextDueAt` | 等待 |
| 到期未报 | `now >= nextDueAt` 且预算未尽 | 读日志→汇总→投递 |
| 预算耗尽 | `noticesSent >= maxNoticesPerChild` 且非 unlimited | **停在原地**（见下） |
| 等待中（父） | `hasPendingNotice(parent) === true` | 推迟一个 interval，**不扣预算** |
| 已遗忘 | 被 `forget`/`agent/disposed` 删除 | 终局 |

### 关键设计：预算耗尽 ≠ 遗忘

lib/supervise.js:580-584 —— 预算用尽时**保留登记且把 `nextDueAt` 留在过去**。
这样用户中途调高 `superviseMaxNoticesPerChild` 或打开 `superviseUnlimited` 时，
下一轮扫描**立刻**补报，而不必等满一个间隔。

### 迁移表

| 触发 | 迁移 | 位置 |
|------|------|------|
| `track(entry)` 新 child | 未登记 → 冷却中，`noticesSent: 0` | 489-499 |
| `track` 已存在（普通重登记） | 刷新任务与期限，**保留已用预算** | 496 |
| `track({resumed:true})` | **预算清零**，`lastSeq` 取调用方给的 head（避免把中断前历史当新活动） | 496-497 |
| tick: 父不存活 | 删该父名下全部登记 | 531-545 |
| tick: 子不存活 | 删该子 | 564-567 |
| tick: 间隔变更 | 按差值平移 `nextDueAt`，**保住已跳过的提前量** | 572-576 |
| tick: `newEvents===0` 且无打转且非 unlimited 且不需报告 | `nextDueAt = now + interval`，**不扣预算** | 606-609 |
| tick: `readEvents`/`summarize` 抛错 | `continue`——只跳过该子，**期限不动**，下轮重试 | 590-600 |
| deliver → `'queued'` | `noticesSent += 1`，`lastSeq = max(lastSeq, summary.lastSeq)`（**只增不减**） | 680-686 |
| deliver → `'parent-gone'` | 删该父**全部**登记 | 687-690 |
| deliver → `'already-pending'` | 推迟，不扣预算 | 691-692 |
| deliver → 其他/抛错 | 推迟，不扣预算，warn | 674-678, 693-696 |
| `forget(childId)` | 删除 | 502-504 |

### 重入保护

`ticking` 布尔标志（lib/supervise.js:452, 522-523, 701-703）：
两次 tick 重叠时第二次直接返回，**一个间隔绝不产生两条通知**。

### 关闭层级（lib/supervise.js:516-521）

两级 `return`，且顺序有意义：
1. `!config.enabled` → 全关，不清理、不唤醒、不动登记
2. `!unlimited && maxNoticesPerChild === 0` → 二级关闭，但**故意保留登记**

### 无进展与打转判定

`summary.newEvents === 0 && !looping` 时不值得花一个模型回合（lib/supervise.js:602-609）。
`looping = summary.repeated >= repeatThreshold`，`repeated` 只在最近 `REPEAT_WINDOW = 20` 次
`tool/call` 上计算（lib/supervise.js:200-215），旧打转不会永远告警。

---

## M3 重试预算状态机（lib/retry.js:124-244）

**载体** `records: Map<childId, Record>` + `seenRuns: Set<runId>`。

```
Record = { parentId, label, attemptStartedAt, retries, fastFailures }
```

### 状态

实质是**快失败计数**，不是普通的"重试 N 次"：

| 隐式状态 | `fastFailures` | 结局 |
|----------|-----------------|------|
| 未登记 | — | `'untracked'`（宿主自己的 `subagent` 子代理**永不重试**） |
| 健康 | 0 | `'settled'`（有收尾消息或非 error） |
| 重试中 | 1 | `'retry'` |
| 重试中 | 2 | `'retry'` |
| 判定不可用 | `> maxRetries`（即 ≥3） | `'unavailable'` + 唤醒父代理询问 A/B |

### 核心：窗口重置

lib/retry.js:215-218 —— `fast = now - attemptStartedAt < windowMs`（默认 120000ms）。

- **窗口内**再次失败：`fastFailures += 1`
- **窗口外**失败（跑了超过 2 分钟）：`fastFailures = 1`，`retries = 0` ——
  一次长跑证明模型能用，**预算重置**，该子代理重新获得一对重试

### 迁移表

| 触发 | 迁移 | 返回 | 位置 |
|------|------|------|------|
| `settle` 未登记 child | 无 | `'untracked'` | 201-202 |
| `settle` 重复 `runId` | 无 | `'duplicate'` | 203-206 |
| 非"静默失败" | 删记录 | `'settled'` | 209-212 |
| 快失败且 `fastFailures > maxRetries` | 删记录 + 唤醒父 | `'unavailable'` | 220-224 |
| 快失败且 `deliverPrompt` 缺失 | 删记录 + 唤醒父 | `'retry-failed'` | 229-233 |
| 快失败且投递成功 | 更新 `attemptStartedAt`，`retries += 1` | `'retry'` | 226-236 |
| 快失败且投递抛错 | 删记录 + 唤醒父 | `'retry-failed'` | 237-242 |

### 触发判据：`isMissingClosingMessage`（lib/retry.js:50-66）

同时接受两种形状（宿主生命周期事件与 receipt 结果）：
`{stopReason, output}` 或 `{stopReason, lastAssistantMessage}`。
判据：`stopReason === 'error'` **且**没有任何非空 `text` 块。

### 有界记忆

`MAX_RECORDS = 128`、`MAX_RUNS = 256`（lib/retry.js:32-35），
插入时先 `delete` 再 `set` 实现 LRU 式淘汰，长驻宿主不会无界增长。

---

## M4 工具目录发布状态机（lib/catalog.js:116-209）

**载体** 闭包变量：`published` / `announced` / `timer` / `disposed` / `warned` / `writable`。

### 状态

| 隐式状态 | `disposed` | `timer` | `published` |
|----------|-------------|----------|--------------|
| 存活空闲 | false | undefined | 上次目录 |
| 防抖中 | false | 定时器 | 上次目录 |
| 已释放 | true | 已清 | 冻结 |

### 迁移表

| 触发 | 迁移 | 位置 |
|------|------|------|
| `schedule()` 且 `timer === undefined` | 起 `debounceMs`（150ms）定时器 | 190-198 |
| `schedule()` 且已有定时器 | **空操作**（一次爆发只读一次） | 192 |
| 定时器到点 | 清 `timer` → `publish()` | 193-196 |
| `publish()` 且 `disposed` | 返回 `{changed:false}` | 152 |
| `publish()` 读到空/非数组 | **视为读失败**，保留上次目录 | 160-162 |
| 内容未变且引用仍持有 | 什么都不做 | 164 |
| 内容未变但引用被重置 | **重新提交**（Loader 每次写入都会重置 volatile 引用） | 164 |
| 字段不可写 | 记录一次 `published`，warn **仅一次** | 165-173 |
| 提交成功 | `published = names`，`announced += 1`，发 `settings/document-updated` | 174-187 |
| `dispose()` | `disposed = true`，清定时器 | 200-206 |

### 两条不变量

1. **空读不是空目录**（line 160-162）：读到 `[]` 时保留上次，面板才不会掉回内置副本。
2. **没有变化不发事件**（line 164）：防抖 + 内容比对，一次插件加载注册几十个工具也只发一次事件。

---

## M5 主代理门禁生命周期（lib/gate.js:163-190 + lib/index.js:485-625）

**载体** `gates: Map<agentId, {allowed, guardError, dispose}>`（lib/index.js:485）。

### 状态

| 隐式状态 | 判定 |
|----------|------|
| 未安装 | `gates.has(id) === false` |
| 已安装（就绪） | `guardError === undefined` |
| 已安装（降级） | `guardError !== undefined` —— 门禁没装上，但代理照常创建 |
| 已释放 | `agent/disposed` 后从 Map 删除 |

### 迁移表

| 触发 | 迁移 | 位置 |
|------|------|------|
| `agent/created` 且**派生子代理** | 不装门禁；若是 `source === 'resume'` 则 `hooks.onResumed` | index.js:576-584 |
| `agent/created` 且**主代理** | 调 `installFor`，写入 `gates` | index.js:588-589 |
| 主代理 resume 却带 `parentSession` | 记 warn（深度判定降级，历史上就是这个回归） | index.js:592-596 |
| `agent/disposed` | 删除并 `dispose()`；派生子代理额外 `hooks.forget` | index.js:608-625 |

### 门禁"永远安装"策略

lib/index.js:586 注释：**开关关闭时也安装**。
因为守卫在每次调用时读 `enabled()`，所以在一个已开的会话里把开关打开**立刻**生效。

### 判定主/子代理：`isDelegatedChild`（lib/gate.js:54-60）

```
max(持久化的 header.delegationDepth, 运行期 options.subagentDepth) > 0
```

- 持久化值是**权威且单调**的：冷恢复时运行期 options 只剩 provider/model/effort，没有 `subagentDepth`，
  只看运行值会把恢复的子代理误判成主代理。
- 脏值（负数、小数、NaN、字符串）当作缺失，**绝不抛出**——在 `agent/created` 钩子里抛会打断宿主的宣告路径。
- **GUI fork 是新的根会话**（有 `parentSession` 但深度为 0），所以仍按主代理门禁。
  **判定基于深度而非来源**，这正是测试写成深度判定的原因。

---

## M6 工具表面包装状态机（lib/tool-surface.js:59-149）

**载体** `tools[SURFACE]`（`Symbol.for('dsh-orchestrator.toolSurface')`）+ `disposed` 布尔。

### 状态

| 隐式状态 | 判定 |
|----------|------|
| 未安装 | `tools[SURFACE] === undefined` |
| 已安装 | `tools.definitions` 被替换 |
| 已释放 | `disposed === true` |

### 幂等规则

lib/tool-surface.js:67-68 —— 第二次安装**返回第一次的 disposer**，不叠加包装器（栈式包装会导致
同一份定义被过滤多次，且 disposer 顺序错乱）。

`dispose`（141-146）三件事且都带守卫：置位、仅当仍是自己的包装器才还原（避免踩掉后来者）、
仅当 Map 里记的还是自己才删除。

### 每个请求的 4 个判定（lib/tool-surface.js:127-137）

1. `scope` 为空 → 返回原列表（面板要完整目录）
2. `!enabled()` → 返回原列表
3. `isDelegatedChild(scope)` → 子代理删 `delegate`/`orchestrate` + 官方影子
4. 否则 → 主代理按白名单过滤 + 官方影子

`run_code` 在白名单过滤中**永远保留**（line 113）：它是 PTC 传输层，
`delegate`/`orchestrate` 是它内部的 SDK 函数，删掉它等于让 PTC 会话无法委派。

---

## M7 编排条目/阶段状态机（lib/orchestrate.js:269-451）

**载体** `runItem` 局部变量 `previous` / `output` / `stopReason`，以及全局 `results` / `errors`。

### 单个条目的状态

```
未开始 ──stage[0] 成功──▶ 阶段推进 ──stage[n-1] 成功──▶ 已产出 {index, output, stopReason:'completed'}
   │                                            │
   └──── 任一阶段失败 ──▶ 已失败（results[i]=null, errors.push）
```

### 真空值区分（`previous === undefined`）

lib/orchestrate.js:130 —— 用 `undefined` 而非 `null` 表示"第一阶段"。
因为一个阶段的合法输出**可以是 `null`**（`{type:'null'}` schema），
用 `null` 做哨兵会让第二阶段误判成第一阶段。

### 迁移表

| 触发 | 迁移 | 位置 |
|------|------|------|
| 条目开始 | `stopReason = 'completed'`，`previous = undefined` | 395-396 |
| 阶段成功 | `previous = {stageName, output}`，`stopReason='completed'` | 410-412 |
| 阶段抛错且**未中止** | 记入 `errors`，`return null`（该条终止） | 413-418 |
| 阶段抛错且**已中止** | `throw abortReason`（整体失败，不算单条失败） | 415 |
| 全部阶段成功 | `return {index, output, stopReason}` | 420 |

### 关键区分：整体中止 vs 单条失败

lib/orchestrate.js:414-415 —— `if (signal.aborted) throw abortReason(signal)` 在 `catch` **最前面**。
若把它放在后面，中止会被误记成"这一条失败了"，其余条目继续跑。

### 阶段输出判定（`readStageOutput`，lib/orchestrate.js:176-208）

| `stopReason` | 有 schema | 无 schema |
|---------------|-----------|-----------|
| `completed` | 可恢复 | 可恢复 |
| `error` | **可恢复**（宿主不派发 structured_output 时文本作答也以 error 结束） | **不可恢复** |
| 其他（aborted / max-tokens / refusal…） | 不可恢复 | 不可恢复 |

有 `structured` 时它**权威**：校验失败即抛错，绝不回退到文本。
无 `structured` 时从文本 `JSON.parse`，且只回显 schema 违规而非把文本原样抛出。

---

## M8 并发信号量（lib/orchestrate.js:228-263）

**载体** `active: number` + `waiters: Waiter[]`。

### 状态

| 隐式状态 | 判定 |
|----------|------|
| 有空位 | `active < limit` |
| 已满 | `active >= limit`，新到达者排队 |
| 转让中 | `release()` 取到 waiter，`active` **保持不变** |

### 关键不变量

lib/orchestrate.js:252-262 —— `release()` 若有等待者，**槽位直接转让**，`active` 不减（减一在 line 255，只在没有等待者时执行）。
若写成先减再 resolve，会出现瞬时空位导致超发。

### 中止与队列

- `acquire` 前先 `throwIfAborted()`（236）
- 排队期间 `abort` → 从 `waiters` 摘除并 reject（243-248）
- 转让时先 `removeEventListener`（259），避免已 resolve 的 waiter 仍被中止删掉

---

## M9 中止传播状态机（lib/orchestrate.js:305-309, 332-382）

**载体** `exec.signal`（AbortSignal），一次性不可逆：false → true。

### 竞速点

| 位置 | 竞速对象 | 中止后的处理 |
|------|----------|--------------|
| 307-308 | 入口 | 已中止直接 throw |
| 315-317 | 取信号量后 | 再检查一次（acquire 期间可能已中止） |
| 329-352 | `startActivation` 本身 | **迟到 handle 就地 dispose，绝不派发** |
| 361 | handle 校验后 | 再检查 |
| 368-381 | `started.result` | 只拒绝，**不等 worker 收尾** |
| 382 | 读结果前 | 再检查 |

### 关键：迟到 handle

lib/orchestrate.js:343-347 —— `startActivation` 可能在 abort 之后才解析出 handle。
此时**先 dispose 再 reject**，并因此**不计入** `agentsStarted`（只统计有效且未被中止的 handle，line 362-364）。

---

## M10 run_code 词法扫描状态机（lib/run-code-guard.js:246-373）

**载体** `previous: 'value' | 'operator'` + `stack: ('brace'|'template')[]` + `index`。

这是全文**最像经典状态机**的一台：一个手写词法器，逐字符推进。

### 状态变量

| 变量 | 取值 | 作用 |
|------|------|------|
| `previous` | `'value'` / `'operator'` | 区分**正则字面量**与**除号** |
| `stack` | `'brace'` / `'template'` 的栈 | `}` 是关块还是回到模板字面量 |
| `index` | 字符位置 | 游标 |

### 为何需要 `previous`

lib/run-code-guard.js:59-62 —— 不知道前一个 token 时，斜杠无法与除号区分；
一次误判会让正则里的引号打乱后续所有字符串边界。`OPERATOR_KEYWORDS`（63-78）
列出 14 个"其后可开始表达式（因而可开始正则）"的关键字。

### 转移（每个字符）

| 输入 | 动作 | `previous` |
|------|------|-------------|
| 空白 | 跳过 | 不变 |
| 行注释 / 块注释 | 整体跳过 | 不变 |
| 引号字符串 | `skipString` | `value` |
| 反引号 | `readTemplateChunk`；开模板插值则压 `template` | `operator` / `value` |
| 斜杠且 `previous === 'value'` | 当除号 | `operator` |
| 斜杠且 `previous !== 'value'` | `skipRegex`；失败则当除号 | `value` |
| 标识符（含 Unicode 转义） | `readIdentifier` → **查禁名单** | 关键字→`operator`，否则 `value` |
| 数字（含点开头、指数） | 整体吞掉 | `value` |
| 左花括号 | 压 `brace` | `operator` |
| 右花括号 | 弹栈；若是 `template` 则续读模板块 | `value` / `operator` |
| 右圆括号 / 右方括号 | 跳过 | `value` |
| 其他 | 跳过 | `operator` |

### 转义解析的必要性

lib/run-code-guard.js:112-130, 142-149 —— Unicode 转义写法（反斜杠 u 加十六进制）
在运行时就是 `process` 与 `import` 本身。不解析转义，禁名单形同虚设。

### 禁名单（14 个，lib/run-code-guard.js:41-56）

`import` `require` `process` `globalThis` `global` `Buffer` `fetch` `WebSocket`
`XMLHttpRequest` `eval` `Function` `Reflect` `constructor` `__proto__`

`constructor` 与 `__proto__` **在任何代码位置都禁**：
用箭头函数的 `constructor` 拿回 `Function` 再执行 `return process`，是回到宿主最短的一条路。

### 词法（而非正则）的动机

lib/run-code-guard.js:17-25 —— 主代理的 `run_code` 主体大量是
`await tools.delegate({ prompt: <模板字符串> })`，那些 prompt 里**合法地**会提到
`import("node:fs")`、`process.env`。对原始源码做正则会把每一次这样的委派都拒掉。

### 另一道闸：`runCodeRefusal`（391-402）

`sandbox_permissions` / `justification` 在参数上直接拒绝——那会把整个程序提权，
从而绕过所有工具级检查。`active !== true` 时全部放行（配置里关掉门禁的语义）。

---

## M11 客户端配置字段编辑状态机（lib/client.js）

以 `SuperviseIntervalField`（825-931）为代表，`PatrolCountField`（943 起）同构。

**载体** React state：`draft` / `hint` / `busy` + refs `alive` / `shown`。

### 状态

| 隐式状态 | 判定 |
|----------|------|
| 展示中 | `busy === false`，`draft` 等于已存值的字符串 |
| 已改动未提交 | `draft` 与已存值不同 |
| 提交中 | `busy === true`（输入框 disabled） |
| 已拒绝 | `hint !== null`，4 秒后自动清除 |
| 已卸载 | `alive.current === false`，所有异步回调不再 setState |

### 迁移表（`commit`，861-891）

| 触发 | 迁移 | 位置 |
|------|------|------|
| `busy` 中再次提交 | **空操作**（防重入） | 862 |
| 解析失败 | `reject`：设 hint + 回弹到已存值 | 864-867 |
| 与新值相同 | 回弹 + 清 hint，**不发 mutate** | 869-873 |
| 只读 | `reject(readonly)` | 874-877 |
| mutate 成功且回读一致 | 清 hint | 883 |
| mutate 成功但回读不一致 | `reject(saveFailed)` ——**以回读为准**，不信写入返回值 | 884 |
| mutate 抛错 | `reject(saveFailed)` | 885-887 |
| 按 Escape | 回弹 + 清 hint | 919-923 |
| 外部值变化 | `shown` ref 比对后同步 `draft` | 842-846 |

### 两个容易漏的点

1. **回读校验**（883）：保存成功后**重新读快照**确认落地，不信任 mutate 的返回值。
2. **`alive` ref**（831-840）：组件卸载后所有 `await` 之后的 setState 都要先检查，
   否则 React 会警告且可能写入已卸载组件。

### `catalogFor` 的粘滞态（lib/client.js:427-430）

`live.length > 0 ? live : remembered ?? []` ——
配置写入的瞬间 Loader 会把 volatile 字段重置成默认值（空数组），
面板会把空读当成"没有目录"而掉回内置副本。**记住上一次非空值**消除这个闪烁。

---

## M12 客户端配置快照状态机（宿主提供的 `scope`）

**载体** `scope.getSnapshot()` → `{status, writable, revision, value}`。

| `status` | 含义 | 面板行为 |
|-----------|------|----------|
| `'ready'` + 可写 | 允许编辑 | — |
| `'ready'` + 只读 | 禁用 + 提示"当前不可写" | — |
| `'loading'` | 尚未就绪 | 禁用 |

**`revision` 是乐观锁**：每次 `mutate(ops, revision)` 都带上快照里的 revision（881、996、
1017、1188、1577），并发写会被宿主拒绝而不是覆盖。保存前必须**重新取**最新快照（878、1176），
不能用组件顶部的旧快照。

---

## 跨机器协同：一次失败的完整生命周期

把 M2/M3/M5 串起来看，一次"子代理静默失败"的状态迁移是：

```
delegate 调用
   ├─▶ onStarted ─▶ M2 entries 登记（nextDueAt = startedAt + interval）
   │              └─▶ M3 records 登记（fastFailures = 0, attemptStartedAt = now）
   │
5s tick ─▶ M2 到期 ─▶ 读日志 ─▶ composeNotice ─▶ deliver 'queued'
                                          └─▶ noticesSent += 1

subagent/end ─▶ M3 settle
                  ├─ 有收尾消息 ─▶ 'settled'（删记录）
                  └─ 静默失败 ─▶ fastFailures 判定
                                   ├─ ≤2 ─▶ 投递重试提示 ─▶ 'retry'
                                   └─ ≥3 ─▶ 唤醒父代理询问 A/B ─▶ 'unavailable'

agent/disposed ─▶ M5：子代理 ─▶ hooks.forget（M2 删登记）
                     主代理 ─▶ gate.dispose（M5 删条目）
```

**两个注册表的键相同（childId）但生命周期不同**：
M2 在 receipt settle 时就 `forget`（lib/index.js:399-406），M3 在同一时刻 `settle` 并自行删记录。
M2 还会因 `agent/disposed` 再删一次，M3 不会——因为它只在结算时动作。

---

## 穷举性声明

- `lib/` **15 个文件全部逐行读完**，共 5639 行；`test/` 12 个文件按状态枚举反向 grep 校验。
- 上述 M1–M12 覆盖了所有**跨调用存活的**状态载体：
  已逐一确认 `Map` / `Set` / 闭包变量 / React state / AbortSignal 的每一处声明与读写。
- **纯函数模块**（`schema.js` 校验器、`catalog.js` 的 `viewNames`/`catalogOf`、
  `run-code-guard.js` 的辅助读取器、`supervise.js` 的 `summarize`/`composeNotice`）
  无跨调用状态，不计入状态机；其中 `summarize` 是纯 fold（累计量在局部变量里，返回即丢弃）。
- **未计入**：`lib/schema.js` 的 `inspectNode` 虽是递归遍历，但用 `seen` Set 做**环检测**
  而非状态机（进入即加、离开即删，见 line 102 / 221）。
- `lib/client.js` 的其余 1700 余行是纯样式常量与无状态渲染函数（已 grep 全部
  `useState` / `useEffect` / `useRef` 确认：11 处状态，M11/M12 已归纳）。
