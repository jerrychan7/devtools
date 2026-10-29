import type { ProbeScriptAttributes } from 'devtools-anywhere';

/** The probe script's attributes that connect a page to this server, as written in a tag. */
export function probeAttributes(idInQuery: boolean): string {
  const attributes: ProbeScriptAttributes = { 'data-remote': true };
  if (idInQuery) attributes['data-id-in-query'] = true;
  return Object.keys(attributes).join(' ');
}

/**
 * The target list: the pages connected to the server, each with a link that opens DevTools
 * on it, and the script tag for pages (naming the server at `publicUrl`). It polls `json/list` with the token it was opened with, and builds every row from
 * text (titles and URLs come from the pages).
 */
export function listPage(base: string, publicUrl?: string, idInQuery = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devtools-anywhere: remote targets</title>
<style>
  body { font: 13px/1.5 system-ui, sans-serif; margin: 24px; color: #202124; }
  h1 { font-size: 18px; font-weight: 500; }
  code { background: #f1f3f4; padding: 2px 4px; border-radius: 4px; word-break: break-all; }
  ul { list-style: none; padding: 0; }
  li { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid #e8eaed; }
  li img { width: 16px; height: 16px; margin-top: 3px; }
  .info { flex: 1; min-width: 0; }
  .title { font-weight: 500; }
  .url, .ua { color: #5f6368; overflow-wrap: anywhere; }
  .empty, .state { color: #5f6368; }
  .gone { opacity: .55; }
  input { font: inherit; padding: 4px 8px; width: min(100%, 360px); box-sizing: border-box; }
  @media (prefers-color-scheme: dark) {
    body { background: #202124; color: #e8eaed; }
    code { background: #303134; }
    li { border-color: #3c4043; }
    .url, .ua, .empty, .state { color: #9aa0a6; }
    input { background: #303134; color: inherit; border: 1px solid #5f6368; }
    a { color: #8ab4f8; }
  }
</style>
</head>
<body>
<h1>Remote targets</h1>
<p>Add this as the first script in the page's <code>&lt;head&gt;</code>:</p>
<p><code id="snippet"></code></p>
<input id="filter" type="search" placeholder="Filter by title, URL or user agent">
<ul id="targets"></ul>
<script>
  const base = ${JSON.stringify(base)};
  const server = ${JSON.stringify(publicUrl ?? '')} || location.origin + base;
  document.getElementById('snippet').textContent =
    '<script src="' + server + 'probe.iife.js" ${probeAttributes(idInQuery)}></' + 'script>';
  const query = location.search;
  const list = document.getElementById('targets');
  const filter = document.getElementById('filter');
  let targets = [];
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const ago = since => {
    const s = Math.round((Date.now() - since) / 1000);
    return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h';
  };
  function render() {
    const words = filter.value.toLowerCase().split(/\\s+/).filter(Boolean);
    const shown = targets.filter(target => {
      const haystack = (target.title + ' ' + target.url + ' ' + target.userAgent).toLowerCase();
      return words.every(word => haystack.includes(word));
    });
    list.replaceChildren(...shown.map(target => {
      const item = el('li', target.connected ? '' : 'gone');
      const icon = el('img');
      icon.alt = '';
      if (/^https?:/.test(target.faviconUrl)) icon.src = target.faviconUrl;
      const info = el('div', 'info');
      info.append(
        el('div', 'title', target.title || target.url),
        el('div', 'url', target.url),
        el('div', 'ua', target.userAgent),
        el('div', 'state', [
          target.connected ? 'connected' : 'disconnected, waiting for it to come back',
          'first seen ' + ago(target.since) + ' ago',
          target.clients ? target.clients + ' DevTools attached' : '',
        ].filter(Boolean).join(' · ')));
      const link = el('a', '', 'inspect');
      link.href = target.devtoolsFrontendUrl;
      link.target = '_blank';
      item.append(icon, info, link);
      return item;
    }));
    if (!shown.length) list.append(el('li', 'empty', targets.length ? 'No page matches.' : 'No page is connected.'));
  }
  async function refresh() {
    try {
      targets = await (await fetch(base + 'json/list' + query)).json();
    } catch {
      return;
    }
    render();
  }
  filter.addEventListener('input', render);
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>
`;
}
