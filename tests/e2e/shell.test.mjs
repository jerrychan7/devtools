// Shell mode in real Chrome, with a fake frontend that records what it receives.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { launch } from '../conformance/harness.mjs'

let env
let page

before(async () => {
  env = await launch()
  page = await env.browser.newPage()
  await page.goto(env.baseUrl + '/tests/e2e/shell-page.html?first')
})
after(() => env?.close())

const shellState = () =>
  page.evaluate(() => {
    const frame = document.getElementById('devtools-anywhere-page')
    const devtools = document.querySelector('devtools-anywhere[shell]')
    const frontend = devtools?.shadowRoot.querySelector('iframe').contentWindow
    return {
      inShell: !!frame && !!devtools,
      shellRanPageScript: !!window.__pageScriptRan,
      pageRanScript: !!frame?.contentWindow.__pageScriptRan,
      url: location.href,
      received: frontend?.received || [],
    }
  })

async function waitFor(predicate, timeout = 5000) {
  const start = Date.now()
  for (;;) {
    let state
    try {
      state = await shellState()
      if (predicate(state)) return state
    } catch {
      // Navigation in progress.
    }
    if (Date.now() - start > timeout) throw new Error('timed out: ' + JSON.stringify(state))
    await new Promise(r => setTimeout(r, 50))
  }
}

const earlyLogs = state =>
  state.received.filter(m => m.method === 'Runtime.consoleAPICalled' && m.params.args[0].value === 'early')

test('entering shell mode turns the page into the shell in place', async () => {
  await page.evaluate(() => document.querySelector('devtools-anywhere').enterShell())
  const state = await waitFor(s => s.inShell && earlyLogs(s).length > 0)
  assert.equal(state.shellRanPageScript, false, "the page's scripts do not run in the shell")
  assert.equal(state.pageRanScript, true, 'the page runs inside the iframe')
  assert.match(state.url, /shell-page\.html\?first$/, 'the address bar keeps the page URL')
})

test('DevTools survives a page reload and gets the new page output', async () => {
  await page.evaluate(() => document.getElementById('devtools-anywhere-page').contentWindow.location.reload())
  const state = await waitFor(s => earlyLogs(s).length >= 2)
  assert.ok(state.received.some(m => m.method === 'Runtime.executionContextsCleared'))
  assert.ok(state.received.some(m => m.method === 'Page.frameNavigated'))
})

test('navigation inside the page updates the address bar', async () => {
  await page.evaluate(() => {
    document.getElementById('devtools-anywhere-page').contentWindow.location.href = '/tests/e2e/shell-page.html?second'
  })
  const state = await waitFor(s => /\?second$/.test(s.url))
  assert.ok(earlyLogs(state).length >= 3)
})

test('closing leaves shell mode', async () => {
  await page.evaluate(() => {
    document.querySelector('devtools-anywhere[shell]').shadowRoot.querySelector('.close').click()
  })
  await new Promise(r => setTimeout(r, 1000))
  const state = await page.evaluate(() => ({
    inShell: !!document.getElementById('devtools-anywhere-page'),
    ran: !!window.__pageScriptRan,
    url: location.href,
  }))
  assert.equal(state.inShell, false)
  assert.equal(state.ran, true)
  assert.match(state.url, /\?second$/)
})
