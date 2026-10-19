import type { CdpServer } from '@devtools-anywhere/cdp-server'

/**
 * Connects a CDP server to a DevTools frontend running in `frame`, over postMessage.
 *
 * - Only messages from the frame's window and the frontend's origin are accepted, and
 *   outgoing messages are addressed to that origin only.
 * - Messages for the frontend are queued until it sends its first message: before that,
 *   its window may still be loading and would drop them.
 * - When the frame reloads (a new frontend instance), the domains are disabled so that
 *   the new instance's `enable` calls replay everything captured so far.
 *
 * Returns a function that disconnects.
 */
export function connectFrontend(server: CdpServer, frame: HTMLIFrameElement, frontendOrigin: string): () => void {
  let ready = false
  let loads = 0
  const queue: string[] = []

  const post = (message: string) => frame.contentWindow?.postMessage(message, frontendOrigin)

  const offServer = server.onMessage(message => {
    if (ready) post(message)
    else queue.push(message)
  })

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== frontendOrigin) return
    if (typeof event.data !== 'string') return
    if (!ready) {
      ready = true
      queue.splice(0).forEach(post)
    }
    server.dispatch(event.data).catch(() => {
      // Malformed message: there is no id to answer to.
    })
  }

  const onLoad = () => {
    if (loads++ === 0) return
    ready = false
    queue.length = 0
    for (const method of ['Runtime.disable', 'Network.disable']) server.call(method).catch(() => {})
  }

  window.addEventListener('message', onMessage)
  frame.addEventListener('load', onLoad)
  return () => {
    offServer()
    window.removeEventListener('message', onMessage)
    frame.removeEventListener('load', onLoad)
  }
}
