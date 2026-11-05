import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * Smoke test for the browser half: it must register a sidebar entry and a main
 * panel, and render without throwing. React is stubbed; the real one comes from
 * the host module table at runtime.
 */
function createReactStub() {
  const hooks = { stateCalls: 0, effectCalls: 0 }
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      hooks.stateCalls += 1
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(fn) {
      hooks.effectCalls += 1
      return undefined
    },
  }
  return { react, hooks }
}

let factoryPromise
async function loadClient() {
  if (factoryPromise === undefined) {
    factoryPromise = (async () => {
      let factory
      globalThis.window = {
        __ModuleLoader__: { load: ({ id, factory: loaded }) => { factory = loaded; return id } },
      }
      await import('../client.js')
      assert.equal(typeof factory, 'function')
      return factory
    })()
  }
  const factory = await factoryPromise
  const { react } = createReactStub()
  return factory(() => react)
}

test('client module registers the sidebar entry and its main panel', async () => {
  const module = await loadClient()
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }

  assert.deepEqual(module.inject, ['slots'])
  module.apply(ctx)

  assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])
  const panel = registered.find((entry) => entry.options.name === 'main')
  assert.equal(panel.options.key, 'ai-memory')
  const icon = registered.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(icon.options.id, 'ai-memory')
  assert.equal(typeof icon.options.label, 'string')
})

test('both components render without throwing', async () => {
  const module = await loadClient()
  const registered = []
  module.apply({
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => { registered.push({ options, component }) },
    },
  })

  const icon = registered.find((entry) => entry.options.name === 'sidebar.panellist').component
  const svg = icon({ size: 18, active: true })
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, 18)

  const panel = registered.find((entry) => entry.options.name === 'main').component
  const tree = panel()
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'aim-panel')
  const serialized = JSON.stringify(tree)
  assert.match(serialized, /ai-memory/)
  assert.match(serialized, /Refresh/)
})
