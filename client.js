/**
 * dsh-ai-memory — Client half.
 *
 * A memory browser in the left rail: projects that hold pages, one project's
 * snapshot, and a search box that can reach across projects. The Host half owns
 * the token and exposes the two routes this view calls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = `
      .aim-root { height: 100%; display: flex; flex-direction: column; color: var(--dsw-alias-label-primary); font: inherit; }
      .aim-head { display: flex; align-items: baseline; gap: 10px; padding: 18px 22px 12px; }
      .aim-title { font-size: 16px; font-weight: 600; }
      .aim-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .aim-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; background: var(--dsw-alias-state-idle-primary); }
      .aim-dot.ok { background: var(--dsw-alias-state-success-primary); }
      .aim-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(180px, 240px) 1fr; gap: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
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
      .aim-badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .aim-badge.hot { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .aim-searchbar { display: flex; gap: 8px; margin: 6px 0 14px; align-items: center; }
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
      .aim-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; padding: 0 4px; margin-right: 6px; }
      .aim-empty { color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 12px 0; }
      .aim-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; }
      .aim-foot { padding: 10px 22px 14px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; gap: 8px; align-items: center; }
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

    const pageRow = (page) => h('li', { className: 'aim-item', key: page.path },
      h('div', { className: 'aim-item-t' },
        page.kind ? h('span', { className: 'aim-kind' }, page.kind) : null,
        page.title || page.path),
      page.snippet ? h('div', { className: 'aim-item-s' }, page.snippet) : null,
      h('div', { className: 'aim-path' }, page.project ? `${page.project} · ${page.path}` : page.path))

    function Panel() {
      const [selected, setSelected] = React.useState(null)
      const [data, setData] = React.useState({ phase: 'loading' })
      const [filter, setFilter] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [globalSearch, setGlobalSearch] = React.useState(false)
      const [results, setResults] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

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

      const payload = data.payload
      const brief = payload && payload.briefing
      const current = payload && payload.current
      const allProjects = (payload && payload.projects) || []
      const visible = allProjects.filter((entry) => filter === ''
        || entry.project.toLowerCase().includes(filter.toLowerCase()))
      const connected = Boolean(payload) && payload.server && payload.server.status === 'ok'
      const headline = selected
        ? selected.project
        : (brief && brief.scope ? brief.scope.project : (current ? current.project : '—'))

      const projectRow = (label, count, active, onClick, key) => h('button', {
        className: 'aim-proj' + (active ? ' on' : ''),
        key,
        type: 'button',
        onClick,
      },
      h('span', { className: 'aim-proj-name' }, label),
      h('span', { className: 'aim-proj-n' }, count))

      const headEl = h('div', { className: 'aim-head' },
        h('span', { className: 'aim-title' }, 'ai-memory'),
        h('span', { className: 'aim-sub' }, payload && payload.server ? payload.server.url : ''),
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
          ? projectRow(`当前会话 · ${current.project}`,
            brief && brief.counts ? String(brief.counts.pages_latest) : '',
            selected === null, () => pick(null), 'current')
          : null,
        visible.map((entry) => projectRow(
          entry.workspace === 'default' ? entry.project : `${entry.workspace}/${entry.project}`,
          String(entry.pages),
          Boolean(selected) && selected.project === entry.project,
          () => pick({ workspace: entry.workspace, project: entry.project }),
          `${entry.workspace}/${entry.project}`)))

      const metaText = brief && brief.scope
        ? `${brief.scope.workspace} · resolved by ${brief.scope.resolved_by}${brief.lastObservationAt ? ` · last activity ${when(brief.lastObservationAt)}` : ''}`
        : ' '

      const badges = h('div', { className: 'aim-badges' },
        brief && brief.handoffs > 0 ? h('span', { className: 'aim-badge hot' }, `${brief.handoffs} open handoff`) : null,
        brief && brief.messages > 0 ? h('span', { className: 'aim-badge hot' }, `${brief.messages} message`) : null,
        brief && brief.rules && brief.rules.length > 0 ? h('span', { className: 'aim-badge' }, `${brief.rules.length} rules`) : null,
        h('span', { className: 'aim-badge' }, `${allProjects.length} projects with pages`))

      const searchBar = h('div', { className: 'aim-searchbar' },
        h('input', {
          className: 'aim-input',
          placeholder: '搜这个项目…（Enter）',
          value: query,
          onChange: (event) => {
            setQuery(event.target.value)
            if (event.target.value === '') setResults(null)
          },
          onKeyDown: (event) => { if (event.key === 'Enter') runSearch() },
        }),
        h('label', { className: 'aim-check' },
          h('input', { type: 'checkbox', checked: globalSearch, onChange: (event) => setGlobalSearch(event.target.checked) }),
          '全局'),
        h('button', { className: 'aim-btn', type: 'button', onClick: runSearch, disabled: busy }, 'Search'))

      const rows = results === null
        ? (brief && brief.recent ? brief.recent : [])
        : results
      const emptyText = results === null
        ? '这个项目还没有页面。'
        : '没有匹配。试试勾上「全局」。'

      const listEl = h('ul', { className: 'aim-list' },
        rows.length > 0
          ? rows.map(pageRow)
          : h('li', { className: 'aim-empty' }, emptyText))

      const mainEl = h('div', { className: 'aim-main' },
        data.phase === 'error' ? h('div', { className: 'aim-error' }, data.error) : null,
        h('div', { className: 'aim-sec' },
          h('div', { className: 'aim-h2' }, headline),
          h('div', { className: 'aim-meta' }, metaText),
          h('div', { className: 'aim-grid' },
            cell(brief && brief.counts ? brief.counts.pages_latest : 0, 'pages'),
            cell(brief && brief.counts ? brief.counts.sessions : 0, 'sessions'),
            cell(brief && brief.counts ? brief.counts.observations : 0, 'observations'),
            cell(brief && brief.activity7d ? brief.activity7d.pages_updated : 0, 'pages / 7d'))),
        badges,
        searchBar,
        listEl)

      const bodyEl = h('div', { className: 'aim-body' }, sideEl, mainEl)

      const footEl = h('div', { className: 'aim-foot' },
        h('button', { className: 'aim-btn', type: 'button', onClick: () => load(selected), disabled: busy },
          busy ? 'Loading…' : 'Refresh'),
        h('span', { className: 'aim-sub' }, results === null ? 'recent pages' : `${results.length} results`))

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
