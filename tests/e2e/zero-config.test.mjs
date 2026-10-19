// The single-script setup, and the Service Worker that injects the probe in shell mode.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { launch } from '../conformance/harness.mjs'

let env
let page

before(async () => {
  env = await launch()
  page = await env.browser.newPage()
  await page.goto(env.baseUrl + '/tests/e2e/zero-config.html')
})
after(() => env?.close())

/** Messages the fake frontend received, in or outside shell mode. */
const received = () =>
  page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere[shell]') || document.querySelector('devtools-anywhere')
    return el?.shadowRoot.querySelector('iframe').contentWindow.received || []
  })
const logged = (messages, text) =>
  messages.some(m => m.method === 'Runtime.consoleAPICalled' && m.params.args[0].value === text)

async function waitFor(predicate, timeout = 8000) {
  const start = Date.now()
  for (;;) {
    try {
      if (await predicate()) return
    } catch {
      // Navigation in progress.
    }
    if (Date.now() - start > timeout) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 50))
  }
}

test('one script tag captures early output and mounts DevTools after load', async () => {
  await waitFor(async () => logged(await received(), 'zero-config early'))
  const open = await page.evaluate(() => document.querySelector('devtools-anywhere').open)
  assert.equal(open, true)
})

test('in shell mode the Service Worker injects the probe into pages without it', async () => {
  await page.evaluate(() => document.querySelector('devtools-anywhere').enterShell())
  await waitFor(() => page.evaluate(() => !!document.querySelector('devtools-anywhere[shell]')))
  await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller))
  await page.evaluate(() => {
    document.getElementById('devtools-anywhere-page').contentWindow.location.href = '/tests/e2e/no-probe.html'
  })
  await waitFor(async () => logged(await received(), 'no-probe early'))
})

test('leaving shell mode unregisters the Service Worker', async () => {
  await page.evaluate(() => document.querySelector('devtools-anywhere[shell]').exitShell())
  await waitFor(() => page.evaluate(() => !document.getElementById('devtools-anywhere-page')))
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
  assert.equal(registrations, 0)
})
