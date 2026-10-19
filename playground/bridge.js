// Temporary bridge for the playground: embeds the local Chii frontend in an iframe and
// connects it to our CDP server. It will be replaced by the <devtools-anywhere> element.
// Methods the frontend calls that we do not implement are collected in window.__unimplemented.
window.attachDevtools = function () {
  var FRONTEND = '/chii.ignore/public/front_end/chii_app.html'
  var origin = location.origin
  var server = window.DevtoolsAnywhereCdp.createCdpServer()
  var pending = {}
  window.__unimplemented = []
  // Recent traffic for debugging: [direction, message].
  window.__trace = []
  var trace = function (dir, msg) {
    if (window.__trace.push([dir, msg]) > 500) window.__trace.shift()
  }

  var box = document.createElement('div')
  box.style.cssText =
    'position:fixed;left:0;bottom:0;width:100%;height:60%;z-index:2147483647;border-top:1px solid #cacdd1;background:#fff'
  var frame = document.createElement('iframe')
  frame.style.cssText = 'border:0;width:100%;height:100%'
  frame.src = FRONTEND + '#?embedded=' + encodeURIComponent(origin)
  box.appendChild(frame)

  server.onMessage(function (message) {
    var msg = JSON.parse(message)
    trace('<', msg)
    if (msg.id !== undefined && msg.error && msg.error.code === -32601) window.__unimplemented.push(pending[msg.id])
    delete pending[msg.id]
    frame.contentWindow.postMessage(message, origin)
  })
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow || event.origin !== origin || typeof event.data !== 'string') return
    var msg = JSON.parse(event.data)
    trace('>', msg)
    pending[msg.id] = msg.method
    server.dispatch(msg)
  })

  document.body.appendChild(box)
  window.__devtoolsBox = box
}
