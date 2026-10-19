// Early-capture probe. Must be the first synchronous script in <head>.
//
// Modes:
//   buffer – record console calls, uncaught errors and fetch/XHR, still print natively
//   replay – console calls come back from chobitsu's wrapper during handoff; swallow them
//   pass   – chobitsu has taken over; behave like the native APIs
//
// handoff() must run synchronously right after chobitsu is evaluated (e.g. in the
// script's onload), so nothing else can log between chobitsu hooking console and replay.
(function () {
  'use strict';
  var w = window;
  // Same set chobitsu wraps; replaying a method chobitsu does not wrap would be lost.
  var METHODS = ['log', 'warn', 'error', 'info', 'debug', 'dir', 'table', 'group', 'groupCollapsed', 'groupEnd', 'clear'];
  var mode = 'buffer';
  var entries = [];
  var requests = [];
  var listeners = [];
  var wrappers = {};
  var seq = 0;

  function now() {
    return performance.timeOrigin + performance.now();
  }

  METHODS.forEach(function (name) {
    var orig = console[name];
    if (!orig) return;
    wrappers[name] = console[name] = function () {
      if (mode === 'replay') return;
      if (mode === 'buffer') {
        entries.push({
          kind: 'console',
          name: name,
          args: Array.prototype.slice.call(arguments),
          time: now(),
          stack: name === 'error' || name === 'warn' ? new Error().stack : null,
        });
      }
      return orig.apply(console, arguments);
    };
  });

  function onError(e) {
    if (mode !== 'buffer' || !(e instanceof ErrorEvent)) return;
    entries.push({
      kind: 'exception',
      text: 'Uncaught',
      error: e.error !== undefined ? e.error : e.message,
      time: now(),
      stack: (e.error && e.error.stack) || null,
      url: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  }
  function onRejection(e) {
    if (mode !== 'buffer') return;
    entries.push({
      kind: 'exception',
      text: 'Uncaught (in promise)',
      error: e.reason,
      time: now(),
      stack: (e.reason && e.reason.stack) || null,
    });
  }
  w.addEventListener('error', onError, true);
  w.addEventListener('unhandledrejection', onRejection);

  // ---- network ----

  function track(type, method, url, headers, postData) {
    var rec = {
      requestId: 'probe-' + ++seq,
      type: type,
      method: method,
      url: new URL(String(url), location.href).href,
      headers: headers || {},
      postData: postData,
      start: Date.now(),
      state: 'pending',
    };
    requests.push(rec);
    return rec;
  }
  function update(rec, patch) {
    for (var k in patch) rec[k] = patch[k];
    listeners.forEach(function (fn) {
      fn(rec);
    });
  }
  function headersToObj(headers) {
    var obj = {};
    headers.forEach(function (v, k) {
      obj[k] = v;
    });
    return obj;
  }
  function parseRawHeaders(raw) {
    var obj = {};
    raw.trim().split(/[\r\n]+/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) obj[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return obj;
  }

  var origFetch = w.fetch;
  if (origFetch) {
    w.fetch = function (input, init) {
      if (mode !== 'buffer') return origFetch.apply(this, arguments);
      var req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      var method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
      var h = (init && init.headers) || (req && req.headers);
      var rec = track(
        'Fetch',
        method,
        req ? req.url : input,
        h ? headersToObj(new Headers(h)) : {},
        init && typeof init.body === 'string' ? init.body : undefined
      );
      var p = origFetch.apply(this, arguments);
      p.then(
        function (res) {
          update(rec, { state: 'headers', status: res.status, statusText: res.statusText, resHeaders: headersToObj(res.headers) });
          res
            .clone()
            .text()
            .then(function (text) {
              update(rec, { state: 'done', body: text, size: text.length, end: Date.now() });
            });
        },
        function (err) {
          update(rec, { state: 'failed', errorText: String((err && err.message) || err), end: Date.now() });
        }
      );
      return p;
    };
  }

  var XP = XMLHttpRequest.prototype;
  var origOpen = XP.open;
  var origSend = XP.send;
  var origSetHeader = XP.setRequestHeader;
  XP.open = function (method, url) {
    this.__probe = mode === 'buffer' ? { method: String(method).toUpperCase(), url: url, headers: {} } : null;
    return origOpen.apply(this, arguments);
  };
  XP.setRequestHeader = function (k, v) {
    if (this.__probe) this.__probe.headers[k] = v;
    return origSetHeader.apply(this, arguments);
  };
  XP.send = function (data) {
    var info = this.__probe;
    if (info) {
      var xhr = this;
      var rec = track('XHR', info.method, info.url, info.headers, typeof data === 'string' ? data : undefined);
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState === 2) {
          update(rec, { state: 'headers', status: xhr.status, statusText: xhr.statusText, resHeaders: parseRawHeaders(xhr.getAllResponseHeaders()) });
        } else if (xhr.readyState === 4) {
          if (!xhr.status) {
            update(rec, { state: 'failed', errorText: 'net::ERR_FAILED', end: Date.now() });
          } else {
            var text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : '';
            update(rec, {
              state: 'done',
              status: xhr.status,
              statusText: xhr.statusText,
              resHeaders: parseRawHeaders(xhr.getAllResponseHeaders()),
              body: text,
              size: text.length,
              end: Date.now(),
            });
          }
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- handoff ----

  w.__earlyProbe = {
    // Replays buffered console calls and exceptions through chobitsu's console wrapper so the
    // arguments become real, expandable RemoteObjects. Returns the replayed entries in order;
    // the bridge uses them to restore the original timestamps and stacks.
    handoff: function () {
      w.removeEventListener('error', onError, true);
      w.removeEventListener('unhandledrejection', onRejection);
      var replayed = [];
      mode = 'replay';
      entries.forEach(function (e) {
        var name = e.kind === 'console' ? e.name : 'error';
        if (console[name] === wrappers[name]) return; // chobitsu did not wrap it
        console[name].apply(console, e.kind === 'console' ? e.args : [e.error]);
        replayed.push(e);
      });
      mode = 'pass';
      entries = [];
      return replayed;
    },
    requests: requests,
    subscribe: function (fn) {
      listeners.push(fn);
    },
  };
})();
