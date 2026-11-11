// Exercise the Client half of dsh-provider-status without a browser: a stub
// module loader, React, document and MutationObserver drive the real bundle.
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`ok   ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

// --- stubs ------------------------------------------------------------------
const elements = []
function makeElement(tag) {
  const element = {
    tag,
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    children: [],
    removed: false,
    appendChild(child) {
      child.parent = element
      element.children.push(child)
      return child
    },
    remove() {
      element.removed = true
      if (element.parent) element.parent.children = element.parent.children.filter((c) => c !== element)
    },
    querySelector(selector) {
      if (selector !== ':scope > [data-sf-002-provider-status]') return null
      return element.children.find((c) => c.dataset && c.dataset.sf002ProviderStatus !== undefined) ?? null
    },
    querySelectorAll() {
      return element.children
    },
  }
  elements.push(element)
  return element
}

const headings = []
const documentStub = {
  body: makeElement('body'),
  head: makeElement('head'),
  createElement: (tag) => makeElement(tag),
  getElementById: (id) => elements.find((e) => e.id === id) ?? null,
  querySelectorAll: (selector) => {
    if (selector === '[data-menu-group-heading]') return headings
    if (selector === '[data-sf-002-provider-status]') return elements.filter((e) => e.dataset.sf002ProviderStatus !== undefined)
    return []
  },
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
  useEffect(effect) {
    effect()
  },
}

const observed = []
class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
  }
  observe() {
    observed.push(this)
  }
  disconnect() {
    this.disconnected = true
  }
  fire() {
    this.callback([])
  }
}

let bundle = null
let timerId = 0
const windowStub = {
  __ModuleLoader__: { load: (definition) => { bundle = definition } },
  setTimeout: (fn) => {
    timerId += 1
    queueMicrotask(fn)
    return timerId
  },
  clearTimeout: () => {},
  setInterval: () => 7,
  clearInterval: () => {},
}

const context = {
  window: windowStub,
  document: documentStub,
  MutationObserver: MutationObserverStub,
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      updatedAt: Date.now(),
      providers: [{
        id: 'clinebot',
        label: null,
        kind: 'clinepass',
        ok: true,
        planName: 'Cline Pass (Monthly)',
        interval: 'Monthly',
        priceCents: 999,
        periodStart: '2026-10-10T16:12:00.000Z',
        periodEnd: new Date(Date.now() + 2 * 86400000).toISOString(),
        windows: [{ type: 'weekly', percentUsed: 41 }, { type: 'monthly', percentUsed: 81 }],
        checkedAt: Date.now(),
      }],
    }),
  }),
  console,
}
vm.createContext(context)
vm.runInContext(source, context)

check('bundle registered', bundle !== null)
check('bundle id', bundle?.id === 'dsh-provider-status')

const moduleExports = bundle.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
check('exports apply', typeof moduleExports.apply === 'function')
check('exports inject', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'))

// --- fake client context ----------------------------------------------------
const registrations = []
const dictionaries = {}
const fakeCtx = {
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(service) {
    if (service === 'modelDirectories') {
      return {
        directoryFor: (sessionId) => ({
          load: async () => {},
          store: {
            getSnapshot: () => ({
              current: { provider: 'clinebot', model: 'cline-pass/deepseek-v4.1-flash' },
              groups: [{ id: 'clinebot', name: 'ClinePass', models: [] }],
              failures: [],
            }),
            subscribe: () => () => {},
          },
          sessionId,
        }),
      }
    }
    if (service === 'remote') return {}
    return undefined
  },
  locale: {
    register(ns, locale, dictionary) {
      dictionaries[locale] = dictionary
      return () => {}
    },
    bind: () => (key, values) => {
      const template = dictionaries.en?.[key] ?? key
      return template.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? `{${name}}`))
    },
  },
  inject(names, callback) {
    callback(fakeCtx)
    return () => {}
  },
  slots: {
    inject(slotName, callback) {
      check('slots.inject names the dock slot', slotName === 'conversation.composer.dock', slotName)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

moduleExports.apply(fakeCtx)

check('en dictionary registered', typeof dictionaries.en?.['days.left'] === 'string')
check('ru dictionary registered', typeof dictionaries.ru?.['days.left'] === 'string')
check('one dock entry registered', registrations.length === 1, registrations.length)
const entry = registrations[0]
check('entry id', entry?.options.id === 'provider-status')
check('entry order after stats', entry?.options.order === 1)
check('entry locale namespace', entry?.options.locale === 'sf-002-provider-status')

const injected = entry.options.inject('session-1')
check('inject provides a directory hook', typeof injected?.hooks?.directory?.getSnapshot === 'function')

// let the stubbed fetch resolve before rendering
await new Promise((resolve) => setImmediate(resolve))

const t = fakeCtx.locale.bind('dsh-provider-status')
const useDirectory = (selector) => selector(injected.hooks.directory.getSnapshot())
const tree = entry.component({ t, useDirectory })

const collectText = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(collectText).join('')
  return (node.children ?? []).map(collectText).join('')
}
const text = collectText(tree)
console.log(`     rendered: "${text}"`)
check('pill names the provider', text.includes('ClinePass'), text)
check('pill prints days left', /2d left/.test(text), text)
check('pill uses the pill class', tree?.children?.[0]?.props?.className === 'dshps-pill')
check('pill tooltip has the plan', String(tree?.children?.[0]?.props?.title ?? '').includes('Cline Pass (Monthly)'))
check('pill tooltip has quota windows', String(tree?.children?.[0]?.props?.title ?? '').includes('81%'))
check('stylesheet injected', elements.some((e) => e.id === 'sf-002-provider-status-css'))
check('mutation observer installed', observed.length === 1 && observed[0].disconnected !== true)

// --- model picker caption ---------------------------------------------------
const heading = makeElement('span')
heading.textContent = 'ClinePass'
headings.push(heading)
observed[0].fire()
await new Promise((resolve) => setImmediate(resolve))
const caption = heading.children.find((c) => c.dataset.sf002ProviderStatus !== undefined)
check('caption appended to the provider heading', caption !== undefined)
console.log(`     caption: "${heading.textContent}"`)
check('caption prints days left', /2d left/.test(String(caption?.textContent ?? '')), heading.textContent)
check('caption is idempotent', (() => {
  observed[0].fire()
  return heading.children.filter((c) => c.dataset.sf002ProviderStatus !== undefined).length === 1
})())

// a non-provider heading stays untouched
const other = makeElement('span')
other.textContent = 'DeepSeek Account'
headings.push(other)
observed[0].fire()
check('unrelated heading untouched', other.children.length === 0, other.children.length)

console.log(failures === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures} CLIENT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

