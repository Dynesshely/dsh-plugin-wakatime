/**
 * dsh-plugin-wakatime —— Client 半边（纯 JS，无构建）。
 *
 * 职责只有两件事：
 *
 * 1. 在左侧导航 `sidebar.panellist` 里注册一个「使用时间 / Usage」入口（order 21，与
 *    「插件 / 自动化任务 / 上下文洞察」并列），图标是自绘的线性秒表 + 提示符。
 * 2. 在中间面板 `main` 里用 key `wakatime-usage` 注册对应页面。页面只读一个 HTTP 接口：
 *    `GET /wakatime/usage.json`（由 Host 侧的 `ctx.webServer` 提供，`Cache-Control: no-store`），
 *    数据契约见 docs/design.md 的「v0.2」一节。
 *
 * 不引入任何构建步骤、不 import 任何 DSH Client 包：React 从浏览器的模块表取，
 * 其余全部是标准 Web API。颜色一律走 `--dsw-alias-*` 主题令牌，深浅色自适应；
 * 文案一律走 Client locale（命名空间 `dsh-wakatime`），中英双语。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-wakatime',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale 命名空间，`ctx.locale.register` 与注册项里的 `locale` 都用它。 */
    const NS = 'dsh-wakatime'
    /** Host 侧只读接口。 */
    const ENDPOINT = '/wakatime/usage.json'
    /** 柱状图最多显示的列数。 */
    const CHART_DAYS = 7

    // ------------------------------------------------------------------ locale

    const zh = {
      'meta.lang': 'zh',
      'panel.title': '使用时间',

      'page.subtitle': '本地使用时长统计与 WakaTime 上报状态',
      'page.refresh': '刷新',
      'page.refreshing': '刷新中…',
      'page.loading': '正在读取使用统计…',
      'page.error': '读取使用统计失败',
      'page.retry': '重试',
      'page.generatedAt': '数据生成于 {time}',

      'today.title': '今日 AI 编程时长',
      'today.heartbeats': '今日心跳 {n} 次',
      'today.sessions': '会话 {n} 个',

      'metric.inputTokens': '今日输入 token',
      'metric.outputTokens': '今日输出 token',
      'metric.promptChars': '今日键入字符',
      'metric.sessions': '今日会话数',
      'metric.week': '本周时长',
      'metric.total': '累计时长',

      'chart.title': '最近 7 天',
      'chart.hint': '柱高按最忙的一天归一',
      'chart.empty': '最近 7 天没有记录',
      'chart.today': '今天',
      'chart.total': '合计 {duration}',

      'projects.title': '项目 Top 5',
      'projects.empty': '还没有项目记录',
      'projects.seconds': '{duration}',

      'wakatime.title': 'WakaTime',
      'wakatime.keyMissing': '未配置 API key，心跳不会上报',
      'wakatime.keyMissingHint': '在 ~/.wakatime.cfg 的 [settings] 中填写 api_key，或在插件设置里填写 apiKey。',
      'wakatime.hostname': '机器名',
      'wakatime.remoteToday': '远程今日 AI Coding',
      'wakatime.remoteHeartbeats': '{n} 次心跳',
      'wakatime.remoteError': '远程查询失败：{error}',
      'wakatime.remoteUnavailable': '未启用远程查询',
      'wakatime.queue': '待发队列',
      'wakatime.queueUnit': '{n} 条',
      'wakatime.lastSent': '最近发送',
      'wakatime.lastError': '最近错误',
      'wakatime.none': '无',
      'wakatime.never': '从未',
      'wakatime.disabled': '上报已暂停：{reason}',

      'status.reporting': '上报中',
      'status.disabled': '插件已停用',
      'status.noKey': '未配置 key',

      'plugin.minInterval': '心跳间隔 {n} 秒',
      'plugin.idleTimeout': '空闲 {n} 分钟停表',

      'duration.ltMin': '<1 分钟',
    }

    const en = {
      'meta.lang': 'en',
      'panel.title': 'Usage',

      'page.subtitle': 'Local usage time and WakaTime reporting status',
      'page.refresh': 'Refresh',
      'page.refreshing': 'Refreshing…',
      'page.loading': 'Reading usage statistics…',
      'page.error': 'Could not load usage data',
      'page.retry': 'Retry',
      'page.generatedAt': 'Generated {time}',

      'today.title': 'AI coding time today',
      'today.heartbeats': '{n} heartbeats today',
      'today.sessions': '{n} sessions',

      'metric.inputTokens': 'Input tokens today',
      'metric.outputTokens': 'Output tokens today',
      'metric.promptChars': 'Typed characters today',
      'metric.sessions': 'Sessions today',
      'metric.week': 'This week',
      'metric.total': 'All time',

      'chart.title': 'Last 7 days',
      'chart.hint': 'Bar height is relative to the busiest day',
      'chart.empty': 'No activity in the last 7 days',
      'chart.today': 'today',
      'chart.total': 'Total {duration}',

      'projects.title': 'Top 5 projects',
      'projects.empty': 'No projects tracked yet',
      'projects.seconds': '{duration}',

      'wakatime.title': 'WakaTime',
      'wakatime.keyMissing': 'No API key configured — heartbeats are not reported',
      'wakatime.keyMissingHint': 'Add api_key under [settings] in ~/.wakatime.cfg, or set apiKey in the plugin settings.',
      'wakatime.hostname': 'Hostname',
      'wakatime.remoteToday': 'Remote AI coding today',
      'wakatime.remoteHeartbeats': '{n} heartbeats',
      'wakatime.remoteError': 'Remote query failed: {error}',
      'wakatime.remoteUnavailable': 'Remote query disabled',
      'wakatime.queue': 'Pending queue',
      'wakatime.queueUnit': '{n} items',
      'wakatime.lastSent': 'Last sent',
      'wakatime.lastError': 'Last error',
      'wakatime.none': 'none',
      'wakatime.never': 'never',
      'wakatime.disabled': 'Reporting paused: {reason}',

      'status.reporting': 'Reporting',
      'status.disabled': 'Plugin disabled',
      'status.noKey': 'No key',

      'plugin.minInterval': 'min gap {n}s',
      'plugin.idleTimeout': 'idle {n}m',

      'duration.ltMin': '<1 min',
    }

    // ------------------------------------------------------------------ formatting

    /**
     * 极简占位符替换。Client locale 的 `t` 只保证返回字符串，这里自己替换 `{name}`，
     * 不依赖 `t` 是否支持参数。
     * @param {string} template 词典里的模板。
     * @param {Record<string, string | number>} params 替换值。
     * @returns {string}
     */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => {
        const value = params[key]
        return value === undefined ? whole : String(value)
      })
    }

    /**
     * 秒 → 人类可读时长。
     *
     * zh：`2 小时 34 分`（整小时不带「0 分」）、不足 1 分钟为 `<1 分钟`；
     * en：`2h 34m`、不足 1 分钟为 `<1 min`。
     * @param {number} seconds 秒数。
     * @param {'zh' | 'en'} lang 语言。
     * @param {(key: string) => string} t 语言绑定后的翻译函数。
     * @returns {string}
     */
    function formatDuration(seconds, lang, t) {
      const total = Number(seconds)
      if (!Number.isFinite(total) || total <= 0) return lang === 'zh' ? '0 分钟' : '0m'
      if (total < 60) return t('duration.ltMin')
      const minutes = Math.round(total / 60)
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      if (lang === 'zh') {
        if (hours > 0) return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
        return `${rest} 分钟`
      }
      if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
      return `${rest}m`
    }

    /**
     * 计数缩写：`999`、`1.2k`、`120k`、`1.4M`。
     * @param {unknown} input 原始计数。
     * @returns {string}
     */
    function formatCount(input) {
      const value = Number(input)
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
      if (value < 1000000) return `${Math.round(value / 1000)}k`
      return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`
    }

    /** @returns 两位十进制补零。 */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /**
     * 毫秒 epoch → `MM-DD HH:mm`（本地时区），非法值返回传入的兜底文案。
     * @param {unknown} input 时间戳。
     * @param {string} fallback 无效值时的占位。
     * @returns {string}
     */
    function formatDateTime(input, fallback) {
      const value = Number(input)
      if (!Number.isFinite(value) || value <= 0) return fallback
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return fallback
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /**
     * `YYYY-MM-DD` → `M/D`；不用 `new Date(string)`，避免被当成 UTC 而错位一天。
     * @param {unknown} input 日期字符串。
     * @returns {string}
     */
    function formatDayLabel(input) {
      if (typeof input !== 'string') return ''
      const parts = input.split('-')
      if (parts.length < 3) return input
      const month = Number(parts[1])
      const day = Number(parts[2])
      if (!Number.isFinite(month) || !Number.isFinite(day)) return input
      return `${month}/${day}`
    }

    /** @returns 有限非负数，否则 0。 */
    function toNumber(input) {
      const value = Number(input)
      return Number.isFinite(value) && value > 0 ? value : 0
    }

    /** @returns 非空字符串，否则 undefined。 */
    function toText(input) {
      if (typeof input !== 'string') return undefined
      const trimmed = input.trim()
      return trimmed === '' ? undefined : trimmed
    }

    // ------------------------------------------------------------------ styles

    const PAGE_STYLE = {
      boxSizing: 'border-box',
      height: '100%',
      overflowY: 'auto',
      padding: '20px 24px 32px',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      lineHeight: '20px',
    }

    const CONTAINER_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      maxWidth: '1040px',
      margin: '0 auto',
      minWidth: 0,
    }

    const CARD_STYLE = {
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '12px',
      padding: '14px 16px',
      minWidth: 0,
      boxSizing: 'border-box',
    }

    const SUBTEXT_STYLE = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '18px',
    }

    const CAPTION_STYLE = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11.5px',
      lineHeight: '17px',
    }

    const NUMBER_STYLE = {
      fontVariantNumeric: 'tabular-nums',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    }

    const CHIP_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      height: '20px',
      padding: '0 8px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
      lineHeight: '18px',
      whiteSpace: 'nowrap',
    }

    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      height: '30px',
      padding: '0 13px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const BUTTON_DISABLED_STYLE = {
      ...BUTTON_STYLE,
      cursor: 'default',
      opacity: 0.55,
    }

    const BUTTON_ACCENT_STYLE = {
      ...BUTTON_STYLE,
      border: '1px solid var(--dsw-alias-brand-primary)',
      color: 'var(--dsw-alias-brand-primary)',
    }

    // ------------------------------------------------------------------ icon

    /**
     * 侧边栏图标：线性秒表 + 终端提示符 `>`，32×32 网格，随 `active` 换色。
     * @param {{ size?: number, active?: boolean }} props 由 `sidebar.panellist` 提供。
     * @returns {unknown} SVG 元素。
     */
    function UsageIcon({ size, active }) {
      const dimension = typeof size === 'number' && size > 0 ? size : 18
      const color = active === true
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-label-secondary)'
      return h('svg', {
        viewBox: '0 0 32 32',
        width: dimension,
        height: dimension,
        fill: 'none',
        stroke: color,
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }, [
        // 表冠与表柄
        h('path', { key: 'stem', d: 'M16 9.6V5.4' }),
        h('path', { key: 'crown', d: 'M12.9 5.4h6.2' }),
        // 右侧计时按钮
        h('path', { key: 'button', d: 'M23.2 12.6l2.1-2.1' }),
        // 表盘
        h('circle', { key: 'face', cx: 16, cy: 19, r: 9.4 }),
        // 盘内提示符 `>` 与光标
        h('path', { key: 'prompt', d: 'M12.6 18.4l3 2.6-3 2.6' }),
        h('path', { key: 'cursor', d: 'M18.2 23.6h3.6' }),
      ])
    }

    // ------------------------------------------------------------------ page parts

    /**
     * 一个「标签 + 数值」的小格子。
     * @param {{ label: string, value: string, hint?: string }} props 展示内容。
     * @returns {unknown}
     */
    function StatCell({ label, value, hint }) {
      return h('div', {
        style: {
          ...CARD_STYLE,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        },
      }, [
        h('div', { key: 'label', style: CAPTION_STYLE }, label),
        h('div', { key: 'value', style: { ...NUMBER_STYLE, fontSize: '19px', lineHeight: '26px' } }, value),
        hint === undefined ? null : h('div', { key: 'hint', style: CAPTION_STYLE }, hint),
      ])
    }

    /**
     * 最近 7 天柱状图（内联 SVG，柱高按最大值归一，今天用品牌色）。
     * @param {{ days: unknown, todayDate: unknown, t: Function, lang: string }} props 数据与翻译。
     * @returns {unknown}
     */
    function UsageChart({ days, todayDate, t, lang }) {
      const list = Array.isArray(days) ? days.slice(-CHART_DAYS) : []
      if (list.length === 0) {
        return h('div', { style: { ...SUBTEXT_STYLE, padding: '18px 0' } }, t('chart.empty'))
      }

      const values = list.map((day) => toNumber(day?.seconds))
      const maxValue = Math.max(...values, 1)
      const width = 700
      const height = 148
      const top = 10
      const baseline = 106
      const usable = baseline - top
      const column = width / list.length
      const barWidth = Math.min(46, column * 0.5)
      const today = typeof todayDate === 'string' ? todayDate : undefined
      const total = values.reduce((sum, value) => sum + value, 0)

      const bars = list.map((day, index) => {
        const date = typeof day?.date === 'string' ? day.date : ''
        const seconds = values[index]
        const isToday = today !== undefined && date === today
        const barHeight = seconds > 0 ? Math.max(3, (seconds / maxValue) * usable) : 2
        const x = index * column + (column - barWidth) / 2
        const y = baseline - barHeight
        return h('g', { key: date === '' ? String(index) : date }, [
          h('rect', {
            key: 'bar',
            x,
            y,
            width: barWidth,
            height: barHeight,
            rx: 4,
            fill: isToday ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            fillOpacity: isToday ? 0.95 : 0.26,
          }, h('title', { key: 'tip' }, `${date} · ${formatDuration(seconds, lang, t)}`)),
          h('text', {
            key: 'label',
            x: index * column + column / 2,
            y: 126,
            textAnchor: 'middle',
            fill: isToday ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            fontSize: 11,
            fontWeight: isToday ? 600 : 400,
          }, formatDayLabel(date)),
          isToday
            ? h('text', {
              key: 'today',
              x: index * column + column / 2,
              y: 141,
              textAnchor: 'middle',
              fill: 'var(--dsw-alias-brand-primary)',
              fontSize: 10,
            }, t('chart.today'))
            : null,
        ])
      })

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } }, [
        h('svg', {
          key: 'chart',
          viewBox: `0 0 ${width} ${height}`,
          role: 'img',
          'aria-label': t('chart.title'),
          style: { display: 'block', width: '100%', height: 'auto', overflow: 'visible' },
        }, [
          h('line', {
            key: 'axis',
            x1: 0,
            y1: baseline,
            x2: width,
            y2: baseline,
            stroke: 'var(--dsw-alias-border-l1)',
            strokeWidth: 1,
          }),
          ...bars,
        ]),
        h('div', {
          key: 'legend',
          style: { ...CAPTION_STYLE, display: 'flex', justifyContent: 'space-between', gap: '8px' },
        }, [
          h('span', { key: 'hint' }, t('chart.hint')),
          h('span', {
            key: 'total',
            style: { fontVariantNumeric: 'tabular-nums' },
          }, fill(t('chart.total'), { duration: formatDuration(total, lang, t) })),
        ]),
      ])
    }

    /**
     * 项目 Top 5：名称 + 时长 + 按最大值归一的横向比例条。
     * @param {{ projects: unknown, t: Function, lang: string }} props 数据与翻译。
     * @returns {unknown}
     */
    function ProjectList({ projects, t, lang }) {
      const list = (Array.isArray(projects) ? projects : []).slice(0, 5)
      if (list.length === 0) {
        return h('div', { style: { ...SUBTEXT_STYLE, padding: '10px 0' } }, t('projects.empty'))
      }
      const values = list.map((project) => toNumber(project?.seconds))
      const maxValue = Math.max(...values, 1)
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '10px' },
      }, list.map((project, index) => {
        const name = toText(project?.name) ?? '—'
        const seconds = values[index]
        const ratio = seconds > 0 ? Math.max(0.02, seconds / maxValue) : 0
        return h('div', {
          key: `${name}-${index}`,
          style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 },
        }, [
          h('div', {
            key: 'row',
            style: { display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 },
          }, [
            h('div', {
              key: 'name',
              title: name,
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '12.5px',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, name),
            h('div', {
              key: 'value',
              style: { ...NUMBER_STYLE, flex: 'none', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
            }, formatDuration(seconds, lang, t)),
          ]),
          h('div', {
            key: 'track',
            style: {
              height: '6px',
              borderRadius: '3px',
              background: 'var(--dsw-alias-bg-layer-2)',
              overflow: 'hidden',
            },
          }, h('div', {
            style: {
              width: `${(ratio * 100).toFixed(1)}%`,
              height: '100%',
              borderRadius: '3px',
              background: 'var(--dsw-alias-brand-primary)',
              opacity: 0.75,
            },
          })),
        ])
      }))
    }

    /**
     * WakaTime 区块：key 状态、机器名、远程今日 AI Coding 时长、队列、最近发送与错误。
     * @param {{ wakatime: unknown, t: Function, lang: string }} props 数据与翻译。
     * @returns {unknown}
     */
    function WakaTimeSection({ wakatime, t, lang }) {
      const info = wakatime !== null && typeof wakatime === 'object' ? wakatime : {}
      const keyConfigured = info.apiKeyConfigured === true
      const remote = info.today !== null && typeof info.today === 'object' ? info.today : {}
      const remoteError = toText(remote.error)
      const disabledReason = toText(info.disabledReason)
      const hostname = toText(info.hostname)
      const lastError = toText(info.lastError)
      const queueSize = toNumber(info.queueSize)
      const lastSent = formatDateTime(info.lastSentAt, t('wakatime.never'))
      const remoteSeconds = toNumber(remote.categorySeconds)
      const remoteHeartbeats = toNumber(remote.heartbeats)

      const rows = [
        { key: 'hostname', label: t('wakatime.hostname'), value: hostname ?? '—' },
        {
          key: 'remote',
          label: t('wakatime.remoteToday'),
          value: remoteError === undefined
            ? formatDuration(remoteSeconds, lang, t)
            : fill(t('wakatime.remoteError'), { error: remoteError }),
          valueColor: remoteError === undefined ? undefined : 'var(--dsw-alias-state-error-primary)',
          hint: remoteError === undefined && remoteHeartbeats > 0
            ? fill(t('wakatime.remoteHeartbeats'), { n: remoteHeartbeats })
            : undefined,
        },
        {
          key: 'queue',
          label: t('wakatime.queue'),
          value: fill(t('wakatime.queueUnit'), { n: queueSize }),
          valueColor: queueSize > 0 ? 'var(--dsw-alias-state-warn-primary)' : undefined,
        },
        { key: 'lastSent', label: t('wakatime.lastSent'), value: lastSent },
        {
          key: 'lastError',
          label: t('wakatime.lastError'),
          value: lastError ?? t('wakatime.none'),
          valueColor: lastError === undefined ? undefined : 'var(--dsw-alias-state-error-primary)',
        },
      ]

      const statusText = keyConfigured ? t('status.reporting') : t('status.noKey')
      const statusColor = keyConfigured
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-error-primary)'

      const children = [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' },
        }, [
          h('div', {
            key: 'dot',
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              flex: 'none',
              background: statusColor,
            },
          }),
          h('div', {
            key: 'title',
            style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
          }, t('wakatime.title')),
          h('div', { key: 'status', style: { ...CAPTION_STYLE, color: statusColor } }, statusText),
        ]),
      ]

      if (!keyConfigured) {
        children.push(h('div', {
          key: 'missing',
          style: {
            marginBottom: '10px',
            padding: '9px 11px',
            borderRadius: '8px',
            border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)',
            background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
          },
        }, [
          h('div', {
            key: 'title',
            style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12.5px', fontWeight: 600 },
          }, t('wakatime.keyMissing')),
          h('div', { key: 'hint', style: { ...CAPTION_STYLE, color: 'var(--dsw-alias-label-secondary)' } }, t('wakatime.keyMissingHint')),
        ]))
      }

      if (disabledReason !== undefined) {
        children.push(h('div', {
          key: 'disabled',
          style: {
            marginBottom: '10px',
            padding: '7px 11px',
            borderRadius: '8px',
            border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)',
            background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)',
            color: 'var(--dsw-alias-state-warn-primary)',
            fontSize: '12px',
          },
        }, fill(t('wakatime.disabled'), { reason: disabledReason })))
      }

      children.push(h('div', {
        key: 'grid',
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '10px 16px',
        },
      }, rows.map((row) => h('div', {
        key: row.key,
        style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
      }, [
        h('div', { key: 'label', style: CAPTION_STYLE }, row.label),
        h('div', {
          key: 'value',
          title: row.value,
          style: {
            fontSize: '13px',
            lineHeight: '20px',
            color: row.valueColor ?? 'var(--dsw-alias-label-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, row.value),
        row.hint === undefined ? null : h('div', { key: 'hint', style: CAPTION_STYLE }, row.hint),
      ]))))

      return h('section', { style: CARD_STYLE }, children)
    }

    /** 加载骨架：三块占位，避免在慢请求下页面空白。 */
    function LoadingSkeleton({ t }) {
      const block = (key, height) => h('div', {
        key,
        style: {
          height,
          borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          opacity: 0.7,
        },
      })
      return h('div', {
        'aria-busy': true,
        style: { display: 'flex', flexDirection: 'column', gap: '12px' },
      }, [
        h('div', { key: 'text', style: SUBTEXT_STYLE }, t('page.loading')),
        block('a', '112px'),
        block('b', '92px'),
        block('c', '168px'),
      ])
    }

    /**
     * 「使用时间」页面。
     *
     * 数据只来自 `GET /wakatime/usage.json`；每次刷新都重新发请求并显式 `cache: 'no-store'`，
     * 与 Host 响应的 `Cache-Control: no-store` 一起保证不会读到旧数据。
     * @param {{ t: (key: string) => string }} props 语言绑定后的翻译函数。
     * @returns {unknown}
     */
    function UsagePage({ t }) {
      const [status, setStatus] = React.useState('loading')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const requestId = React.useRef(0)

      const load = React.useCallback((mode) => {
        requestId.current += 1
        const id = requestId.current
        if (mode === 'initial') setStatus('loading')
        else setRefreshing(true)
        return fetch(ENDPOINT, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        }).then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`)
          }
          return response.json()
        }).then((payload) => {
          if (id !== requestId.current) return
          setData(payload)
          setError(null)
          setStatus('ready')
        }, (cause) => {
          if (id !== requestId.current) return
          setError(cause instanceof Error ? cause.message : String(cause))
          setStatus('error')
        }).then(() => {
          if (id === requestId.current) setRefreshing(false)
        })
      }, [])

      React.useEffect(() => {
        void load('initial')
      }, [load])

      const lang = t('meta.lang') === 'zh' ? 'zh' : 'en'
      const plugin = data !== null && typeof data === 'object' && data.plugin !== null && typeof data.plugin === 'object'
        ? data.plugin
        : {}
      const local = data !== null && typeof data === 'object' && data.local !== null && typeof data.local === 'object'
        ? data.local
        : {}
      const today = local.today !== null && typeof local.today === 'object' ? local.today : {}
      const pluginTitle = t('panel.title')

      const header = h('header', {
        key: 'header',
        style: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
      }, [
        h('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 220px', minWidth: 0 } }, [
          h('div', { key: 'title', style: { fontSize: '18px', lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, pluginTitle),
          h('div', { key: 'subtitle', style: SUBTEXT_STYLE }, t('page.subtitle')),
          h('div', { key: 'meta', style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' } }, [
            toText(plugin.version) === undefined
              ? null
              : h('span', { key: 'version', style: CHIP_STYLE }, `v${toText(plugin.version)}`),
            toText(plugin.category) === undefined
              ? null
              : h('span', { key: 'category', style: CHIP_STYLE }, toText(plugin.category)),
            plugin.enabled === false
              ? h('span', {
                key: 'enabled',
                style: { ...CHIP_STYLE, color: 'var(--dsw-alias-state-warn-primary)' },
              }, t('status.disabled'))
              : null,
            toNumber(plugin.minIntervalSeconds) === 0
              ? null
              : h('span', { key: 'min', style: CHIP_STYLE }, fill(t('plugin.minInterval'), { n: toNumber(plugin.minIntervalSeconds) })),
            toNumber(plugin.idleTimeoutMinutes) === 0
              ? null
              : h('span', { key: 'idle', style: CHIP_STYLE }, fill(t('plugin.idleTimeout'), { n: toNumber(plugin.idleTimeoutMinutes) })),
          ]),
        ]),
        h('button', {
          key: 'refresh',
          type: 'button',
          disabled: refreshing,
          'aria-label': t('page.refresh'),
          onClick: () => {
            void load('refresh')
          },
          style: refreshing ? BUTTON_DISABLED_STYLE : BUTTON_STYLE,
        }, [
          h('svg', {
            key: 'icon',
            viewBox: '0 0 16 16',
            width: 14,
            height: 14,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block' },
          }, [
            h('path', { key: 'arc', d: 'M13.4 6.4A5.6 5.6 0 1 0 13.7 9' }),
            h('path', { key: 'tip', d: 'M13.4 2.8v3.6H9.8' }),
          ]),
          h('span', { key: 'label' }, refreshing ? t('page.refreshing') : t('page.refresh')),
        ]),
      ])

      let body
      if (status === 'loading') {
        body = h(LoadingSkeleton, { key: 'skeleton', t })
      } else if (status === 'error') {
        body = h('div', {
          key: 'error',
          style: {
            ...CARD_STYLE,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            alignItems: 'flex-start',
          },
        }, [
          h('div', { key: 'title', style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' } }, t('page.error')),
          h('div', {
            key: 'detail',
            style: {
              ...CAPTION_STYLE,
              color: 'var(--dsw-alias-label-secondary)',
              fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
              wordBreak: 'break-word',
              maxWidth: '100%',
            },
          }, error ?? ''),
          h('button', {
            key: 'retry',
            type: 'button',
            style: BUTTON_ACCENT_STYLE,
            onClick: () => {
              void load('initial')
            },
          }, t('page.retry')),
        ])
      } else {
        const days = Array.isArray(local.days) ? local.days : []
        const projects = Array.isArray(local.projects) ? local.projects : []
        const todaySeconds = toNumber(today.seconds)
        const todayHeartbeats = toNumber(today.heartbeats)
        const todaySessions = toNumber(today.sessions)
        const generatedAt = formatDateTime(data?.generatedAt, '—')

        body = h(React.Fragment, { key: 'ready' }, [
          h('section', { key: 'today', style: { ...CARD_STYLE, padding: '16px 18px' } }, [
            h('div', {
              key: 'head',
              style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
            }, [
              h('div', { key: 'label', style: { ...CAPTION_STYLE, fontSize: '12px' } }, t('today.title')),
              h('div', { key: 'chips', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
                h('span', { key: 'heartbeats', style: CHIP_STYLE }, fill(t('today.heartbeats'), { n: todayHeartbeats })),
                h('span', { key: 'sessions', style: CHIP_STYLE }, fill(t('today.sessions'), { n: todaySessions })),
              ]),
            ]),
            h('div', {
              key: 'big',
              style: {
                ...NUMBER_STYLE,
                fontSize: '34px',
                lineHeight: '44px',
                letterSpacing: '-0.01em',
                color: 'var(--dsw-alias-brand-primary)',
                margin: '2px 0 4px',
              },
            }, formatDuration(todaySeconds, lang, t)),
            h('div', {
              key: 'secondary',
              style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' },
            }, [
              h('div', { key: 'week', style: { display: 'flex', flexDirection: 'column', gap: '1px' } }, [
                h('div', { key: 'label', style: CAPTION_STYLE }, t('metric.week')),
                h('div', { key: 'value', style: { ...NUMBER_STYLE, fontSize: '15px', lineHeight: '22px' } }, formatDuration(toNumber(local.weekSeconds), lang, t)),
              ]),
              h('div', { key: 'total', style: { display: 'flex', flexDirection: 'column', gap: '1px' } }, [
                h('div', { key: 'label', style: CAPTION_STYLE }, t('metric.total')),
                h('div', { key: 'value', style: { ...NUMBER_STYLE, fontSize: '15px', lineHeight: '22px' } }, formatDuration(toNumber(local.totalSeconds), lang, t)),
              ]),
            ]),
          ]),

          h('div', {
            key: 'stats',
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
          }, [
            h(StatCell, { key: 'in', label: t('metric.inputTokens'), value: formatCount(today.inputTokens) }),
            h(StatCell, { key: 'out', label: t('metric.outputTokens'), value: formatCount(today.outputTokens) }),
            h(StatCell, { key: 'chars', label: t('metric.promptChars'), value: formatCount(today.promptChars) }),
            h(StatCell, { key: 'sessions', label: t('metric.sessions'), value: formatCount(todaySessions) }),
          ]),

          h('div', {
            key: 'middle',
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px', alignItems: 'start' },
          }, [
            h('section', { key: 'chart', style: { ...CARD_STYLE, display: 'flex', flexDirection: 'column', gap: '8px' } }, [
              h('div', { key: 'title', style: { fontSize: '13px', fontWeight: 600 } }, t('chart.title')),
              h(UsageChart, { key: 'svg', days, todayDate: today.date, t, lang }),
            ]),
            h('section', { key: 'projects', style: { ...CARD_STYLE, display: 'flex', flexDirection: 'column', gap: '10px' } }, [
              h('div', { key: 'title', style: { fontSize: '13px', fontWeight: 600 } }, t('projects.title')),
              h(ProjectList, { key: 'list', projects, t, lang }),
            ]),
          ]),

          h(WakaTimeSection, { key: 'wakatime', wakatime: data?.wakatime, t, lang }),

          h('div', {
            key: 'footer',
            style: { ...CAPTION_STYLE, display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
          }, [
            h('span', { key: 'generated' }, fill(t('page.generatedAt'), { time: generatedAt })),
            toNumber(local.sessionsTracked) > 0
              ? h('span', { key: 'tracked', style: { fontVariantNumeric: 'tabular-nums' } }, fill(t('today.sessions'), { n: toNumber(local.sessionsTracked) }))
              : null,
          ]),
        ])
      }

      return h('div', { style: PAGE_STYLE }, [
        h('div', { key: 'container', style: CONTAINER_STYLE }, [header, body]),
      ])
    }

    // ------------------------------------------------------------------ plugin

    /**
     * 装配：词典、导航入口、中间面板。
     * @param {any} ctx Client 插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-wakatime: dictionaries')
      const t = ctx.locale.bind(NS)

      /** `main` 面板组件：把语言绑定注入页面，避免页面自己拿 ctx。 */
      const UsagePanel = () => h(UsagePage, { t })
      /** `sidebar.panellist` 图标组件。 */
      const UsagePanelIcon = (props) => h(UsageIcon, {
        size: typeof props?.size === 'number' ? props.size : undefined,
        active: props?.active === true,
      })

      // 两处注册互相独立：任意一处失败都不该拖垮另一处，也不该让插件整体报错。
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'wakatime-usage',
          locale: NS,
        }, UsagePanel))
      } catch (error) {
        console.warn('dsh-wakatime: main panel registration failed', error)
      }

      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'wakatime-usage',
          order: 21,
          locale: NS,
          label: () => t('panel.title'),
        }, UsagePanelIcon))
      } catch (error) {
        console.warn('dsh-wakatime: sidebar entry registration failed', error)
      }
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
