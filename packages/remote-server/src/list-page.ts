/**
 * The target list: the pages connected to the server, each with a link that opens DevTools
 * on it. It polls `json/list` with the token it was opened with, and builds every row from
 * text (titles and URLs come from the pages).
 */
export function listPage(base: string): string {
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
  .empty { color: #5f6368; }
  @media (prefers-color-scheme: dark) {
    body { background: #202124; color: #e8eaed; }
    code { background: #303134; }
    li { border-color: #3c4043; }
    .url, .ua, .empty { color: #9aa0a6; }
    a { color: #8ab4f8; }
  }
</style>
</head>
<body>
<h1>Remote targets</h1>
<p>Add this as the first script in the page's <code>&lt;head&gt;</code>:</p>
<p><code id="snippet"></code></p>
<ul id="targets"></ul>
<script>
  const base = ${JSON.stringify(base)};
  document.getElementById('snippet').textContent =
    '<script src="' + location.origin + base + 'probe.iife.js" data-remote></' + 'script>';
  const query = location.search;
  const list = document.getElementById('targets');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  async function refresh() {
    let targets = [];
    try {
      targets = await (await fetch(base + 'json/list' + query)).json();
    } catch {
      return;
    }
    list.replaceChildren(...targets.map(target => {
      const item = el('li');
      const icon = el('img');
      icon.alt = '';
      if (/^https?:/.test(target.faviconUrl)) icon.src = target.faviconUrl;
      const info = el('div', 'info');
      info.append(
        el('div', 'title', target.title || target.url),
        el('div', 'url', target.url),
        el('div', 'ua', target.userAgent));
      const link = el('a', '', target.attached ? 'inspect (taking over)' : 'inspect');
      link.href = target.devtoolsFrontendUrl;
      link.target = '_blank';
      item.append(icon, info, link);
      return item;
    }));
    if (!targets.length) list.append(el('li', 'empty', 'No page is connected.'));
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>
`;
}
