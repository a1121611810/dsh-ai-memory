/**
 * dsh-ai-memory — Client half.
 *
 * A memory browser in the left rail: projects that hold pages, one project's
 * snapshot with its agent breakdown, search that can reach across projects, and
 * the plugin's own settings. The Host half owns the token and every route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = `
      .aim-root { height: 100%; display: flex; flex-direction: column; color: var(--dsw-alias-label-primary); font: inherit; }
      .aim-head { display: flex; align-items: center; gap: 10px; padding: 16px 22px 10px; }
      .aim-title { font-size: 16px; font-weight: 600; }
      .aim-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .aim-tabs { display: flex; gap: 4px; margin-left: 14px; }
      .aim-tab { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
        border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
      .aim-tab:hover { background: var(--dsw-alias-bg-layer-2); }
      .aim-tab.on { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .aim-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; background: var(--dsw-alias-state-idle-primary); }
      .aim-dot.ok { background: var(--dsw-alias-state-success-primary); }
      .aim-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(180px, 240px) 1fr; border-top: 1px solid var(--dsw-alias-border-l1); }
      .aim-side { min-height: 0; overflow: auto; padding: 12px; border-right: 1px solid var(--dsw-alias-border-l1); }
      .aim-main { min-height: 0; overflow: auto; padding: 16px 22px 24px; }
      .aim-input { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 6px 9px; border-radius: 8px; color: inherit;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .aim-proj { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%; text-align: left;
        font: inherit; font-size: 13px; color: inherit; background: transparent; border: 0; border-radius: 8px; padding: 7px 9px; cursor: pointer; }
      .aim-proj:hover { background: var(--dsw-alias-bg-layer-2); }
      .aim-proj.on { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
      .aim-proj-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .aim-proj-n { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: none; }
      .aim-sec { margin-bottom: 18px; }
      .aim-h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; word-break: break-all; }
      .aim-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-bottom: 12px; }
      .aim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
      .aim-cell { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; }
      .aim-cell-n { font-size: 18px; font-weight: 600; line-height: 1.2; }
      .aim-cell-k { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 2px; }
      .aim-badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 4px; }
      .aim-badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
      .aim-badge.hot { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .aim-badge.agent { color: var(--dsw-alias-label-primary); }
      .aim-searchbar { display: flex; gap: 8px; margin: 14px 0; align-items: center; }
      .aim-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .aim-btn { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer; white-space: nowrap;
        border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
      .aim-btn:hover { background: var(--dsw-alias-bg-layer-2); }
      .aim-btn:disabled { opacity: .5; cursor: default; }
      .aim-list { list-style: none; margin: 0; padding: 0; }
      .aim-item { padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .aim-item:first-child { border-top: 0; }
      .aim-item-t { font-size: 13px; }
      .aim-item-s { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }
      .aim-path { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 3px; word-break: break-all; }
      .aim-kind, .aim-agent { font-size: 10px; letter-spacing: .04em; border-radius: 5px; padding: 0 4px; margin-right: 6px; }
      .aim-kind { text-transform: uppercase; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
      .aim-agent { color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-brand-primary); }
      .aim-empty { color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 12px 0; }
      .aim-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; }
      .aim-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
      .aim-foot { padding: 10px 22px 14px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; gap: 8px; align-items: center; }
      .aim-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; }
      .aim-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
      .aim-field span { color: var(--dsw-alias-label-secondary); }
      .aim-field input[type=text], .aim-field input[type=number] { font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 7px;
        color: inherit; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
    `

    function Icon(props) {
      const size = typeof props.size === 'number' ? props.size : 20
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true,
        style: { display: 'block', opacity: props.active ? 1 : 0.82 },
      },
      h('rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4, stroke: 'currentColor', strokeWidth: props.active ? 1.9 : 1.5 }),
      h('path', { d: 'M8 9h8M8 12h8M8 15h5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    }

    const api = (path, body) => fetch(`api/dsh-ai-memory/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((response) => response.json())

    function when(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const diff = (Date.now() - date.getTime()) / 1000
      if (diff < 90) return 'just now'
      if (diff < 3600) return `${Math.round(diff / 60)}m ago`
      if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
      return `${Math.round(diff / 86400)}d ago`
    }

    const cell = (value, label) => h('div', { className: 'aim-cell', key: label },
      h('div', { className: 'aim-cell-n' }, String(value ?? '0')),
      h('div', { className: 'aim-cell-k' }, label))

    const row = (page, agent) => h('li', { className: 'aim-item', key: `${page.project ?? ''}/${page.path}` },
      h('div', { className: 'aim-item-t' },
        page.kind ? h('span', { className: 'aim-kind' }, page.kind) : null,
        agent ? h('span', { className: 'aim-agent' }, agent) : null,
        page.title || page.path),
      page.snippet ? h('div', { className: 'aim-item-s' }, page.snippet) : null,
      h('div', { className: 'aim-path' }, page.project ? `${page.project} · ${page.path}` : page.path))

    const field = (label, value, onChange, type) => h('label', { className: 'aim-field', key: label },
      h('span', null, label),
      h('input', {
        type: type ?? 'text',
        value: value ?? '',
        onChange: (event) => onChange(type === 'number' ? Number(event.target.value) : event.target.value),
      }))

    const toggle = (label, value, onChange) => h('label', { className: 'aim-check', key: label },
      h('input', { type: 'checkbox', checked: value === true, onChange: (event) => onChange(event.target.checked) }),
      label)

    function Browse(props) {
      const p = props.payload
      const brief = p && p.briefing
      const pageAgents = (p && p.pageAgents) || {}
      const agents = (p && p.agents) || []
      const rows = props.results === null ? (brief && brief.recent ? brief.recent : []) : props.results
      const empty = props.results === null ? '这个项目还没有页面。' : '没有匹配。试试勾上「全局」。'

      return h(React.Fragment, null,
        h('div', { className: 'aim-sec' },
          h('div', { className: 'aim-h2' }, props.headline),
          h('div', { className: 'aim-meta' }, props.meta),
          h('div', { className: 'aim-grid' },
            cell(brief && brief.counts ? brief.counts.pages_latest : 0, 'pages'),
            cell(brief && brief.counts ? brief.counts.sessions : 0, 'sessions'),
            cell(brief && brief.counts ? brief.counts.observations : 0, 'observations'),
            cell(brief && brief.activity7d ? brief.activity7d.pages_updated : 0, 'pages / 7d'))),
        h('div', { className: 'aim-badges' },
          brief && brief.handoffs > 0 ? h('span', { className: 'aim-badge hot' }, `${brief.handoffs} open handoff`) : null,
          brief && brief.messages > 0 ? h('span', { className: 'aim-badge hot' }, `${brief.messages} message`) : null,
          brief && brief.rules && brief.rules.length > 0 ? h('span', { className: 'aim-badge' }, `${brief.rules.length} rules`) : null,
          agents.map((entry) => h('span', { className: 'aim-badge agent', key: entry.agent },
            `${entry.agent} · ${entry.sessions}`)),
          h('span', { className: 'aim-badge' }, `${props.projectCount} projects with pages`)),
        h('div', { className: 'aim-searchbar' },
          h('input', {
            className: 'aim-input',
            placeholder: '搜这个项目…（Enter）',
            value: props.query,
            onChange: (event) => {
              props.setQuery(event.target.value)
              if (event.target.value === '') props.setResults(null)
            },
            onKeyDown: (event) => { if (event.key === 'Enter') props.onSearch() },
          }),
          h('label', { className: 'aim-check' },
            h('input', { type: 'checkbox', checked: props.globalSearch, onChange: (event) => props.setGlobal(event.target.checked) }),
            '全局'),
          h('button', { className: 'aim-btn', type: 'button', onClick: props.onSearch, disabled: props.busy }, 'Search')),
        h('ul', { className: 'aim-list' },
          rows.length > 0
            ? rows.map((page) => row(page, pageAgents[page.path] ?? page.agent ?? null))
            : h('li', { className: 'aim-empty' }, empty)))
    }

    function Settings(props) {
      const s = props.settings
      if (!s) return h('div', { className: 'aim-empty' }, 'Loading settings…')
      if (s.ok === false) return h('div', { className: 'aim-error' }, s.error)
      const form = props.form
      const set = (key, value) => props.setForm({ ...form, [key]: value })
      const facts = (props.payload && props.payload.server) || {}
      const ingest = facts.ingest || {}
      const providers = facts.providers || {}

      const serverCard = h('div', { className: 'aim-sec' },
        h('div', { className: 'aim-h2' }, 'ai-memory 服务'),
        h('div', { className: 'aim-meta' }, '只读。改服务端配置需要编辑 config.toml 并重启服务。'),
        h('div', { className: 'aim-grid' },
          cell(facts.version ?? '—', 'version'),
          cell(providers.llm ?? '—', 'llm'),
          cell(providers.embedding ?? '—', 'embedding'),
          cell(ingest.dropped ?? 0, 'dropped events')),
        h('div', { className: 'aim-path', style: { marginTop: '10px' } }, facts.bind ?? ''),
        h('div', { className: 'aim-path' }, facts.dataDir ?? ''))

      const pluginCard = h('div', { className: 'aim-sec' },
        h('div', { className: 'aim-h2' }, '插件设置'),
        h('div', { className: 'aim-meta' },
          s.editable ? '保存后插件会重启一次以应用新配置。' : '当前 profile 不允许写配置，只能查看。'),
        h('div', { className: 'aim-form' },
          field('serverUrl', form.serverUrl, (v) => set('serverUrl', v)),
          field('agent', form.agent, (v) => set('agent', v)),
          field('timeoutMs', form.timeoutMs, (v) => set('timeoutMs', v), 'number'),
          field('maxPromptChars', form.maxPromptChars, (v) => set('maxPromptChars', v), 'number'),
          field('maxToolChars', form.maxToolChars, (v) => set('maxToolChars', v), 'number')),
        h('div', { className: 'aim-badges' },
          toggle('captureSession', form.captureSession, (v) => set('captureSession', v)),
          toggle('capturePrompt', form.capturePrompt, (v) => set('capturePrompt', v)),
          toggle('captureTools', form.captureTools, (v) => set('captureTools', v)),
          toggle('captureStop', form.captureStop, (v) => set('captureStop', v)),
          toggle('announceScope', form.announceScope, (v) => set('announceScope', v))),
        h('div', { className: 'aim-searchbar' },
          h('button', { className: 'aim-btn', type: 'button', onClick: props.onSave, disabled: !s.editable || props.busy },
            props.busy ? 'Saving…' : 'Save'),
          props.message ? h('span', { className: props.message.ok ? 'aim-ok' : 'aim-error' }, props.message.text) : null))

      return h(React.Fragment, null, pluginCard, serverCard)
    }

    function Panel() {
      const [tab, setTab] = React.useState('browse')
      const [selected, setSelected] = React.useState(null)
      const [data, setData] = React.useState({ phase: 'loading' })
      const [filter, setFilter] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [globalSearch, setGlobalSearch] = React.useState(false)
      const [results, setResults] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [settings, setSettings] = React.useState(null)
      const [form, setForm] = React.useState({})
      const [message, setMessage] = React.useState(null)

      const load = React.useCallback((scope) => {
        setBusy(true)
        api('overview', scope ? { workspace: scope.workspace, project: scope.project } : {})
          .then((payload) => {
            if (payload && payload.ok === false) setData({ phase: 'error', error: payload.error })
            else setData({ phase: 'ready', payload })
          })
          .catch((error) => setData({ phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => setBusy(false))
      }, [])

      React.useEffect(() => { load(null) }, [load])

      React.useEffect(() => {
        if (tab !== 'settings' || settings !== null) return
        api('settings', {}).then((payload) => {
          setSettings(payload)
          if (payload && payload.config) setForm(payload.config)
        }).catch((error) => setSettings({ ok: false, error: String(error?.message ?? error) }))
      }, [tab, settings])

      const pick = (scope) => {
        setSelected(scope)
        setResults(null)
        setQuery('')
        load(scope)
      }

      const runSearch = () => {
        const text = query.trim()
        if (text === '') { setResults(null); return }
        setBusy(true)
        api('search', {
          q: text,
          global: globalSearch,
          ...(selected ? { workspace: selected.workspace, project: selected.project } : {}),
        })
          .then((payload) => setResults(payload && payload.ok === false ? [] : payload.hits ?? []))
          .catch(() => setResults([]))
          .finally(() => setBusy(false))
      }

      const save = () => {
        setBusy(true)
        setMessage(null)
        api('settings', { patch: form })
          .then((payload) => {
            setMessage(payload && payload.ok
              ? { ok: true, text: '已保存，插件正在重启' }
              : { ok: false, text: String(payload && payload.error ? payload.error : '保存失败') })
          })
          .catch((error) => setMessage({ ok: false, text: String(error?.message ?? error) }))
          .finally(() => setBusy(false))
      }

      const payload = data.payload
      const current = payload && payload.current
      const brief = payload && payload.briefing
      const allProjects = (payload && payload.projects) || []
      const visible = allProjects.filter((entry) => filter === ''
        || entry.project.toLowerCase().includes(filter.toLowerCase()))
      const connected = Boolean(payload) && payload.server && payload.server.status === 'ok'
      const headline = selected
        ? selected.project
        : (brief && brief.scope ? brief.scope.project : (current ? current.project : '—'))
      const meta = brief && brief.scope
        ? `${brief.scope.workspace} · resolved by ${brief.scope.resolved_by}${brief.lastObservationAt ? ` · last activity ${when(brief.lastObservationAt)}` : ''}`
        : ' '

      const headEl = h('div', { className: 'aim-head' },
        h('span', { className: 'aim-title' }, 'ai-memory'),
        h('span', { className: 'aim-sub' }, payload && payload.server ? payload.server.url : ''),
        h('div', { className: 'aim-tabs' },
          h('button', { className: 'aim-tab' + (tab === 'browse' ? ' on' : ''), type: 'button', onClick: () => setTab('browse') }, '浏览'),
          h('button', { className: 'aim-tab' + (tab === 'settings' ? ' on' : ''), type: 'button', onClick: () => setTab('settings') }, '设置')),
        h('span', { className: 'aim-sub', style: { marginLeft: 'auto' } },
          h('span', { className: connected ? 'aim-dot ok' : 'aim-dot' }),
          connected ? 'connected' : 'not reachable'))

      const sideEl = h('div', { className: 'aim-side' },
        h('input', {
          className: 'aim-input',
          placeholder: '找项目…',
          value: filter,
          onChange: (event) => setFilter(event.target.value),
          style: { marginBottom: '8px' },
        }),
        current
          ? h('button', {
            className: 'aim-proj' + (selected === null ? ' on' : ''),
            type: 'button',
            onClick: () => pick(null),
          },
          h('span', { className: 'aim-proj-name' }, `当前会话 · ${current.project}`),
          h('span', { className: 'aim-proj-n' }, brief && brief.counts ? String(brief.counts.pages_latest) : ''))
          : null,
        visible.map((entry) => h('button', {
          className: 'aim-proj' + (selected && selected.project === entry.project ? ' on' : ''),
          key: `${entry.workspace}/${entry.project}`,
          type: 'button',
          onClick: () => pick({ workspace: entry.workspace, project: entry.project }),
        },
        h('span', { className: 'aim-proj-name' }, entry.workspace === 'default' ? entry.project : `${entry.workspace}/${entry.project}`),
        h('span', { className: 'aim-proj-n' }, String(entry.pages)))))

      const mainEl = h('div', { className: 'aim-main' },
        data.phase === 'error' ? h('div', { className: 'aim-error' }, data.error) : null,
        tab === 'browse'
          ? h(Browse, {
            payload,
            headline,
            meta,
            query,
            setQuery,
            globalSearch,
            setGlobal: setGlobalSearch,
            results,
            setResults,
            busy,
            onSearch: runSearch,
            projectCount: allProjects.length,
          })
          : h(Settings, {
            payload,
            settings,
            form,
            setForm,
            busy,
            message,
            onSave: save,
          }))

      const bodyEl = tab === 'browse'
        ? h('div', { className: 'aim-body' }, sideEl, mainEl)
        : h('div', { className: 'aim-body', style: { gridTemplateColumns: '1fr' } }, mainEl)

      const footEl = h('div', { className: 'aim-foot' },
        h('button', {
          className: 'aim-btn',
          type: 'button',
          onClick: () => (tab === 'browse' ? load(selected) : (setSettings(null), setMessage(null))),
          disabled: busy,
        }, busy ? 'Loading…' : 'Refresh'),
        h('span', { className: 'aim-sub' },
          tab === 'browse'
            ? (results === null ? 'recent pages' : `${results.length} results`)
            : 'settings'))

      return h('div', { className: 'aim-root' }, h('style', null, CSS), headEl, bodyEl, footEl)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ai-memory' }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'ai-memory',
          order: 40,
          label: 'ai-memory',
        }, Icon))
      },
    }
  },
})
