// Embeds the local Chii frontend in an iframe and bridges it to chobitsu.
//
// With a probe, the bridge also:
//   - restores original timestamps / stacks on replayed Runtime.consoleAPICalled messages,
//     and turns replayed exceptions back into Runtime.exceptionThrown;
//   - emits synthetic Network events for requests the probe saw before chobitsu loaded,
//     and answers Network.getResponseBody / getRequestPostData for them.
//
// Every message sent to the frontend is kept in window.__bridgeLog for inspection.
(function () {
  'use strict';
  var FRONTEND = '/chii.ignore/public/front_end/chii_app.html';

  function parseStack(stack) {
    if (!stack) return [];
    var frames = [];
    String(stack)
      .split('\n')
      .forEach(function (line) {
        line = line.trim();
        var m = /^at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/.exec(line) || /^(.*?)@(.*?):(\d+):(\d+)$/.exec(line);
        if (!m || /\/probe\.js/.test(m[2])) return;
        frames.push({
          functionName: m[1] || '',
          scriptId: '',
          url: m[2],
          lineNumber: +m[3] - 1,
          columnNumber: +m[4] - 1,
        });
      });
    return frames;
  }

  window.__embedDevtools = function (opts) {
    opts = opts || {};
    var replayQueue = (opts.replayed || []).slice();
    var probe = opts.probe || null;
    var origin = location.origin;
    var log = (window.__bridgeLog = []);
    var exceptionId = 0;

    var box = document.createElement('div');
    box.className = '__chobitsu-hide__';
    box.style.cssText =
      'position:fixed;left:0;bottom:0;width:100%;height:60%;z-index:2147483647;border-top:1px solid #cacdd1;background:#fff';
    var frame = document.createElement('iframe');
    frame.style.cssText = 'border:0;width:100%;height:100%';
    frame.src = FRONTEND + '#?embedded=' + encodeURIComponent(origin);
    box.appendChild(frame);

    function toDevtools(msg) {
      log.push(msg);
      frame.contentWindow.postMessage(JSON.stringify(msg), origin);
    }

    chobitsu.setOnMessage(function (raw) {
      var msg = JSON.parse(raw);
      if (msg.method === 'Runtime.consoleAPICalled' && replayQueue.length) {
        var e = replayQueue.shift();
        if (e.kind === 'console') {
          msg.params.timestamp = e.time;
          if (e.stack) msg.params.stackTrace = { callFrames: parseStack(e.stack) };
          msg.params.__replayed = true;
        } else {
          msg = {
            method: 'Runtime.exceptionThrown',
            params: {
              timestamp: e.time,
              exceptionDetails: {
                exceptionId: ++exceptionId,
                text: e.text,
                url: e.url,
                lineNumber: (e.line || 1) - 1,
                columnNumber: (e.col || 1) - 1,
                exception: msg.params.args[0],
                stackTrace: { callFrames: parseStack(e.stack) },
              },
              __replayed: true,
            },
          };
        }
      }
      toDevtools(msg);
    });

    // ---- synthetic network events for probe-recorded requests ----

    var networkEnabled = false;
    var sent = {};
    function emit(rec) {
      if (!networkEnabled) return;
      var s = (sent[rec.requestId] = sent[rec.requestId] || {});
      if (!s.request) {
        s.request = true;
        var request = { method: rec.method, url: rec.url, headers: rec.headers };
        if (rec.postData) request.postData = rec.postData;
        toDevtools({
          method: 'Network.requestWillBeSent',
          params: { requestId: rec.requestId, type: rec.type, request: request, timestamp: rec.start / 1000, __replayed: true },
        });
      }
      if ((rec.state === 'headers' || rec.state === 'done') && !s.headers) {
        s.headers = true;
        toDevtools({
          method: 'Network.responseReceivedExtraInfo',
          params: { requestId: rec.requestId, blockedCookies: [], headers: rec.resHeaders, __replayed: true },
        });
      }
      if (rec.state === 'done' && !s.done) {
        s.done = true;
        toDevtools({
          method: 'Network.responseReceived',
          params: {
            requestId: rec.requestId,
            type: rec.type,
            response: { status: rec.status, statusText: rec.statusText, headers: rec.resHeaders, url: rec.url },
            timestamp: rec.end / 1000,
            __replayed: true,
          },
        });
        toDevtools({
          method: 'Network.loadingFinished',
          params: { requestId: rec.requestId, encodedDataLength: rec.size, timestamp: rec.end / 1000, __replayed: true },
        });
      }
      if (rec.state === 'failed' && !s.done) {
        s.done = true;
        toDevtools({
          method: 'Network.loadingFailed',
          params: { requestId: rec.requestId, type: rec.type, errorText: rec.errorText, timestamp: rec.end / 1000, __replayed: true },
        });
      }
    }
    function findRequest(id) {
      for (var i = 0; i < probe.requests.length; i++) if (probe.requests[i].requestId === id) return probe.requests[i];
      return null;
    }

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      if (typeof event.data !== 'string') return;
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      var id = msg.params && msg.params.requestId;
      if (probe && id && /^probe-/.test(id)) {
        var rec = findRequest(id);
        if (msg.method === 'Network.getResponseBody') {
          toDevtools({ id: msg.id, result: { base64Encoded: false, body: (rec && rec.body) || '' } });
          return;
        }
        if (msg.method === 'Network.getRequestPostData') {
          toDevtools({ id: msg.id, result: { postData: (rec && rec.postData) || '' } });
          return;
        }
      }
      chobitsu.sendRawMessage(event.data);
      if (probe && msg.method === 'Network.enable' && !networkEnabled) {
        networkEnabled = true;
        probe.requests.forEach(emit);
        probe.subscribe(emit);
      }
    });

    document.body.appendChild(box);
    return frame;
  };
})();
