// The Accessibility conformance tests' shared part: a page with accessibility.js loaded on our
// side, and a node of it compared with Chrome's. Case files (`*.html` next to the tests) hold
// pages as groups, each starting with a `<!-- group: name -->` line; the elements marked
// `data-ax-case="<their id>"` are compared one by one.
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from './conformance.ts';
import type { Env, Side, TestPage } from './conformance.ts';

/** Opens a page whose body is `html`, with our session able to load accessibility.js. */
export async function openAxPage(env: Env, html = ''): Promise<TestPage> {
  const t = await openPage(env, []);
  await t.page.evaluate(base => {
    document.title = 'AX';
    window.__session = window.DevtoolsAnywhere.createCdpSession({
      loadAccessibility: () => import(base + '/packages/devtools-anywhere/dist/accessibility.js'),
    });
  }, env.baseUrl);
  // Chrome's whole-tree commands need the domain enabled, setBody's included.
  await Promise.all([t.ours.send('Accessibility.enable'), t.chrome.send('Accessibility.enable')]);
  await setBody(t, html);
  return t;
}

/**
 * Replaces the body; declarative shadow roots in `html` are attached. What a group's setup put on
 * the body itself (attributes, click handlers) is taken off first, as it decides whether Chrome
 * keeps the body.
 *
 * aria-owns attributes are put back one at a time, in document order, Chrome's tree brought up to
 * date after each. When owns conflict (a cycle, two owners of one node), Chrome keeps the one it
 * processes first, and with a whole body inserted at once that order is not the document's: it
 * changes with what the page held before, so the winner of a cycle changed with the groups run
 * earlier. Added in document order, the first owner in the document wins, as in ours.
 */
export async function setBody(t: TestPage, html: string): Promise<void> {
  const owners = await t.page.evaluate(html => {
    const body = document.body;
    for (const name of body.getAttributeNames()) body.removeAttribute(name);
    body.onclick = body.onmousedown = body.onmouseup = null;
    body.setHTMLUnsafe(html);
    // The fixture's own focus would differ between the sides' runs.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const owners = [...document.body.querySelectorAll('[aria-owns]')];
    window.__axOwners = owners.map(el => {
      const value = el.getAttribute('aria-owns') ?? '';
      el.removeAttribute('aria-owns');
      return [el, value] as const;
    });
    return owners.length;
  }, html);
  if (owners) {
    await t.chrome.send('Accessibility.getFullAXTree', {});
    for (let i = 0; i < owners; i++) {
      await t.page.evaluate(i => {
        const [el, value] = window.__axOwners?.[i] ?? [];
        el?.setAttribute('aria-owns', value ?? '');
      }, i);
      await t.chrome.send('Accessibility.getFullAXTree', {});
    }
    await t.page.evaluate(() => delete window.__axOwners);
  }
  // An image still loading would change its node (a broken image's name, its size) mid-comparison.
  await t.page.evaluate(() =>
    Promise.all(
      [...document.images].map(img =>
        img.complete
          ? undefined
          : new Promise<void>(resolve => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
              setTimeout(resolve, 5000);
            })
      )
    )
  );
}

/** The DOM node id of `#id` on one side, looked for in shadow roots too. */
export async function nodeIdOf(side: Side, id: string): Promise<number> {
  const { root } = await side.send('DOM.getDocument', { depth: 0 });
  // An id the selector cannot take (a leading digit) is looked for as one in a shadow root.
  const found = await side
    .send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `#${CSS.escape(id)}`,
    })
    .catch(() => ({ nodeId: 0 }));
  if (found.nodeId) return found.nodeId;
  const { root: tree } = await side.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  });
  const search = (node: Protocol.DOM.Node): number | undefined => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node.nodeId;
    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
      const nodeId = search(child);
      if (nodeId) return nodeId;
    }
    return undefined;
  };
  return search(tree) ?? 0;
}

/** CSS.escape for the ids the case files use. */
const CSS = { escape: (id: string) => id.replace(/[^\w-]/g, c => `\\${c}`) };

/** Ids and links between nodes differ between the sides; Chrome's internal role numbers are its own. */
export function comparable(node: Protocol.Accessibility.AXNode): unknown {
  return JSON.parse(
    JSON.stringify(node, (key, value: unknown) =>
      ['nodeId', 'parentId', 'childIds', 'backendDOMNodeId', 'chromeRole', 'frameId'].includes(key) ? undefined : value
    )
  ) as unknown;
}

/** The node and its relatives as roles and names: what the page cannot see (inline text boxes) left out. */
export function outline(nodes: Protocol.Accessibility.AXNode[]): string[] {
  return nodes
    .filter(n => n.role?.value !== 'InlineTextBox')
    .map(n => `${String(n.role?.value)}${n.name ? `:${String(n.name.value)}` : ''}`);
}

/** `#id`'s node on each side (role, name and its sources, description, value, properties), comparable. */
export async function partialNode(t: TestPage, id: string): Promise<{ ours: unknown; chrome: unknown }> {
  const [ours, chrome] = await Promise.all(
    [t.ours, t.chrome].map(async side =>
      (
        await side.send('Accessibility.getPartialAXTree', {
          nodeId: await nodeIdOf(side, id),
          fetchRelatives: false,
        })
      ).nodes.map(comparable)
    )
  );
  return { ours, chrome };
}

/**
 * `#id`'s node and the nodes under it in the whole tree on each side, comparable, each with its
 * depth below `#id`: what a node alone does not show, such as the list markers, which have no DOM
 * node of their own but their ::marker.
 */
export async function subtree(t: TestPage, id: string): Promise<{ ours: unknown; chrome: unknown }> {
  const [ours, chrome] = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      const { node } = await side.send('DOM.describeNode', { nodeId: await nodeIdOf(side, id) });
      const { nodes } = await side.send('Accessibility.getFullAXTree', {});
      const byId = new Map(nodes.map(n => [n.nodeId, n]));
      const out: unknown[] = [];
      const visit = (n: Protocol.Accessibility.AXNode | undefined, depth: number) => {
        if (!n || n.role?.value === 'InlineTextBox') return;
        out.push({ depth, ...(comparable(n) as object) });
        for (const child of n.childIds ?? []) visit(byId.get(child), depth + 1);
      };
      visit(
        nodes.find(n => n.backendDOMNodeId === node.backendNodeId),
        0
      );
      return out;
    })
  );
  return { ours, chrome };
}

/** Asserts that `#id`'s node is the same on both sides. */
export async function assertSameNode(t: TestPage, id: string): Promise<void> {
  const { ours, chrome } = await partialNode(t, id);
  assert.deepEqual(ours, chrome);
}

export interface CaseGroup {
  name: string;
  html: string;
  /** The ids of the elements to compare, in document order. */
  ids: string[];
  /** The ids of the elements whose subtrees are compared too (`data-ax-tree`), in document order. */
  trees?: string[];
}

/** The groups of a case file. */
export function readCases(url: URL): CaseGroup[] {
  const parts = readFileSync(url, 'utf8').split(/^<!-- group: (.+?) -->\n/m);
  const groups: CaseGroup[] = [];
  const seen = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i] ?? '';
    const html = parts[i + 1] ?? '';
    const ids = [...html.matchAll(/\sdata-ax-case="([^"]+)"/g)].map(m => m[1] ?? '');
    // Test names are the ids: a repeated one would hide a case behind another of the same name.
    for (const id of ids) {
      const first = seen.get(id);
      if (first !== undefined)
        throw new Error(`${url.pathname}: case id "${id}" in "${name}" is already used in "${first}"`);
      seen.set(id, name);
    }
    const trees = [...html.matchAll(/\sdata-ax-tree="([^"]+)"/g)].map(m => m[1] ?? '');
    groups.push({ name, html, ids, trees });
  }
  return groups;
}

export interface CaseOptions {
  /** Run in the page after a group's body is set, to build what HTML cannot say (shadow roots set by script…). */
  setups?: Record<string, (() => void) | string>;
  /** Cases known to differ from Chrome: the reason, then the ids it applies to, separated by whitespace. */
  todo?: Record<string, string>;
}

/** One describe per group, one test per case, each case's node compared with Chrome's. */
export function describeCases(groups: CaseGroup[], options: CaseOptions = {}): void {
  let env: Env | undefined;
  let t: TestPage;
  setUpAndTearDown(
    async () => {
      env = await launch();
      t = await openAxPage(env);
    },
    () => env?.close()
  );

  const todo = new Map<string, string>();
  for (const [reason, ids] of Object.entries(options.todo ?? {}))
    for (const id of ids.split(/\s+/).filter(Boolean)) todo.set(id, reason);

  // A setup for a group the cases do not have would never run, silently.
  const names = new Set(groups.map(group => group.name));
  for (const name of Object.keys(options.setups ?? {}))
    if (!names.has(name)) throw new Error(`setup for "${name}", a group the cases do not have`);

  for (const group of groups)
    describe(group.name, () => {
      before(async () => {
        await setBody(t, group.html);
        const setup = options.setups?.[group.name];
        if (setup) await t.page.evaluate(setup);
      });
      for (const id of group.ids) test(`#${id}`, { todo: todo.get(id) }, () => assertSameNode(t, id));
      for (const id of group.trees ?? [])
        test(`#${id} and its subtree`, { todo: todo.get(id) }, async () => {
          const { ours, chrome } = await subtree(t, id);
          assert.deepEqual(ours, chrome);
        });
    });
}

/**
 * cases/manual.html's setups: nodes made in a frame's realm, moved into the page; the body's
 * attributes and handlers that decide whether Chrome keeps it.
 */
export const MANUAL_SETUPS = {
  'devtools-anywhere body kept: aria attribute': () => document.body.setAttribute('aria-label', 'page'),
  'devtools-anywhere body kept: id': () => document.body.setAttribute('id', 'page'),
  'devtools-anywhere body kept: title': () => document.body.setAttribute('title', 'page'),
  'devtools-anywhere body kept: contenteditable': () => document.body.setAttribute('contenteditable', ''),
  'devtools-anywhere body kept: click handler': () => document.body.setAttribute('onclick', 'void 0'),
  'devtools-anywhere body kept: click handler property': () => {
    document.body.onclick = () => {};
  },
  'devtools-anywhere body kept: other attribute': () => {
    document.body.setAttribute('lang', 'fr');
    document.body.setAttribute('data-x', 'y');
  },
  'devtools-anywhere nodes of another realm': () => {
    const frame = document.body.appendChild(document.createElement('iframe'));
    const other = frame.contentDocument as Document;
    for (const id of ['da-realm-1', 'da-realm-3']) {
      const span = other.createElement('span');
      span.append(other.createTextNode('from a frame'));
      document.getElementById(id)?.append(span);
    }
    frame.remove();
  },
};

/** A whole-tree line: the node's role, name and whether it is ignored, indented by its depth. */
export interface TreeLine {
  text: string;
  /** The roles of the node's ancestors, root first, to tell what a difference is about. */
  ancestors: string[];
}

/**
 * One side's whole tree (`Accessibility.getFullAXTree`) as lines in tree order, children under
 * their parent by `childIds`. Inline text boxes are left out: the page cannot see them, so we do
 * not make them; their text is already their parent StaticText's name, which stays.
 */
export async function fullTree(side: Side): Promise<TreeLine[]> {
  const { nodes } = await side.send('Accessibility.getFullAXTree', {});
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const lines: TreeLine[] = [];
  const visit = (node: Protocol.Accessibility.AXNode, depth: number, ancestors: string[]) => {
    const role = String(node.role?.value);
    if (role === 'InlineTextBox') return;
    const name = node.name?.value ? `:${JSON.stringify(String(node.name.value))}` : '';
    lines.push({
      text: `${'  '.repeat(depth)}${role}${name}${node.ignored ? ' (ignored)' : ''}`,
      ancestors,
    });
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, depth + 1, [...ancestors, role]);
      else
        lines.push({
          text: `${'  '.repeat(depth + 1)}<not listed>`,
          ancestors: [...ancestors, role],
        });
    }
  };
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  if (root) visit(root, 0, []);
  return lines;
}

/**
 * The pseudo-element types of backend node ids on one side. Ours are read from the whole DOM
 * (DOM.getDocument, shadow roots included); Chrome's one by one (DOM.describeNode), as asking it
 * for the whole DOM changes how it then breaks aria-owns cycles.
 */
async function pseudoTypes(side: Side, ids: number[], ours: boolean): Promise<Map<number, string>> {
  const types = new Map<number, string>();
  if (!ours) {
    for (const backendNodeId of new Set(ids)) {
      const found = await side.send('DOM.describeNode', { backendNodeId }).catch(() => null);
      if (found?.node.pseudoType) types.set(backendNodeId, found.node.pseudoType);
    }
    return types;
  }
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const visit = (node: Protocol.DOM.Node) => {
    if (node.pseudoType) types.set(node.backendNodeId, node.pseudoType);
    for (const child of [
      ...(node.pseudoElements ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.children ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
    ])
      visit(child);
  };
  visit(root);
  return types;
}

/**
 * One side's whole tree as getFullAXTree lists its nodes, in that order: each node's depth (by
 * parentId), role, name, whether it is ignored, and the pseudo-element its backendDOMNodeId is,
 * if it is one (a list marker's ::marker, generated content's ::before or ::after). Inline text
 * boxes are left out, as in fullTree. `ours`: whether the side is ours.
 */
export async function listedTree(side: Side, ours: boolean): Promise<string[]> {
  const { nodes } = await side.send('Accessibility.getFullAXTree', {});
  const types = await pseudoTypes(
    side,
    nodes.flatMap(n => (n.backendDOMNodeId === undefined ? [] : [n.backendDOMNodeId])),
    ours
  );
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const depthOf = (node: Protocol.Accessibility.AXNode): number => {
    let depth = 0;
    for (let p = byId.get(node.parentId ?? ''); p && depth < nodes.length; p = byId.get(p.parentId ?? '')) depth++;
    return depth;
  };
  return nodes
    .filter(n => n.role?.value !== 'InlineTextBox')
    .map(n => {
      const name = n.name?.value ? `:${JSON.stringify(String(n.name.value))}` : '';
      const pseudo = n.backendDOMNodeId === undefined ? undefined : types.get(n.backendDOMNodeId);
      return `${depthOf(n)} ${String(n.role?.value)}${name}${n.ignored ? ' (ignored)' : ''}${pseudo ? ` ::${pseudo}` : ''}`;
    });
}

/** The kinds a whole-tree difference falls into, by what the line's node is and where it is. */
export type TreeDiffKind = 'ListMarker' | 'MenuListPopup/option' | 'input inner generic' | 'svg title text' | 'other';

export function treeDiffKind(line: TreeLine): TreeDiffKind {
  const role = line.text.trim().split(/[: ]/)[0] ?? '';
  if (role === 'ListMarker' || line.ancestors.includes('ListMarker')) return 'ListMarker';
  if (/^MenuList(Popup|Option)$/.test(role) || line.ancestors.includes('MenuListPopup')) return 'MenuListPopup/option';
  // An input's own subtree: a text field's inner editor, a date field's parts.
  const inputs = ['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider', 'Date', 'DateTime', 'InputTime'];
  if (inputs.some(r => line.ancestors.includes(r))) return 'input inner generic';
  const svg = ['SvgRoot', 'graphics-document', 'graphics-symbol', 'graphics-object'];
  if (svg.includes(role) || svg.some(r => line.ancestors.includes(r))) return 'svg title text';
  return 'other';
}

/** The lines only one side has, by a longest common subsequence of the two outlines. */
export function treeDiff(ours: TreeLine[], chrome: TreeLine[]): { side: 'ours' | 'chrome'; line: TreeLine }[] {
  const n = ours.length;
  const m = chrome.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] ?? new Uint32Array(0);
    for (let j = m - 1; j >= 0; j--)
      row[j] = ours[i]?.text === chrome[j]?.text ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const out: { side: 'ours' | 'chrome'; line: TreeLine }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const a = ours[i];
    const b = chrome[j];
    if (a && b && a.text === b.text) {
      i++;
      j++;
    } else if (b && (!a || at(i, j + 1) >= at(i + 1, j))) {
      out.push({ side: 'chrome', line: b });
      j++;
    } else if (a) {
      out.push({ side: 'ours', line: a });
      i++;
    }
  }
  return out;
}
