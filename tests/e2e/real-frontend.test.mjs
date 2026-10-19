// The DevTools frontend built from the official sources (packages/devtools-frontend),
// against the in-page CDP server. Skipped when the frontend has not been built.
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { launch } from '../conformance/harness.mjs'

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url))
const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first'

let env
let frontend

before(async () => {
  if (!built) return
  env = await launch()
  const page = await env.browser.newPage()
  await page.goto(env.baseUrl + '/tests/e2e/real-frontend.html')
  frontend = await waitFor(() => page.frames().find(f => new URL(f.url()).pathname.endsWith('/anywhere_app.html')))
})
after(() => env?.close())

async function waitFor(get, timeout = 15000) {
  const start = Date.now()
  for (;;) {
    const value = await Promise.resolve()
      .then(get)
      .catch(() => null)
    if (value) return value
    if (Date.now() - start > timeout) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 100))
  }
}

/** Text of the frontend, including shadow DOM. */
const text = () =>
  frontend.evaluate(() => {
    const parts = []
    const walk = root => {
      parts.push(root === document ? document.documentElement.textContent : root.textContent)
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot)
    }
    walk(document)
    return parts.join('\n')
  })

/** Clicks a panel's tab in the main tabbed pane (inside shadow DOM). */
async function showPanel(id) {
  const tab = await frontend.evaluateHandle(id => {
    const find = root => {
      const tab = root.querySelector(`#tab-${id}`)
      if (tab) return tab
      for (const el of root.querySelectorAll('*')) {
        const found = el.shadowRoot && find(el.shadowRoot)
        if (found) return found
      }
      return null
    }
    return find(document)
  }, id)
  await tab.asElement()?.click()
}

test('the Elements panel shows the page', { skip }, async () => {
  await showPanel('elements')
  await waitFor(async () => (await text()).includes('real-frontend-marker'))
})

test('the Console panel shows output from before DevTools loaded', { skip }, async () => {
  await waitFor(async () => {
    await showPanel('console')
    return (await text()).includes('real frontend early')
  })
})

test('only the panels that work in the page are offered', { skip }, async () => {
  const tabs = await frontend.evaluate(() => {
    const ids = []
    const walk = root => {
      for (const el of root.querySelectorAll('[id^="tab-"]')) ids.push(el.id.slice(4))
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot)
    }
    walk(document)
    return ids
  })
  for (const panel of ['elements', 'console', 'sources', 'network', 'resources']) assert.ok(tabs.includes(panel), panel)
  for (const panel of ['timeline', 'heap-profiler', 'lighthouse', 'security']) assert.ok(!tabs.includes(panel), panel)
})
