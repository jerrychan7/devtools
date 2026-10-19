import { createCdpServer, type CdpServer } from '@devtools-anywhere/cdp-server'
import { connectFrontend } from './connection'

const HEIGHT_KEY = 'devtools-anywhere:height'
const MIN_HEIGHT = 80

const STYLE = `
:host { all: initial; }
.launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 44px; height: 44px; border: 0; border-radius: 50%;
  background: #1a73e8; color: #fff; font: 600 13px/44px system-ui, sans-serif;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .3); cursor: pointer; touch-action: manipulation;
}
:host([open]) .launcher, :host([no-launcher]) .launcher { display: none; }
.panel {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  display: none; flex-direction: column;
  background: #fff; border-top: 1px solid #cacdd1;
}
:host([open]) .panel { display: flex; }
.bar {
  flex: none; position: relative; height: 16px; background: #f1f3f4;
  cursor: row-resize; touch-action: none;
}
.bar::before {
  content: ''; position: absolute; left: 50%; top: 6px; width: 32px; height: 4px;
  margin-left: -16px; border-radius: 2px; background: #bdc1c6;
}
.close {
  position: absolute; right: 4px; top: 0; width: 24px; height: 16px; padding: 0; border: 0;
  background: none; color: #5f6368; font: 14px/16px system-ui, sans-serif; cursor: pointer;
}
iframe { flex: 1; width: 100%; border: 0; }
.dragging iframe { pointer-events: none; }
`

/**
 * `<devtools-anywhere frontend="…/chii_app.html" open>`
 *
 * Attributes:
 * - `frontend`: URL of the DevTools frontend entry page. Loaded on first open.
 * - `open`: shows the panel; otherwise a small launcher button is shown.
 * - `height`: panel height as a CSS length (default `50vh`). Dragging the top edge
 *   overrides it and is remembered in localStorage.
 * - `no-launcher`: hides the launcher button.
 *
 * Keep the element attached in one place: moving it in the DOM reloads the iframe.
 */
export class DevtoolsAnywhereElement extends HTMLElement {
  static observedAttributes = ['open', 'frontend', 'height']

  /** The CDP server for this page. Created when the element is first connected. */
  server: CdpServer | null = null

  private panel: HTMLDivElement
  private frame: HTMLIFrameElement
  private loadedUrl = ''
  private disconnect: (() => void) | null = null

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = `<style>${STYLE}</style>
<button class="launcher" part="launcher" aria-label="Open DevTools">F12</button>
<div class="panel" part="panel">
  <div class="bar"><button class="close" aria-label="Close DevTools">×</button></div>
  <iframe title="DevTools"></iframe>
</div>`
    this.panel = root.querySelector('.panel')!
    this.frame = root.querySelector('iframe')!
    root.querySelector('.launcher')!.addEventListener('click', () => this.show())
    root.querySelector('.close')!.addEventListener('click', () => this.hide())
    this.setupResizer(root.querySelector('.bar')!)
  }

  get open() {
    return this.hasAttribute('open')
  }
  set open(value: boolean) {
    this.toggleAttribute('open', value)
  }

  show() {
    this.open = true
  }
  hide() {
    this.open = false
  }
  toggle() {
    this.open = !this.open
  }

  connectedCallback() {
    // Marks the element so the DOM domain can hide it from the Elements panel.
    this.setAttribute('data-devtools-anywhere', '')
    this.server ??= createCdpServer()
    this.update()
  }

  disconnectedCallback() {
    // A detached iframe is unloaded; it reconnects and reloads when attached again.
    this.disconnect?.()
    this.disconnect = null
    this.loadedUrl = ''
  }

  attributeChangedCallback() {
    if (this.isConnected) this.update()
  }

  private update() {
    const stored = Number(localStorage.getItem(HEIGHT_KEY))
    this.panel.style.height = stored ? `${stored}px` : this.getAttribute('height') || '50vh'
    // Load the frontend only once DevTools is opened; the probe keeps capturing meanwhile.
    if (this.open) this.loadFrontend()
  }

  private loadFrontend() {
    const frontend = this.getAttribute('frontend')
    if (!frontend || !this.server) return
    const url = new URL(frontend, location.href)
    if (url.href === this.loadedUrl) return
    this.loadedUrl = url.href
    this.disconnect?.()
    this.disconnect = connectFrontend(this.server, this.frame, url.origin)
    this.frame.src = `${url.href.split('#')[0]}#?embedded=${encodeURIComponent(location.origin)}`
  }

  private setupResizer(resizer: HTMLElement) {
    resizer.addEventListener('pointerdown', down => {
      if ((down.target as HTMLElement).closest('.close')) return
      down.preventDefault()
      resizer.setPointerCapture(down.pointerId)
      this.panel.classList.add('dragging')
      const move = (e: PointerEvent) => {
        const height = Math.min(Math.max(innerHeight - e.clientY, MIN_HEIGHT), innerHeight - 16)
        this.panel.style.height = `${height}px`
      }
      const up = () => {
        this.panel.classList.remove('dragging')
        localStorage.setItem(HEIGHT_KEY, String(this.panel.offsetHeight))
        resizer.removeEventListener('pointermove', move)
        resizer.removeEventListener('pointerup', up)
        resizer.removeEventListener('pointercancel', up)
      }
      resizer.addEventListener('pointermove', move)
      resizer.addEventListener('pointerup', up)
      resizer.addEventListener('pointercancel', up)
    })
  }
}

/** Registers the element under `tag` unless something is already registered there. */
export function defineDevtoolsAnywhere(tag = 'devtools-anywhere') {
  if (!customElements.get(tag)) customElements.define(tag, DevtoolsAnywhereElement)
}
