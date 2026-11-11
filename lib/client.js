window.__ModuleLoader__.load({
  id: 'dsh-orchestrator',
  factory: (load) => {
    const module = { exports: {} }
    ;(function (module, exports, require) {
      'use strict'
      const React = require('react')
      // The host's client module loader registers `react-dom` beside `react`; the guard keeps a
      // host that does not from taking the whole bundle down (the list then renders in place).
      let ReactDOM = null
      try {
        ReactDOM = require('react-dom')
      } catch {
        ReactDOM = null
      }

      /** Dictionary namespace owned by this plugin. */
      const NS = 'orchestrator'

      const zh = {
        'toggle.label': '计划',
        'toggle.on': '计划模式已开启，点击关闭 (/plan off)',
        'toggle.off': '计划模式已关闭，点击开启 (/plan)',
        'toggle.pending': '，将在下一步生效',
        'toggle.failed': '切换计划模式失败',
        'stage.idle': '默认',
        'stage.clarify': '澄清',
        'stage.planning': '规划',
        'stage.awaiting': '待确认',
        'stage.executing': '执行',
        'stage.na': '不适用',
        'route.button': '调度模式',
        'route.title': '主代理与子代理的默认模型',
        'route.main': '主代理',
        'route.worker': '子代理',
        'route.effort': '推理强度',
        'route.effortDefault': '模型默认',
        'route.unset': '未设置',
        'route.loading': '正在加载模型目录…',
        'route.catalogFailed': '无法加载模型目录',
        'route.readonly': '当前不可写，无法保存',
        'route.saveFailed': '保存失败',
        'route.note': '主代理的改动对新会话生效；子代理的改动从下一次委派起生效。所有子代理共用同一个模型。',
        'route.search': '搜索模型…',
        'route.noMatch': '没有匹配的模型',
        'route.noMatchHint': '换个关键词，或清空搜索看全部',
        'route.selected': '当前选中',
        'route.enable': '启用调度模式',
        'route.enableNote': '开启后主代理只做规划、由子代理执行；已打开的会话也会立即生效。',
        'route.enableFailed': '切换失败',
        'allowed.title': 'Allowed Tools',
        'allowed.search': '搜索工具…',
        'allowed.empty': '没有匹配的工具',
        'allowed.reset': '重置',
        'allowed.hint': '白名单式驱动：勾选 = 允许主代理使用；未勾选（含新插件工具）= 自动禁用。',
        'supervise.label': '子代理巡检间隔（秒）',
        'supervise.hint': '默认 600 秒（10 分钟）。主代理会按此间隔检查运行中的子代理，运行中修改立即生效。范围 10–86400。',
        'supervise.invalid': '请输入 10–86400 之间的整数',
        'supervise.saveFailed': '保存失败',
        'supervise.readonly': '当前不可写，无法保存',
        'supervise.countLabel': '子代理巡检次数',
        'supervise.unlimitedLabel': '无限次数巡检',
        'supervise.countHint': '默认 3 次，设为 0 关闭巡检。开启右侧无限巡检后强制一直巡检，直至子代理停止、交付或结束。范围 0–20。',
        'supervise.countInvalid': '请输入 0–20 之间的整数',
      }
      const en = {
        'toggle.label': 'Plan',
        'toggle.on': 'Plan mode is on, click to turn off (/plan off)',
        'toggle.off': 'Plan mode is off, click to turn on (/plan)',
        'toggle.pending': ', applies from the next step',
        'toggle.failed': 'Could not switch plan mode',
        'stage.idle': 'Default',
        'stage.clarify': 'Clarify',
        'stage.planning': 'Planning',
        'stage.awaiting': 'Review',
        'stage.executing': 'Executing',
        'stage.na': 'N/A',
        'route.button': 'Dispatch',
        'route.title': 'Default models for the main agent and subagents',
        'route.main': 'Main agent',
        'route.worker': 'Subagent',
        'route.effort': 'Reasoning effort',
        'route.effortDefault': 'Model default',
        'route.unset': 'Not set',
        'route.loading': 'Loading the model catalog…',
        'route.catalogFailed': 'Could not load the model catalog',
        'route.readonly': 'Not writable right now, cannot save',
        'route.saveFailed': 'Could not save',
        'route.note': 'A main agent change applies to new sessions; a subagent change applies from the next delegation. All subagents share one model.',
        'route.search': 'Search models…',
        'route.noMatch': 'No matching models',
        'route.noMatchHint': 'Try another keyword, or clear the search to see everything',
        'route.selected': 'selected',
        'route.enable': 'Enable dispatch mode',
        'route.enableNote': 'The main agent only plans and delegates the work; an open conversation follows the switch immediately.',
        'route.enableFailed': 'Could not switch',
        'allowed.title': 'Allowed Tools',
        'allowed.search': 'Filter tools…',
        'allowed.empty': 'No matching tools',
        'allowed.reset': 'Reset',
        'allowed.hint': 'Whitelist-driven: checked = allowed for the main agent; unchecked (including new plugin tools) = blocked automatically.',
        'supervise.label': 'Subagent check interval (seconds)',
        'supervise.hint': 'Default 600 seconds (10 minutes). The main agent checks running subagents at this interval; changes apply immediately. Range 10–86400.',
        'supervise.invalid': 'Enter an integer between 10 and 86400',
        'supervise.saveFailed': 'Could not save',
        'supervise.readonly': 'Not writable right now, cannot save',
        'supervise.countLabel': 'Subagent check count',
        'supervise.unlimitedLabel': 'Unlimited checks',
        'supervise.countHint': 'Default 3; set 0 to turn checks off. Turn on Unlimited checks to keep checking until the subagent stops, delivers, or ends. Range 0–20.',
        'supervise.countInvalid': 'Enter an integer between 0 and 20',
      }

      const baseStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
      // A lit control borrows the host's brand and ghost-active fills so it reads right in both themes.
      const onStyle = {
        borderColor: 'var(--dsw-alias-brand-primary, #4d8dff)',
        background: 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, #4d8dff 16%, transparent))',
      }
      const dot = (on) => ({
        width: '6px',
        height: '6px',
        borderRadius: '999px',
        background: on ? 'var(--dsw-alias-brand-primary, #4d8dff)' : 'var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 45%, transparent))',
      })

      /**
       * Plan-mode toggle. The native plan projection folds the host's committed
       * state; `/plan` during an open turn is queued, so `pending` means the shown
       * target differs from what the host has applied so far.
       */
      function PlanToggle({ useProjection, locked, setPlan, t }) {
        // A blank new conversation has no folded plan state yet; that is plan mode off.
        const plan = useProjection('plan') ?? { active: false, pending: false }
        // Derived by the host from logged events; absent until the first projection arrives.
        const stage = useProjection('orchestrator')?.stage ?? 'idle'
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const alive = React.useRef(true)
        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        const target = plan.pending ? !plan.active : plan.active
        const base = target ? t('toggle.on') : t('toggle.off')
        // The button face only says "Plan" and is lit when on; the stage lives in the hover text.
        const title = error ?? (plan.pending ? base + t('toggle.pending') : base) + ' · ' + t('stage.' + stage)

        const onClick = () => {
          if (busy || locked) return
          setBusy(true)
          setError(null)
          setPlan(!target).then(
            (failure) => {
              if (!alive.current) return
              setBusy(false)
              setError(failure)
            },
            (reason) => {
              if (!alive.current) return
              setBusy(false)
              setError(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('toggle.failed'))
            },
          )
        }

        return React.createElement(
          'button',
          {
            type: 'button',
            style: Object.assign({}, baseStyle, target ? onStyle : null, busy || locked ? { opacity: 0.6 } : null),
            disabled: busy || locked,
            onClick,
            title,
            'aria-label': title,
            'aria-pressed': target,
            'data-plan': target ? 'on' : 'off',
            'data-pending': plan.pending ? 'true' : 'false',
            'data-stage': stage,
          },
          React.createElement('span', { style: dot(target), 'aria-hidden': true }),
          React.createElement('span', null, t('toggle.label')),
        )
      }

      // ---- Default routes -------------------------------------------------------------------
      // Two stored routes, each a { provider, model, effort } triple under different field names.
      // The main agent's lives in the host's `agent-default-model` entry (read when an agent is
      // created); the workers' lives in this plugin's own entry (read on every delegation).
      // `clear` says how "no effort" is stored. The main agent's field is optional with no
      // empty value, so its override is removed. The subagent field ships a default in the
      // plugin bundle, and removing the override would bring that default back, so it stores ''.
      const MAIN = {
        ns: 'agent-default-model',
        fields: { provider: 'provider', model: 'model', effort: 'reasoningEffort', clear: 'unset' },
      }
      const WORKER = {
        ns: 'orchestrator',
        fields: { provider: 'workerProvider', model: 'workerModel', effort: 'workerReasoningEffort', clear: 'empty' },
      }

      const routeKey = (provider, model) => JSON.stringify([provider, model])

      function parseRouteKey(key) {
        try {
          const v = JSON.parse(key)
          return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string'
            ? { provider: v[0], model: v[1] }
            : undefined
        } catch {
          return undefined
        }
      }

      /** Read a stored route out of a config section; absent fields read as empty. */
      function routeOf(fields, value) {
        const get = (name) => (typeof value?.[name] === 'string' ? value[name] : '')
        return { provider: get(fields.provider), model: get(fields.model), effort: get(fields.effort) }
      }

      /** No effort lets the model resolve its own default; `fields.clear` says how that is stored. */
      function routeOps(fields, route) {
        const cleared = fields.clear === 'empty' ? { op: 'set', path: [fields.effort], value: '' } : { op: 'unset', path: [fields.effort] }
        return [
          { op: 'set', path: [fields.provider], value: route.provider },
          { op: 'set', path: [fields.model], value: route.model },
          route.effort === '' ? cleared : { op: 'set', path: [fields.effort], value: route.effort },
        ]
      }

      /** The catalog entry for a stored route, or undefined when it is not offered any more. */
      function findModel(groups, route) {
        for (const group of groups) {
          if (group.id !== route.provider) continue
          const model = group.models.find((m) => m.id === route.model)
          if (model !== undefined) return model
        }
        return undefined
      }

      /**
       * Narrow the catalog to what a free-text query matches. A provider name matches every model it
       * offers; otherwise model ids and display names are matched. An empty query is the whole catalog.
       */
      function filterGroups(groups, query) {
        const needle = query.trim().toLowerCase()
        if (needle === '') return groups
        const hit = (text) => text.toLowerCase().includes(needle)
        const matched = new Map()
        const kept = []
        for (const group of groups) {
          if (hit(group.id) || hit(group.name ?? '')) {
            kept.push(group)
            matched.set(group.id, group.models.length)
            continue
          }
          const models = group.models.filter((model) => hit(model.id) || hit(model.name ?? ''))
          if (models.length === 0) continue
          matched.set(group.id, models.length)
          kept.push(models.length === group.models.length ? group : { ...group, models })
        }
        return kept
      }

      /** How many models a catalog holds, for the match counter next to the filter. */
      function countModels(groups) {
        return groups.reduce((total, group) => total + group.models.length, 0)
      }

      /** Write one route and confirm it landed. Returns an error message, or null on success. */
      async function saveRoute(scope, fields, route, t) {
        const snapshot = scope.getSnapshot()
        if (snapshot.status !== 'ready' || !snapshot.writable) return t('route.readonly')
        try {
          await scope.mutate(routeOps(fields, route), snapshot.revision)
        } catch (reason) {
          // Not `instanceof Error`: remote failures can be plain { code, message } objects.
          return typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('route.saveFailed')
        }
        const stored = routeOf(fields, scope.getSnapshot().value)
        const landed =
          stored.provider === route.provider && stored.model === route.model && stored.effort === route.effort
        return landed ? null : t('route.saveFailed')
      }

      // ---- Supervision interval -------------------------------------------------------------
      // The host stores `superviseIntervalSeconds` as a number with a schema default, so a
      // missing value, a string, a fraction, or a number out of range all read as the default.
      const INTERVAL = { key: 'superviseIntervalSeconds', min: 10, max: 86400, fallback: 600 }

      /** The stored interval when it is a valid integer, else the schema default of 600. */
      function intervalOf(value) {
        const raw = value?.[INTERVAL.key]
        return typeof raw === 'number' && Number.isInteger(raw) && raw >= INTERVAL.min && raw <= INTERVAL.max
          ? raw
          : INTERVAL.fallback
      }

      /**
       * Parse a typed interval. Trimmed text only: digits, no sign, no decimal point, no
       * exponent. An empty field means "back to the default", which is written as 600.
       */
      function parseInterval(text) {
        const trimmed = String(text ?? '').trim()
        if (trimmed === '') return { ok: true, seconds: INTERVAL.fallback, empty: true }
        if (!/^[0-9]+$/.test(trimmed)) return { ok: false, empty: false }
        const seconds = Number(trimmed)
        if (!Number.isSafeInteger(seconds) || seconds < INTERVAL.min || seconds > INTERVAL.max) {
          return { ok: false, empty: false }
        }
        return { ok: true, seconds, empty: false }
      }

      // ---- Supervision notice count ---------------------------------------------------------
      // `superviseMaxNoticesPerChild` caps how many patrol notices one child may trigger; 0
      // turns patrol off entirely. `superviseUnlimited` overrides the cap and keeps checking
      // until the child stops, delivers, or ends. Both are volatile host config fields.
      const PATROL_COUNT = {
        key: 'superviseMaxNoticesPerChild',
        unlimitedKey: 'superviseUnlimited',
        min: 0,
        max: 20,
        fallback: 3,
      }

      /** The stored notice count when it is a valid integer in range, else the default of 3. */
      function patrolCountOf(value) {
        const raw = value?.[PATROL_COUNT.key]
        return typeof raw === 'number' &&
          Number.isInteger(raw) &&
          raw >= PATROL_COUNT.min &&
          raw <= PATROL_COUNT.max
          ? raw
          : PATROL_COUNT.fallback
      }

      /** Whether unlimited patrol is switched on. Only a literal `true` counts. */
      function unlimitedOf(value) {
        return value?.[PATROL_COUNT.unlimitedKey] === true
      }

      /**
       * Parse a typed notice count. Trimmed text only: digits, no sign, no decimal point.
       * An empty field means "back to the default", which is written as 3.
       */
      function parsePatrolCount(text) {
        const trimmed = String(text ?? '').trim()
        if (trimmed === '') return { ok: true, count: PATROL_COUNT.fallback, empty: true }
        if (!/^[0-9]+$/.test(trimmed)) return { ok: false, empty: false }
        const count = Number(trimmed)
        if (!Number.isSafeInteger(count) || count < PATROL_COUNT.min || count > PATROL_COUNT.max) {
          return { ok: false, empty: false }
        }
        return { ok: true, count, empty: false }
      }

      // ---- Allowed tools --------------------------------------------------------------------
      // Whitelist-driven. The shipped allow list is mirrored from the host
      // (DEFAULT_ALLOWED_TOOLS in lib/index.js): the same names, in the same order.
      // A web client plugin has no API that enumerates host tools — the session remote offers
      // session/model/skill methods only, and configForms exposes this plugin's own config — so
      // the plugin's server half collects the live catalog and publishes it as the volatile
      // `toolCatalog` field of that same config (lib/catalog.js). The panel renders the union
      // of that catalog, this shipped list and the config key; the shipped copy is also
      // the fallback on a host that publishes nothing. A unit test keeps this copy equal to the
      // host constant, so the two cannot drift apart.
      const DEFAULT_ALLOWED_TOOLS = [
        'delegate',
        'orchestrate',
        'orchestrator_agents',
        'todo_write',
        'ask_user_question',
        'compress',
        'session_search',
        'session_trace',
        'session_event_search',
        'session_event_read',
        'session_event_trace',
      ]
      /** The shipped list as a set, for the "still exactly the default?" comparison. */
      const DEFAULT_ALLOWED_SET = new Set(DEFAULT_ALLOWED_TOOLS)
      /** The projection key the session's own dispatch mode is published under. */
      const MODE_PROJECTION_KEY = 'orchestratorMode'
      /** The command that flips one session's dispatch mode. */
      const MODE_COMMAND = 'orchestrator-mode'
      /** The config key the panel reads and writes. */
      const ALLOW_KEY = 'allowedTools'
      /** The read-only config field the host publishes the live catalog into. */
      const CATALOG_KEY = 'toolCatalog'

      /** A string array config field, tolerating a missing or oddly shaped value. */
      function namesOf(value, key) {
        const raw = value?.[key]
        return Array.isArray(raw) ? raw.filter((name) => typeof name === 'string' && name !== '') : []
      }

      /**
       * The live catalog the server half published: every tool the running host offers,
       * including the ones other plugins and MCP servers registered. Absent (or empty) on
       * an older host or before the first publish, which leaves the shipped list alone.
       */
      function catalogOf(value) {
        return namesOf(value, CATALOG_KEY)
      }

      /**
       * The catalog to render. A settings write commits the profile's raw value into every
       * volatile field the Loader was handed (lib/catalog.js), so for the instant between
       * that commit and the plugin publishing the catalog again the panel would read an
       * empty list and drop back to its shipped-name fallback. An empty read is never a real
       * catalog, so the last non-empty one stands in for it.
       */
      function catalogFor(value, remembered) {
        const live = catalogOf(value)
        return live.length > 0 ? live : remembered ?? []
      }

      /**
       * Every row: the shipped allow list in its own order first, then every other name the
       * live catalog or the config key knows, alphabetically. A catalog name is shown even
       * when the shipped list does not know it, and starts unchecked — a tool the user never
       * allowed, including one a plugin or MCP server registered later, stays blocked for the
       * main agent until it is checked here.
       */
      function toolListOf(value, catalog) {
        const listed = [...DEFAULT_ALLOWED_TOOLS]
        const seen = new Set(listed)
        const extras = new Set()
        for (const name of catalog ?? catalogOf(value)) {
          if (seen.has(name)) continue
          extras.add(name)
        }
        for (const name of namesOf(value, ALLOW_KEY)) {
          if (seen.has(name)) continue
          extras.add(name)
        }
        return [...listed, ...[...extras].sort((a, b) => a.localeCompare(b))]
      }

      /**
       * The effective allow set, mirroring the host's effectiveAllowed(). An array — including
       * an empty one the user deliberately cleared — is the stored whitelist verbatim; anything
       * else means the field was never set, so the shipped list stands in. The two cases must
       * stay distinct: `[]` means "allow nothing", `undefined` means "ship defaults".
       */
      function allowedSetOf(value) {
        return Array.isArray(value?.[ALLOW_KEY]) ? new Set(namesOf(value, ALLOW_KEY)) : new Set(DEFAULT_ALLOWED_TOOLS)
      }

      /**
       * The plugin a tool belongs to, derived from its name.
       *
       * The host publishes tool names only — the registry carries no "which plugin registered
       * this" field, and a web client cannot enumerate registrations — so grouping has to read
       * the naming conventions the host itself enforces:
       *
       *   mcp__<server>__<tool>  the MCP namespace, the only *guaranteed* one
       *   <prefix>_<name>        a plugin's own prefix (`ops_bash`, `session_search`)
       *   <name>                 a single-word name belongs to the host's own core set
       *
       * A prefix is only a group when it really groups something: `read` and `grep` stay in
       * their own single row rather than merging into a meaningless "host" bucket.
       */
      function pluginKeyOf(name, known) {
        const tool = String(name ?? '')
        if (tool === '') return ''
        const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(tool)
        if (mcp !== null) return 'mcp:' + mcp[1]
        const underscore = tool.indexOf('_')
        if (underscore > 0) return tool.slice(0, underscore)
        return tool
      }

      /**
       * Group tool names by plugin, for the grouped checklist.
       *
       * `known` is the full unfiltered list: a group is only formed when its prefix covers more
       * than one tool OR the prefix is the whole name, so a stray underscore in a one-off tool
       * cannot invent a group of one. Groups are returned in first-seen order, which keeps the
       * shipped whitelist's order at the top of the list.
       */
      function groupTools(names, known = names) {
        const counts = new Map()
        for (const name of known ?? []) {
          const key = pluginKeyOf(name)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        // A group keeps every member, wherever the member sits in the list. Grouping must not
        // reorder the rows: the shipped whitelist comes first in its published order, and the
        // extras follow sorted, so a search result reads in the same order it always did. The
        // group is rendered at its first member's position; its later members stay where they
        // are instead of being pulled up into a contiguous block.
        const groups = new Map()
        for (const name of names ?? []) {
          const key = pluginKeyOf(name)
          const shared = (counts.get(key) ?? 0) > 1 || key === name
          const groupKey = shared ? key : name
          if (!groups.has(groupKey)) groups.set(groupKey, { key: groupKey, tools: [] })
          groups.get(groupKey).tools.push(name)
        }
        return [...groups.values()]
      }

      /** Case-insensitive substring match on the tool name; an empty query keeps every row. */
      function filterTools(names, query) {
        const needle = String(query ?? '').trim().toLowerCase()
        if (needle === '') return names
        return names.filter((name) => name.toLowerCase().includes(needle))
      }

      /**
       * The single config write that reproduces a checkbox state. A set equal to the shipped
       * list is stored as an unset field, so a profile that never changed anything keeps the
       * schema default instead of pinning a copy of this build's list; anything else — extra
       * names, a removed name, or an emptied whitelist — is stored verbatim.
       */
      function allowOps(checked) {
        const list = [...new Set(checked)]
        const isDefault =
          list.length === DEFAULT_ALLOWED_TOOLS.length && list.every((name) => DEFAULT_ALLOWED_SET.has(name))
        return [isDefault ? { op: 'unset', path: [ALLOW_KEY] } : { op: 'set', path: [ALLOW_KEY], value: list }]
      }

      /** Back to the shipped list: the key cleared, so the schema default applies again. */
      function resetAllowOps() {
        return [{ op: 'unset', path: [ALLOW_KEY] }]
      }

      const h = React.createElement
      // The popover is two columns: the original panel keeps its width, padding and
      // outline, and its own right border separates it from the allowed-tools column.
      const panelStyle = {
        position: 'absolute',
        // Anchored by its left column: the original panel keeps the exact place it had
        // (`right: 0` with width 340), and the allowed-tools column grows to its right
        // instead of pushing the left column under the conversation sidebar.
        left: 'calc(100% - 340px)',
        bottom: 'calc(100% + 8px)',
        zIndex: 50,
        width: 'auto',
        padding: 0,
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        color: 'inherit',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        fontSize: '12px',
        display: 'flex',
        alignItems: 'stretch',
        overflow: 'hidden',
        // Last-resort guard for a short window: the popover may never grow past the viewport.
        // The left column scrolls on its own when this bites (see `panelColumnStyle`).
        maxHeight: 'calc(100vh - 96px)',
      }
      const panelColumnStyle = {
        width: '340px',
        padding: '12px',
        display: 'grid',
        // One column pinned to the column's own width: with the implicit `auto` track a vertical
        // scrollbar ate ~15px and the grid then overflowed sideways, which is what drew a
        // horizontal scrollbar along the bottom of the left column.
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: '8px',
        alignContent: 'start',
        boxSizing: 'border-box',
        // Only reachable under the `maxHeight` guard above, where the column is shorter than
        // its own grid content. Vertical only: the grid track above keeps the width in check.
        overflowY: 'auto',
        overflowX: 'hidden',
        // The divider is the original panel's own outline, kept as its right border.
        borderRight: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
      }
      const allowedColumnStyle = {
        width: '232px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: 0,
        boxSizing: 'border-box',
        // `contain: size` is the load-bearing part. The popover is a row flex box with an auto
        // height, so it sizes its cross axis from the children's intrinsic heights, and CSS
        // Flexbox §9.9.1 measures a column container's intrinsic main size from the children's
        // max-content contributions: neither `flex-basis: 0` nor `height: 0` stops fifty tool
        // rows from reporting ~1400px there. Size containment makes this column measure its
        // own height as 0 (padding only) during that pass, so the left column alone decides the
        // popover height; the stretch alignment then hands the column that exact height, and
        // the row stack inside scrolls.
        contain: 'size',
      }
      // The rows live in a card that mirrors the model dropdown: a search row on top and a
      // scrolling option list under it.
      //
      // The card grows into whatever height the stretched column is given and never reports a
      // content height of its own: `flex: 1 1 0px` (a definite basis, not a percentage, so it
      // cannot degrade to `content` while the column's height is still indefinite) plus the
      // size containment repeated here keep a fifty-tool catalog from stretching the popover.
      const allowedListBoxStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '6px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        flex: '1 1 0px',
        minHeight: 0,
        boxSizing: 'border-box',
        contain: 'size',
      }
      const allowedListStyle = {
        display: 'grid',
        // One column pinned to the box's own width: an implicit `auto` track would be sized
        // by the longest unbreakable tool name and scroll the list sideways.
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: '2px',
        alignContent: 'start',
        // Same reasoning one level down: a zero pixel basis keeps the row stack out of the
        // card's intrinsic height, and the rows scroll inside it instead.
        flex: '1 1 0px',
        minHeight: 0,
        overflowY: 'auto',
        paddingRight: '2px',
        contain: 'size',
      }
      // One row per tool: the checkbox leads, so a long tool name can never push it out of
      // the 232px column; the name then takes whatever width is left and ellipsises.
      const allowedRowStyle = (allowed) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: allowed ? 600 : 400,
        // The row is a grid item with an automatic minimum size, which long content would
        // otherwise widen past the column; zero lets the name truncate instead.
        minWidth: 0,
      })
      // The plugin header: a shade stronger than a tool row, so the grouping reads as a
      // heading while staying compact in a 232px column.
      const allowedGroupStyle = (on) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 6px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: 600,
        background: on
          ? 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, currentColor 10%, transparent))'
          : 'color-mix(in srgb, currentColor 5%, transparent)',
        minWidth: 0,
      })
      const allowedGroupNameStyle = {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11px',
        letterSpacing: '.02em',
        textTransform: 'uppercase',
      }
      const allowedNameStyle = {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const allowedCheckboxStyle = (editable) => ({
        flex: 'none',
        margin: 0,
        cursor: editable ? 'pointer' : 'default',
        accentColor: 'var(--dsw-alias-brand-primary, #4d8dff)',
      })
      const resetLinkStyle = (enabled) => ({
        border: 'none',
        background: 'transparent',
        color: enabled ? 'var(--dsw-alias-link, var(--dsw-alias-brand-primary, #4d8dff))' : 'var(--dsw-alias-label-tertiary, inherit)',
        font: 'inherit',
        fontSize: '11px',
        padding: 0,
        cursor: enabled ? 'pointer' : 'default',
        flex: 'none',
      })
      // The switch track: the host's own off-track token keeps the grey readable in both
      // themes; the on-colour is fixed so it reads the same in light and dark.
      const switchTrackStyle = (on, focused, disabled) => ({
        boxSizing: 'border-box',
        position: 'relative',
        display: 'block',
        width: '36px',
        height: '20px',
        padding: '2px',
        borderRadius: '999px',
        background: on
          ? '#C6FFD5'
          : 'var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 26%, transparent))',
        transition: 'background-color 160ms ease',
        boxShadow: focused ? '0 0 0 2px var(--dsw-alias-brand-primary, #4d8dff)' : 'none',
        opacity: disabled ? 0.5 : 1,
      })
      // A white knob with a hairline ring stays visible on the light-green track in the
      // light theme, where a bare white circle would otherwise nearly disappear.
      const switchKnobStyle = (on) => ({
        display: 'block',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0, 0, 0, .35), 0 0 0 1px rgba(0, 0, 0, .14)',
        transform: on ? 'translateX(16px)' : 'translateX(0)',
        transition: 'transform 160ms ease',
      })
      const selectStyle = {
        width: '100%',
        height: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        padding: '0 6px',
        colorScheme: 'light dark',
      }
      // The filter sits above the two rows; `colorScheme` keeps the native clear button theme-aware.
      const searchStyle = {
        flex: 1,
        minWidth: 0,
        height: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-fill-tertiary, color-mix(in srgb, currentColor 6%, transparent))',
        color: 'inherit',
        font: 'inherit',
        padding: '0 8px',
        boxSizing: 'border-box',
        colorScheme: 'light dark',
      }

      const modelButtonStyle = {
        width: '100%',
        minHeight: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        padding: '0 8px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        textAlign: 'left',
      }
      // The list hangs off the row button, so it paints above the effort select underneath.
      // Positioned fixed: the popover that hosts it clips its children (`overflow: hidden`),
      // so an absolutely positioned list would be cut off at the popover's edge. The
      // placement is measured per open; this is the fallback for a host without a layout.
      const dropdownStyle = {
        position: 'fixed',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        // Above the docked composer's own menus, so a list portalled to the body still paints
        // over the panel that owns the row.
        zIndex: 1100,
        maxHeight: '260px',
        overflowY: 'auto',
        padding: '6px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        display: 'grid',
        gap: '2px',
      }

      /**
       * Where the model list opens, and how tall it may be.
       *
       * The list hangs off a row button inside a popover that itself sits above the
       * composer, so "always below" runs past the bottom of the window and hides its last
       * options. Given the button's viewport rect, open downward while the preferred height
       * fits there, flip upward when that side has more room, and cap the height to the
       * space that is really available so the list scrolls instead of being clipped. A
       * `null` rect (no layout, as in a unit test) leaves the caller on its static style.
       */
      function popupPlacement(rect, viewportHeight, { gap = 4, margin = 8, preferred = 260, minimum = 80 } = {}) {
        const top = rect?.top
        const bottom = rect?.bottom
        if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(viewportHeight)) return null
        const below = viewportHeight - bottom - gap - margin
        const above = top - gap - margin
        const side = below >= preferred || below >= above ? 'down' : 'up'
        const room = side === 'down' ? below : above
        return {
          side,
          maxHeight: Math.max(Math.min(preferred, room), minimum),
          top: side === 'down' ? bottom + gap : 'auto',
          bottom: side === 'up' ? viewportHeight - top + gap : 'auto',
          left: rect.left,
          width: rect.width,
        }
      }

      /**
       * The popover opens upward from its trigger, so the room it really has is the space above
       * that trigger, not the whole window: capping it to `100vh` still let the top of the panel
       * hang outside the window when the composer sat low. `null` keeps the static style (a host
       * without layout, as in a unit test).
       */
      function panelStyleOf(room) {
        if (room === null || room === undefined) return panelStyle
        return Object.assign({}, panelStyle, { maxHeight: room + 'px' })
      }

      /**
       * The height the popover may use. It is bottom-anchored 8px above its trigger, so the room
       * is `trigger.top - 56` (8px gap + 48px of host top chrome): anything larger hangs under
       * the session header, which clips the panel's rounded top edge and the first rows of both
       * columns — the columns then scrolled to reveal what was already off screen.
       */
      function panelRoom(triggerTop, viewportHeight) {
        if (!Number.isFinite(triggerTop) || !Number.isFinite(viewportHeight)) return null
        return Math.max(Math.min(triggerTop - 56, viewportHeight - 96), 240)
      }

      /** The style for a measured placement, or the static fallback when there is none. */
      function dropdownStyleOf(placement) {
        if (placement === null) return dropdownStyle
        return Object.assign({}, dropdownStyle, {
          top: placement.top,
          bottom: placement.bottom,
          left: placement.left,
          right: 'auto',
          width: placement.width,
          maxHeight: placement.maxHeight + 'px',
        })
      }
      const filterRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        position: 'sticky',
        top: 0,
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        paddingBottom: '4px',
      }
      const groupStyle = {
        padding: '6px 8px 2px',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '11px',
        fontWeight: 600,
      }
      const optionStyle = (active, selected) => ({
        border: 'none',
        borderRadius: '6px',
        padding: '5px 8px',
        font: 'inherit',
        textAlign: 'left',
        color: 'inherit',
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: selected ? 600 : 400,
        background: selected
          ? 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, currentColor 12%, transparent))'
          : active
            ? 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent))'
            : 'transparent',
      })

      /** Re-render when a config scope changes, and return its current snapshot. */
      function useScope(scope) {
        const [, bump] = React.useReducer((n) => n + 1, 0)
        React.useEffect(() => scope.subscribe(() => bump()), [scope])
        return scope.getSnapshot()
      }

      /**
       * The subagent check interval. Edits stay local until blur or Enter; invalid input is
       * rejected without writing and the shown value snaps back to the stored one. The panel's
       * scope subscription keeps the field in step with a value changed anywhere else.
       */
      function SuperviseIntervalField({ scope, t }) {
        const snapshot = useScope(scope)
        const current = intervalOf(snapshot.value)
        const [draft, setDraft] = React.useState(String(current))
        const [hint, setHint] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const alive = React.useRef(true)
        const shown = React.useRef(current)
        const editable = snapshot.status === 'ready' && snapshot.writable === true

        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])
        // Follow the stored value when it changed somewhere else.
        React.useEffect(() => {
          if (shown.current === current) return
          shown.current = current
          setDraft(String(current))
        }, [current])
        // The warning is transient; a successful commit also clears it.
        React.useEffect(() => {
          if (hint === null || typeof setTimeout !== 'function') return undefined
          const timer = setTimeout(() => {
            if (alive.current) setHint(null)
          }, 4000)
          return () => clearTimeout(timer)
        }, [hint])

        const reject = (message) => {
          setHint(message)
          setDraft(String(current))
        }

        const commit = async () => {
          if (busy) return
          const parsed = parseInterval(draft)
          if (!parsed.ok) {
            reject(t('supervise.invalid'))
            return
          }
          // Same value: no mutate, just put the field back in its canonical form.
          if (parsed.seconds === current) {
            setDraft(String(current))
            setHint(null)
            return
          }
          if (!editable) {
            reject(t('supervise.readonly'))
            return
          }
          const live = scope.getSnapshot()
          setBusy(true)
          try {
            await scope.mutate([{ op: 'set', path: [INTERVAL.key], value: parsed.seconds }], live.revision)
            if (!alive.current) return
            if (intervalOf(scope.getSnapshot().value) === parsed.seconds) setHint(null)
            else reject(t('supervise.saveFailed'))
          } catch {
            // A remote failure may be a plain object; the panel only needs a short line.
            if (alive.current) reject(t('supervise.saveFailed'))
          } finally {
            if (alive.current) setBusy(false)
          }
        }

        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h(
            'label',
            { style: { display: 'grid', gap: '4px' } },
            h('span', { style: { fontWeight: 600 } }, t('supervise.label')),
            h('input', {
              // Plain text keeps non-numeric input observable: a number input sanitizes "abc"
              // to an empty value, which this field would then read as "use the default".
              type: 'text',
              inputMode: 'numeric',
              min: INTERVAL.min,
              max: INTERVAL.max,
              step: 1,
              value: draft,
              disabled: busy || !editable,
              'aria-label': t('supervise.label'),
              style: selectStyle,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => commit(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  return commit()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(String(current))
                  setHint(null)
                }
                return undefined
              },
            }),
          ),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.3 } }, t('supervise.hint')),
          hint === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, hint),
        )
      }

      /**
       * The subagent patrol notice count, plus the unlimited switch beside it. The count is
       * editable only while unlimited patrol is off; switching unlimited on locks the field
       * and keeps the patrol running until the child stops, delivers, or ends. Edits stay
       * local until blur or Enter, and invalid input is rejected without writing.
       */
      function SuperviseCountField({ scope, t }) {
        const snapshot = useScope(scope)
        const current = patrolCountOf(snapshot.value)
        const unlimited = unlimitedOf(snapshot.value)
        const [draft, setDraft] = React.useState(String(current))
        const [hint, setHint] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const alive = React.useRef(true)
        const shown = React.useRef(current)
        const editable = snapshot.status === 'ready' && snapshot.writable === true

        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])
        // Follow the stored value when it changed somewhere else.
        React.useEffect(() => {
          if (shown.current === current) return
          shown.current = current
          setDraft(String(current))
        }, [current])
        // The warning is transient; a successful commit also clears it.
        React.useEffect(() => {
          if (hint === null || typeof setTimeout !== 'function') return undefined
          const timer = setTimeout(() => {
            if (alive.current) setHint(null)
          }, 4000)
          return () => clearTimeout(timer)
        }, [hint])

        const reject = (message) => {
          setHint(message)
          setDraft(String(current))
        }

        const commit = async () => {
          if (busy) return
          const parsed = parsePatrolCount(draft)
          if (!parsed.ok) {
            reject(t('supervise.countInvalid'))
            return
          }
          // Same value: no mutate, just put the field back in its canonical form.
          if (parsed.count === current) {
            setDraft(String(current))
            setHint(null)
            return
          }
          if (!editable) {
            reject(t('supervise.readonly'))
            return
          }
          const live = scope.getSnapshot()
          setBusy(true)
          try {
            await scope.mutate([{ op: 'set', path: [PATROL_COUNT.key], value: parsed.count }], live.revision)
            if (!alive.current) return
            if (patrolCountOf(scope.getSnapshot().value) === parsed.count) setHint(null)
            else reject(t('supervise.saveFailed'))
          } catch {
            // A remote failure may be a plain object; the panel only needs a short line.
            if (alive.current) reject(t('supervise.saveFailed'))
          } finally {
            if (alive.current) setBusy(false)
          }
        }

        const toggleUnlimited = async (on) => {
          if (busy) return
          if (!editable) {
            setHint(t('supervise.readonly'))
            return
          }
          const live = scope.getSnapshot()
          setBusy(true)
          try {
            await scope.mutate([{ op: 'set', path: [PATROL_COUNT.unlimitedKey], value: on }], live.revision)
            if (!alive.current) return
            if (unlimitedOf(scope.getSnapshot().value) === on) {
              setHint(null)
              // Turning unlimited on discards an uncommitted draft: the field is locked now.
              if (on) setDraft(String(current))
            } else {
              setHint(t('supervise.saveFailed'))
            }
          } catch {
            if (alive.current) setHint(t('supervise.saveFailed'))
          } finally {
            if (alive.current) setBusy(false)
          }
        }

        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h('span', { style: { fontWeight: 600 } }, t('supervise.countLabel')),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('input', {
              // Plain text keeps non-numeric input observable: a number input sanitizes "abc"
              // to an empty value, which this field would then read as "use the default".
              type: 'text',
              inputMode: 'numeric',
              min: PATROL_COUNT.min,
              max: PATROL_COUNT.max,
              step: 1,
              value: draft,
              disabled: unlimited || busy || !editable,
              'aria-label': t('supervise.countLabel'),
              style: {
                ...selectStyle,
                flex: '1 1 auto',
                minWidth: 0,
                opacity: unlimited ? 0.5 : 1,
                cursor: unlimited ? 'not-allowed' : undefined,
              },
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => commit(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  return commit()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(String(current))
                  setHint(null)
                }
                return undefined
              },
            }),
            h(
              'div',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
              h(
                'span',
                { style: { whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary, inherit)' } },
                t('supervise.unlimitedLabel'),
              ),
              h(EnableSwitch, {
                checked: unlimited,
                disabled: busy || !editable,
                onChange: toggleUnlimited,
                label: t('supervise.unlimitedLabel'),
              }),
            ),
          ),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.3 } }, t('supervise.countHint')),
          hint === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, hint),
        )
      }

      /**
       * The dispatch switch. A real checkbox with role="switch" gives Space-to-toggle and
       * the platform focus semantics for free; Enter is handled explicitly because a native
       * checkbox ignores it. The track and knob are inline styles (this bundle ships no
       * stylesheet), so the focus ring is state-driven rather than a :focus-visible rule.
       */
      function EnableSwitch({ checked, disabled, onChange, label }) {
        const [focused, setFocused] = React.useState(false)
        return h(
          'label',
          {
            style: {
              position: 'relative',
              display: 'inline-flex',
              flex: '0 0 auto',
              alignItems: 'center',
              cursor: disabled ? 'default' : 'pointer',
            },
          },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            checked,
            disabled,
            style: {
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              margin: 0,
              opacity: 0,
              cursor: 'inherit',
            },
            onChange: (event) => onChange(event.target.checked),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return undefined
              event.preventDefault()
              if (!disabled) onChange(!checked)
              return undefined
            },
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
          }),
          h(
            'span',
            { 'aria-hidden': true, 'data-switch': checked ? 'on' : 'off', style: switchTrackStyle(checked, focused, disabled) },
            h('span', { style: switchKnobStyle(checked) }),
          ),
        )
      }

      /**
       * The right-hand column: one checkbox per tool the host offers, searched by name.
       * Whitelist-driven — checked means the main agent may use the tool, and everything
       * else, including a tool some plugin or MCP server registers later, is blocked for it.
       * Every change writes the single allow key from the checkbox state, so the stored
       * config always describes exactly what the panel shows.
       */
      function AllowedToolsPanel({ scope, t }) {
        const snapshot = useScope(scope)
        const [query, setQuery] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [problem, setProblem] = React.useState(null)
        const alive = React.useRef(true)
        // Writes run one after another, so a burst of clicks cannot interleave revisions.
        const pending = React.useRef(Promise.resolve())
        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        // Shipped order first, then the catalog/config extras alphabetically, so a row
        // keeps its place when the live catalog changes. The remembered copy survives the
        // instant a settings write resets the published field (see catalogFor).
        const remembered = React.useRef([])
        const live = catalogFor(snapshot.value, remembered.current)
        if (live.length > 0) remembered.current = live
        const names = toolListOf(snapshot.value, live)
        const allowed = allowedSetOf(snapshot.value)
        const visible = filterTools(names, query)
        const editable = snapshot.status === 'ready' && snapshot.writable === true

        /**
         * The set the boxes are drawn from: the stored whitelist with every click that has not
         * landed yet layered on top.
         *
         * The Host answers a checkbox in about a second (a settings write is a file-locked
         * atomic save, and the client re-reads every namespace afterwards), so drawing the
         * stored value alone made the box sit still until the round trip finished - the
         * reported one-second delay before it responds. The overlay flips the box on the click
         * and is dropped once the stored value agrees, so a refused write snaps back instead
         * of leaving a box that lies about the profile.
         */
        const [overlay, setOverlay] = React.useState(null)
        // Held in a ref as well: `write` is queued, and a closure over a stale render's
        // `overlay` would compute the next state from a set that already moved on.
        const overlayRef = React.useRef(null)
        const settle = (next) => {
          overlayRef.current = next
          if (alive.current) setOverlay(next)
        }
        // A stored value that now matches the overlay means the write landed (or the panel was
        // re-read from the Host): the optimistic copy has done its job and must not mask a
        // later change made anywhere else.
        React.useEffect(() => {
          const pendingOps = overlayRef.current
          if (pendingOps === null) return
          const agrees = pendingOps.size === allowed.size && [...pendingOps].every((name) => allowed.has(name))
          if (agrees) settle(null)
        }, [snapshot.value])
        const activeSet = overlay ?? allowed

        /**
         * Write one checkbox state.
         *
         * `saving` no longer blocks a second click. It used to, and because every write waits
         * for a full settings round trip (~1 s on a real host) a user clicking several boxes in
         * a row had every click but the first silently dropped — the "it takes a second to
         * respond" complaint. Each write now serializes on the previous one instead, and the
         * guard is the live revision, which is what actually protects the document.
         */
        const write = async (ops) => {
          const live = scope.getSnapshot()
          if (live.status !== 'ready' || live.writable !== true) {
            setProblem(t('route.readonly'))
            return
          }
          setSaving(true)
          setProblem(null)
          pending.current = pending.current.then(async () => {
            const latest = scope.getSnapshot()
            if (latest.status !== 'ready' || latest.writable !== true) return
            try {
              await scope.mutate(ops, latest.revision)
            } catch (reason) {
              if (!alive.current) return
              // A refused write must not leave the box showing a state the profile never took,
              // so the optimistic copy is dropped and the stored value shows through again.
              settle(null)
              // Not `instanceof Error`: a remote failure can be a plain { code, message } object.
              setProblem(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('route.saveFailed'))
            }
          })
          try {
            await pending.current
          } finally {
            if (alive.current) setSaving(false)
          }
        }

        /**
         * The allow set as of right now, not as of the last render.
         *
         * Two clicks issued within one round trip share the render that produced them. Building
         * each write from that render's `allowed` made the second overwrite the first, so a
         * fast user saw only one box move. The pending overlay carries the earlier click until
         * the Host answers, and the live document carries it afterwards, so a new delta always
         * starts from the newest state the panel knows about.
         */
        const currentAllowed = () => {
          if (overlayRef.current !== null) return new Set(overlayRef.current)
          const live = scope.getSnapshot()
          return live?.status === 'ready' ? allowedSetOf(live.value) : new Set(allowed)
        }

        /**
         * Apply one or many checkbox changes, optimistically.
         *
         * The box flips on the click instead of after the round trip. `allowOps` still encodes
         * the whole whitelist, so the stored document is exactly what the panel shows; the
         * overlay only decides what is drawn while that write is in flight.
         */
        const apply = (list, on) => {
          const next = currentAllowed()
          for (const name of list) {
            if (on) next.add(name)
            else next.delete(name)
          }
          settle(next)
          return write(allowOps(next))
        }

        const toggle = (name, on) => apply([name], on)

        /**
         * One plugin group at once. Checking the group header adds every tool the group
         * covers; unchecking it removes them. This is one write for the whole group, so a
         * forty-tool plugin costs the same round trip as a single box.
         */
        const toggleGroup = (tools, on) => apply(tools, on)

        /**
         * Draw the rows in list order, with one group header at each group's first member.
         *
         * The header toggles the whole plugin: checking it allows every tool that plugin
         * publishes, unchecking removes them all, in a single write. Its box is checked only
         * when the group is fully allowed and indeterminate when it is partly allowed, so the
         * column shows partial state without the user expanding anything.
         *
         * The header is inserted at the first member's position and the remaining members stay
         * where they already were, so grouping never reorders a row: the shipped whitelist
         * keeps its published order and a search result reads the same as before.
         */
        const renderRow = (name, current) =>
          h(
            'label',
            { key: name, style: allowedRowStyle(current.has(name)), 'data-tool': name },
            h('input', {
              type: 'checkbox',
              checked: current.has(name),
              disabled: saving || !editable,
              'aria-label': name,
              style: allowedCheckboxStyle(!saving && editable),
              onChange: (event) => toggle(name, event.target.checked),
            }),
            h('span', { style: allowedNameStyle, title: name }, name),
          )

        const renderGroupHeader = (group, current) => {
          const total = group.tools.length
          const checked = group.tools.filter((name) => current.has(name)).length
          const all = total > 0 && checked === total
          const some = checked > 0 && !all
          return h(
            'label',
            { key: 'group:' + group.key, style: allowedGroupStyle(all), 'data-plugin-toggle': group.key },
            h('input', {
              type: 'checkbox',
              checked: all,
              // A mixed group shows the indeterminate dash instead of looking off.
              ref: (node) => {
                if (node !== null && node !== undefined) node.indeterminate = some
              },
              disabled: saving || !editable,
              'aria-label': group.key,
              style: allowedCheckboxStyle(!saving && editable),
              onChange: (event) => toggleGroup(group.tools, event.target.checked),
            }),
            h('span', { style: allowedGroupNameStyle, title: group.key }, group.key),
            h(
              'span',
              { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none' } },
              checked + '/' + total,
            ),
          )
        }

        const renderGrouped = (list, current) => {
          const headAt = new Map()
          for (const group of groupTools(list, names)) headAt.set(group.tools[0], group)
          const out = []
          for (const name of list) {
            const head = headAt.get(name)
            if (head !== undefined) out.push(renderGroupHeader(head, current))
            out.push(renderRow(name, current))
          }
          return out
        }

        return h(
          'div',
          { style: allowedColumnStyle, 'data-panel': 'allowed-tools' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
            h('span', { style: { fontWeight: 600 }, title: t('allowed.hint') }, t('allowed.title')),
            h(
              'button',
              {
                type: 'button',
                style: resetLinkStyle(editable && !saving),
                disabled: saving || !editable,
                onClick: () => write(resetAllowOps()),
              },
              t('allowed.reset'),
            ),
          ),
          h(
            'div',
            { style: allowedListBoxStyle },
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('allowed.search'),
              'aria-label': t('allowed.search'),
              'data-search': 'allowed-tools',
              // `searchStyle` grows inside the dropdown's flex row; here it sits in a flex
              // column, so an explicit height keeps it a one-line box instead of stretching.
              style: Object.assign({}, searchStyle, { flex: 'none', height: '28px', width: '100%' }),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'div',
              { style: allowedListStyle, role: 'group', 'aria-label': t('allowed.title') },
              visible.length === 0
                ? h(
                    'div',
                    { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } },
                    t('allowed.empty'),
                  )
                : renderGrouped(visible, activeSet),
            ),
          ),
          problem === null ? null : h('div', { role: 'alert', style: { color: 'var(--dsw-alias-label-error, #ff7b72)' } }, problem),
        )
      }

      /** One row: the current model, and the searchable list that opens in place. */
      function RouteRow({ label, route, groups, disabled, onChange, t }) {
        const [open, setOpen] = React.useState(false)
        const [active, setActive] = React.useState(0)
        const [query, setQuery] = React.useState('')
        const [placement, setPlacement] = React.useState(null)
        const box = React.useRef(null)
        // Portalled to the body, the list is no longer a DOM descendant of `box`, so it needs a
        // ref of its own for the outside-click test and for scrolling itself.
        const listBox = React.useRef(null)
        const searchInput = React.useRef(null)
        const options = React.useRef(new Map())
        const model = findModel(groups, route)
        const known = model !== undefined
        const key = route.provider !== '' && route.model !== '' ? routeKey(route.provider, route.model) : ''
        const efforts = model?.reasoning?.efforts ?? []
        const visible = filterGroups(groups, query)
        const items = []
        if (!known && key !== '') items.push({ kind: 'unknown' })
        items.push({ kind: 'unset' })
        for (const group of visible) {
          items.push({ kind: 'group', group })
          for (const entry of group.models) items.push({ kind: 'model', provider: group.id, model: entry })
        }

        const dismiss = () => {
          setOpen(false)
          setActive(0)
        }
        const choose = (item) => {
          // A different model offers different efforts, so the stored effort is dropped.
          if (item.kind === 'unset') onChange({ provider: '', model: '', effort: '' })
          else if (item.kind === 'model') onChange({ provider: item.provider, model: item.model.id, effort: '' })
          dismiss()
        }
        // Group headers are plain text, so keyboard movement skips them.
        const move = (step) => {
          if (items.length === 0) return
          let next = active
          for (let hop = 0; hop < items.length; hop += 1) {
            next = (next + step + items.length) % items.length
            if (items[next].kind !== 'group') break
          }
          setActive(next)
        }

        React.useEffect(() => {
          setActive(0)
        }, [query])
        React.useEffect(() => {
          if (!open) return undefined
          const outside = (event) => {
            if (typeof box.current?.contains === 'function' && box.current.contains(event.target)) return
            // The list is portalled to the body, so a click inside it is outside `box` in the
            // DOM tree. Without this check the `pointerdown` capture would close the list
            // before the option's own `click` ever fired.
            if (typeof listBox.current?.contains === 'function' && listBox.current.contains(event.target)) return
            dismiss()
          }
          document.addEventListener('pointerdown', outside, true)
          return () => document.removeEventListener('pointerdown', outside, true)
        }, [open])
        // Anchor the list to the button and keep it inside the window: it opens upward when
        // there is more room above, and its height is capped to the room on that side so the
        // last option stays reachable by scrolling instead of being clipped by the popover.
        React.useEffect(() => {
          if (!open) {
            setPlacement(null)
            return undefined
          }
          const node = box.current
          const viewport = typeof window === 'undefined' ? undefined : window.innerHeight
          if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined
          const measure = () => {
            const next = popupPlacement(node.getBoundingClientRect(), viewport)
            if (next !== null) setPlacement(next)
          }
          measure()
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          window.addEventListener('resize', measure)
          window.addEventListener('scroll', measure, true)
          return () => {
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
          }
        }, [open])
        // Focus the filter without letting the browser scroll anything to reveal it: the docked
        // composer is a scroll container, and a plain `autoFocus` scrolls it to the field on the
        // first frame, which drags the whole panel up and to the left.
        React.useEffect(() => {
          if (!open) return
          const field = searchInput.current
          if (field !== null && field !== undefined && typeof field.focus === 'function') {
            field.focus({ preventScroll: true })
          }
        }, [open])
        // Keyboard movement can walk past the visible slice of a capped list. Only the list may
        // scroll itself: `scrollIntoView` also scrolls every ancestor scroll container, which
        // moves the composer's `scrollBody` / `viewArea` and clips the panel.
        React.useEffect(() => {
          if (!open) return
          const node = options.current.get(active)
          if (node === null || node === undefined) return
          const list = listBox.current
          const measurable =
            list !== null &&
            list !== undefined &&
            typeof list.scrollTop === 'number' &&
            typeof list.clientHeight === 'number' &&
            typeof node.offsetTop === 'number' &&
            typeof node.offsetHeight === 'number'
          if (measurable) {
            const top = node.offsetTop
            const bottom = top + node.offsetHeight
            if (top < list.scrollTop) list.scrollTop = top
            else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
            return
          }
          // A host without layout (a unit test stub) still gets the old nearest-edge behaviour.
          if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
        }, [open, active, query])
        const renderItem = (item, index) => {
          if (item.kind === 'group') {
            return h('div', { key: 'g:' + item.group.id, style: groupStyle }, item.group.name ?? item.group.id)
          }
          const isUnset = item.kind === 'unset'
          const isModel = item.kind === 'model'
          const itemKey = isUnset ? 'unset' : isModel ? routeKey(item.provider, item.model.id) : 'unknown'
          const selected = isUnset ? key === '' : isModel ? key === itemKey : true
          const text = isUnset ? t('route.unset') : isModel ? item.model.name ?? item.model.id : key
          return h(
            'button',
            {
              key: itemKey,
              ref: (node) => {
                if (node === null || node === undefined) options.current.delete(index)
                else options.current.set(index, node)
              },
              type: 'button',
              role: 'option',
              'aria-selected': selected,
              style: optionStyle(active === index, selected),
              onMouseEnter: () => setActive(index),
              onClick: () => choose(item),
            },
            text,
          )
        }
        // The host's composer ancestors declare `container-type` / `will-change: transform`, which
        // makes them the containing block of a `position: fixed` child: a list rendered in place
        // would be laid out from the composer's top-left corner instead of the viewport its
        // placement was measured against, and it would land far down and to the right. The body
        // has no such ancestor, so the measured rect applies as written.
        const listboxNode = open
          ? h(
              'div',
              {
                ref: listBox,
                style: dropdownStyleOf(placement),
                role: 'listbox',
                'aria-label': label + ' · ' + t('route.search'),
                'data-side': placement?.side,
              },
              h(
                'div',
                { style: filterRowStyle },
                h('input', {
                  type: 'search',
                  ref: searchInput,
                  value: query,
                  placeholder: t('route.search'),
                  'aria-label': t('route.search'),
                  style: searchStyle,
                  onChange: (event) => setQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      dismiss()
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      move(1)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      move(-1)
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      if (items[active] !== undefined && items[active].kind !== 'group') choose(items[active])
                    }
                  },
                }),
                h(
                  'span',
                  { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', whiteSpace: 'nowrap' } },
                  countModels(visible) + '/' + countModels(groups),
                ),
              ),
              items.length === 0
                ? h(
                    'div',
                    { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } },
                    t('route.noMatch') + ' · ' + t('route.noMatchHint'),
                  )
                : items.map(renderItem),
            )
          : null
        const canPortal =
          listboxNode !== null &&
          typeof ReactDOM?.createPortal === 'function' &&
          typeof document !== 'undefined' &&
          document.body !== undefined &&
          document.body !== null
        const listbox = canPortal ? ReactDOM.createPortal(listboxNode, document.body) : listboxNode
        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h('div', { style: { fontWeight: 600 } }, label),
          h(
            'div',
            { ref: box, style: { position: 'relative' } },
            h(
              'button',
              {
                type: 'button',
                style: modelButtonStyle,
                disabled,
                'aria-haspopup': 'listbox',
                'aria-expanded': open,
                'aria-label': label,
                onClick: () => (open ? dismiss() : setOpen(true)),
              },
              h(
                'span',
                { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                known
                  ? model.name ?? route.model
                  : route.model !== ''
                    ? route.model
                    : t('route.unset'),
              ),
              h(
                'span',
                { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none' } },
                open ? '▴' : '▾',
              ),
            ),
            listbox,
          ),
          efforts.length === 0
            ? null
            : h(
                'select',
                {
                  style: selectStyle,
                  value: route.effort,
                  disabled,
                  'aria-label': label + ' · ' + t('route.effort'),
                  onChange: (event) => onChange({ ...route, effort: event.target.value }),
                },
                h('option', { value: '' }, t('route.effortDefault')),
                efforts.map((e) => h('option', { key: e.id, value: e.id }, e.name ?? e.id)),
              ),
        )
      }
      /** Button plus panel: pick the default model and effort for the main agent and for workers. */
      function RoutePicker({ t, scopes, orch, loadCatalog, sessionId, setMode, mode, useProjection }) {
        const [open, setOpen] = React.useState(false)
        const [room, setRoom] = React.useState(null)
        const anchor = React.useRef(null)
        const [groups, setGroups] = React.useState(undefined)
        const [problem, setProblem] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        const main = useScope(scopes.main)
        const worker = useScope(scopes.worker)
        // The dispatch switch is the session's, so it is shown from the session's own mode —
        // never from the plugin's config form, which two conversations would share.
        const readMode = typeof mode === 'function' ? mode : null
        const sessionMode = readMode !== null && typeof useProjection === 'function' ? readMode(useProjection) : mode
        const enabled = sessionMode?.enabled === true

        React.useEffect(() => {
          if (!open || groups !== undefined) return undefined
          let live = true
          loadCatalog().then(
            (response) => {
              if (!live) return
              if (response.ok) setGroups(response.value.groups)
              else setProblem(t('route.catalogFailed'))
            },
            () => {
              if (live) setProblem(t('route.catalogFailed'))
            },
          )
          return () => {
            live = false
          }
        }, [open, groups])

        const write = async (which, route) => {
          setSaving(true)
          setProblem(null)
          const failure = await saveRoute(which === 'main' ? scopes.main : scopes.worker, which === 'main' ? MAIN.fields : WORKER.fields, route, t)
          setSaving(false)
          setProblem(failure)
        }

        // Dispatch mode is session state, not plugin config: the switch writes through the
        // command channel to the conversation it is shown in, so flipping it here cannot
        // change what another open conversation sends or which tools it may call.
        const toggleEnabled = async (on) => {
          if (typeof setMode !== 'function' || sessionId === undefined || sessionId === null) {
            setProblem(t('route.readonly'))
            return
          }
          setSaving(true)
          setProblem(null)
          const failure = await setMode(on)
          setSaving(false)
          setProblem(failure)
        }


        // The panel is anchored above the trigger and opens upward, so its real ceiling is the
        // space between the trigger and the top of the window (`panelStyle.maxHeight` alone only
        // knows the viewport, which is how a low composer used to push the panel off screen).
        React.useEffect(() => {
          if (!open) {
            setRoom(null)
            return undefined
          }
          const node = anchor.current
          if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined
          const measure = () => {
            const rect = node.getBoundingClientRect()
            const viewport = typeof window === 'undefined' ? undefined : window.innerHeight
            const next = panelRoom(rect?.top, viewport)
            if (next !== null) setRoom(next)
          }
          measure()
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }, [open])

        const writable = main.writable === true && worker.writable === true
        const close = () => {
          setOpen(false)
        }
        return h(
          'span',
          { ref: anchor, style: { position: 'relative', display: 'inline-flex' } },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, baseStyle, open ? onStyle : null),
              onClick: () => (open ? close() : setOpen(true)),
              title: t('route.title'),
              'aria-label': t('route.title'),
              'aria-expanded': open,
            },
            h('span', null, t('route.button')),
          ),
          open
            ? h(
                'div',
                { style: panelStyleOf(room), role: 'dialog', 'aria-label': t('route.title') },
                h(
                  'div',
                  { style: panelColumnStyle },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '0 0 6px' } },
                    h(
                      'div',
                      { style: { display: 'grid', gap: '2px', flex: '1 1 auto', minWidth: 0 } },
                      h('span', { style: { fontWeight: 600 } }, t('route.enable')),
                      h('span', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.3 } }, t('route.enableNote')),
                    ),
                    h(EnableSwitch, {
                      checked: enabled,
                      disabled: saving || typeof setMode !== 'function' || sessionId === undefined || sessionId === null,
                      onChange: toggleEnabled,
                      label: t('route.enable'),
                    }),
                  ),
                  groups === undefined && problem === null
                    ? h('div', null, t('route.loading'))
                    : groups === undefined
                      ? null
                      : [
                          h(RouteRow, {
                            key: 'main',
                            label: t('route.main'),
                            route: routeOf(MAIN.fields, main.value),
                            groups,
                            disabled: saving || !writable,
                            onChange: (route) => write('main', route),
                            t,
                          }),
                          h(RouteRow, {
                            key: 'worker',
                            label: t('route.worker'),
                            route: routeOf(WORKER.fields, worker.value),
                            groups,
                            disabled: saving || !writable,
                            onChange: (route) => write('worker', route),
                            t,
                          }),
                        ],
                  h(SuperviseIntervalField, { scope: scopes.orch, t }),
                  h(SuperviseCountField, { scope: scopes.orch, t }),
                  problem === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, problem),
                  !writable && groups !== undefined
                    ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('route.readonly'))
                    : null,
                  h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.3 } }, t('route.note')),
                ),
                h(AllowedToolsPanel, { scope: scopes.orch, t }),
              )
            : null,
        )
      }

      /** Service names, not package names: these are the `ctx.*` members used below. */
      const inject = ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'configForms']

      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'orchestrator: dictionaries')

        /**
         * Flip this conversation's dispatch mode. The command is addressed to one session, so
         * the write lands in that session's own log — the reason two open conversations no
         * longer affect each other.
         */
        const setModeFor = (sessionId) => async (on) => {
          if (sessionId === undefined || sessionId === null) return 'no session'
          const result = await ctx.remote.commands.execute(sessionId, '/' + MODE_COMMAND + (on ? ' on' : ' off'), [])
          if (!result.ok) return result.error.message + ' (' + result.error.code + ')'
          if (result.value === undefined) return 'unknown command: ' + MODE_COMMAND
          return null
        }

        // Same command channel the native plan chip uses to leave plan mode.
        const setPlanFor = (sessionId) => async (active) => {
          const command = active ? '/plan' : '/plan off'
          const result = await ctx.remote.commands.execute(sessionId, command, [])
          if (!result.ok) return result.error.message + ' (' + result.error.code + ')'
          if (result.value === undefined) return 'unknown command: ' + command
          return null
        }
        // `conversation.input.plan` is a single-occupant slot and the shipped plan package claims
        // it: a second registration makes that package's activation throw, which fails the whole
        // web boot. The toggle takes a seat in the left list slot instead, next to the plan chip.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'orchestrator-plan-toggle', order: 20, locale: NS },
            (props) => h(PlanToggle, Object.assign({}, props, { setPlan: setPlanFor(props.sessionId) })),
          ),
        )

        const scopes = { main: ctx.configForms.get(MAIN.ns), worker: ctx.configForms.get(WORKER.ns), orch: ctx.configForms.get(NS) }
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'orchestrator-route-picker',
              order: 11,
              locale: NS,
              inject: (sessionId) => ({
                scopes,
                orch: scopes.orch,
                sessionId,
                loadCatalog: () => ctx.remote.session.modelCatalog(),
                // The session's mode, read from its own projection so two open conversations
                // show two different switches. Absent means off, never "whatever B chose".
                mode: (useProjection) => useProjection(MODE_PROJECTION_KEY) ?? { enabled: false },
                setMode: setModeFor(sessionId),
              }),
            },
            RoutePicker,
          ),
        )
      }

      exports.apply = apply
      exports.inject = inject
      // Pure helpers, exposed so they can be tested without a browser.
      exports.__test = {
        MAIN,
        WORKER,
        INTERVAL,
        DEFAULT_ALLOWED_TOOLS,
        ALLOW_KEY,
        CATALOG_KEY,
        namesOf,
        catalogOf,
        catalogFor,
        toolListOf,
        pluginKeyOf,
        groupTools,
        popupPlacement,
        dropdownStyleOf,
        dropdownStyle,
        panelStyle,
        panelStyleOf,
        panelRoom,
        panelColumnStyle,
        allowedColumnStyle,
        allowedListBoxStyle,
        allowedListStyle,
        RouteRow,
        allowedSetOf,
        filterTools,
        allowOps,
        resetAllowOps,
        EnableSwitch,
        AllowedToolsPanel,
        RoutePicker,
        routeKey,
        parseRouteKey,
        routeOf,
        routeOps,
        findModel,
        filterGroups,
        countModels,
        saveRoute,
        intervalOf,
        parseInterval,
        SuperviseIntervalField,
        PATROL_COUNT,
        patrolCountOf,
        unlimitedOf,
        parsePatrolCount,
        SuperviseCountField,
      }
    })(module, module.exports, (id) => load(id))
    return module.exports
  },
})
