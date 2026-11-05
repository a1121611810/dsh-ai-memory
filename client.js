/**
 * dsh-ai-memory — Client half.
 *
 * A sidebar entry and its panel. The panel only reads: the Host half owns the
 * token and the connection, and exposes one route for this view.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = `
      .aim-panel { height: 100%; overflow: auto; padding: 22px 26px; color: var(--dsw-alias-label-primary); font: inherit; }
      .aim-head { display: flex; align-items: center; gap: 10px; }
      .aim-title { font-size: 16px; font-weight: 600; }
      .aim-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .aim-card { margin-top: 16px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
      .aim-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 5px 0; font-size: 13px; }
      .aim-key { color: var(--dsw-alias-label-secondary); }
      .aim-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; background: var(--dsw-alias-state-idle-primary); }
      .aim-dot.ok { background: var(--dsw-alias-state-success-primary); }
      .aim-dot.bad { background: var(--dsw-alias-state-error-primary); }
      .aim-list { list-style: none; margin: 6px 0 0; padding: 0; }
      .aim-item { padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .aim-item-title { font-size: 13px; }
      .aim-path { color: var(--dsw-alias-label-secondary); font-size: 11px; word-break: break-all; margin-top: 2px; }
      .aim-actions { display: flex; gap: 8px; margin-top: 16px; }
      .aim-btn { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
      .aim-btn:hover { background: var(--dsw-alias-bg-layer-2); }
      .aim-empty { color: var(--dsw-alias-label-secondary); font-size: 13px; margin-top: 10px; }
      .aim-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; margin-top: 12px; }
    `

    function Icon(props) {
      const size = typeof props.size === 'number' ? props.size : 20
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: props.active ? 1 : 0.82 },
      },
      h('rect', {
        x: 3.5, y: 3.5, width: 17, height: 17, rx: 4,
        stroke: 'currentColor', strokeWidth: props.active ? 1.9 : 1.5,
      }),
      h('path', {
        d: 'M8 9h8M8 12h8M8 15h5',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }))
    }

    const stat = (label, value) => h('div', { className: 'aim-row', key: label },
      h('span', { className: 'aim-key' }, label),
      h('span', null, value === null || value === undefined ? '—' : String(value)))

    function Panel() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const load = React.useCallback(() => {
        setState((current) => ({ ...current, phase: current.data ? 'refreshing' : 'loading' }))
        fetch('api/dsh-ai-memory/overview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then((response) => response.json())
          .then((data) => {
            if (data && data.ok === false) setState({ phase: 'error', error: data.error })
            else setState({ phase: 'ready', data })
          })
          .catch((error) => setState({ phase: 'error', error: String(error && error.message ? error.message : error) }))
      }, [])

      React.useEffect(() => { load() }, [load])

      const data = state.data
      const scope = data && data.scope
      const counts = data && data.counts
      const connected = Boolean(data) && data.server && data.server.status === 'ok'

      return h('div', { className: 'aim-panel' },
        h('style', null, CSS),
        h('div', { className: 'aim-head' },
          h('span', { className: 'aim-title' }, 'ai-memory'),
          h('span', { className: 'aim-sub' }, data && data.server ? data.server.url : '')),
        h('div', { className: 'aim-sub', style: { marginTop: 4 } },
          h('span', { className: connected ? 'aim-dot ok' : 'aim-dot' }),
          state.phase === 'loading' ? 'connecting…' : connected ? 'connected' : 'not reachable'),

        state.phase === 'error'
          ? h('div', { className: 'aim-error' }, state.error)
          : null,

        data && scope
          ? h('div', { className: 'aim-card' },
            stat('workspace', scope.workspace),
            stat('project', scope.project),
            stat('resolved by', scope.resolved_by))
          : null,

        counts
          ? h('div', { className: 'aim-card' },
            stat('pages', counts.pages_latest),
            stat('sessions', counts.sessions),
            stat('observations', counts.observations))
          : null,

        data && Array.isArray(data.recent) && data.recent.length > 0
          ? h('div', { className: 'aim-card' },
            h('div', { className: 'aim-key', style: { fontSize: 12 } }, 'recent pages'),
            h('ul', { className: 'aim-list' }, data.recent.map((page) =>
              h('li', { className: 'aim-item', key: page.path },
                h('div', { className: 'aim-item-title' }, page.title || page.path),
                h('div', { className: 'aim-path' }, page.path)))))
          : null,

        state.phase === 'ready' && data && data.recent && data.recent.length === 0
          ? h('div', { className: 'aim-empty' }, 'No pages yet — this project has no captured memory.')
          : null,

        h('div', { className: 'aim-actions' },
          h('button', { className: 'aim-btn', type: 'button', onClick: load }, 'Refresh')))
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
