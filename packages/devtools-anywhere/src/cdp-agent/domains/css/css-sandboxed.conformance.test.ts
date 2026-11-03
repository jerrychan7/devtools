// A sandboxed iframe without allow-same-origin, on the page's origin, merged into the page's agent
// (core/merged-frames.ts), in the CSS domain, against Chrome, which keeps it in the page's
// target: its style sheets announced on the page's session with its frame id, the styles of its
// nodes, and the editing of its rules. The sandboxed node is reached through Runtime (its
// context) and DOM.requestNode.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/merged-sides.ts';

let env: Env | undefined;
let ours: MergedSide | undefined;
let chrome: MergedSide | undefined;

const RULE = '#target { color: rgb(1, 2, 3); }';

before(async () => {
  env = await launchOopif();
  chrome = await chromeSide(env);
  ours = await oursSide(env);
});
after(async () => {
  await ours?.close();
  await chrome?.close();
  await env?.close();
});

/** The sandboxed frame's id, from the page's frame tree. */
async function sandboxedFrameId(side: MergedSide): Promise<string> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const id = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  assert.equal(typeof id, 'string');
  return String(id);
}

/** Evaluates `expression` in the sandboxed frame's latest execution context. */
async function evaluate(side: MergedSide, expression: string, returnByValue = true): Promise<unknown> {
  const frameId = await sandboxedFrameId(side);
  const created = (await side.events()).findLast(
    e =>
      e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === frameId
  );
  const contextId = get(created?.params['context'], 'id');
  assert.equal(typeof contextId, 'number', 'the sandboxed frame has an execution context');
  const reply = await side.send('Runtime.evaluate', { expression, contextId, returnByValue });
  return get(reply, 'result');
}

/** The nodeId of the sandboxed frame's #target. */
async function targetNode(side: MergedSide): Promise<number> {
  await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const objectId = get(await evaluate(side, "document.getElementById('target')", false), 'objectId');
  const reply = await side.send('DOM.requestNode', { objectId });
  const nodeId = get(reply, 'nodeId');
  assert.equal(typeof nodeId, 'number', String(reply));
  return Number(nodeId);
}

interface SetUp {
  frameId: string;
  nodeId: number;
  sheetId: string;
}

/** A sheet of the sandboxed frame, added after CSS.enable, and the nodeId of its #target. */
async function setUp(side: MergedSide): Promise<SetUp> {
  const frameId = await sandboxedFrameId(side);
  await side.send('DOM.getDocument', { depth: -1, pierce: true });
  await side.send('CSS.enable');
  await evaluate(
    side,
    // Chrome announces a sheet at the next style update, which a background page may not have.
    `document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(RULE)} }));` +
      "getComputedStyle(document.getElementById('target')).color"
  );
  let added;
  for (let i = 0; i < 50 && !added; i++, await new Promise(r => setTimeout(r, 100)))
    added = (await side.events()).findLast(
      e => e.method === 'CSS.styleSheetAdded' && get(e.params['header'], 'frameId') === frameId
    );
  assert.ok(added, "the sandboxed frame's style sheet is announced with its frame id");
  const sheetId = get(added.params['header'], 'styleSheetId');
  assert.equal(typeof sheetId, 'string');
  return { frameId, nodeId: await targetNode(side), sheetId: String(sheetId) };
}

const sides = new Map<MergedSide, SetUp>();

function setUpOf(side: MergedSide): SetUp {
  const set = sides.get(side);
  assert.ok(set, 'set up by the first test');
  return set;
}

test("CSS.styleSheetAdded of the sandboxed frame's sheet carries its frame id, as in Chrome", async () => {
  const headers = [];
  for (const side of [chrome, ours]) {
    assert.ok(side);
    const set = await setUp(side);
    sides.set(side, set);
    const added = (await side.events()).findLast(
      e => e.method === 'CSS.styleSheetAdded' && get(e.params['header'], 'styleSheetId') === set.sheetId
    );
    const header = added?.params['header'];
    headers.push({
      origin: get(header, 'origin'),
      isInline: get(header, 'isInline'),
      text: get(await side.send('CSS.getStyleSheetText', { styleSheetId: set.sheetId }), 'text'),
    });
  }
  assert.deepEqual(headers[1], headers[0]);
  assert.deepEqual(headers[0], { origin: 'regular', isInline: false, text: RULE });
});

/**
 * A style's declared properties, by name and value: its cssText, which we rebuild normalized for
 * every sheet (style.ts) where Chrome keeps the source's spacing, is no matter of the merge.
 */
function declared(style: unknown): unknown {
  const properties = get(style, 'cssProperties');
  assert.ok(Array.isArray(properties));
  return properties
    .filter(p => get(p, 'range') !== undefined)
    .map(p => `${String(get(p, 'name'))}: ${String(get(p, 'value'))}`);
}

/** The selectors and declarations of the regular rules matching #target. */
async function matched(side: MergedSide): Promise<unknown> {
  const set = setUpOf(side);
  const reply = await side.send('CSS.getMatchedStylesForNode', { nodeId: set.nodeId });
  const rules = get(reply, 'matchedCSSRules');
  assert.ok(Array.isArray(rules), String(reply));
  return rules
    .map(match => get(match, 'rule'))
    .filter(rule => get(rule, 'origin') === 'regular')
    .map(rule => ({
      selector: get(get(rule, 'selectorList'), 'text'),
      sheet: get(rule, 'styleSheetId') === set.sheetId,
      declared: declared(get(rule, 'style')),
    }));
}

/** #target's computed color. */
async function color(side: MergedSide): Promise<unknown> {
  const set = setUpOf(side);
  const computed = get(await side.send('CSS.getComputedStyleForNode', { nodeId: set.nodeId }), 'computedStyle');
  assert.ok(Array.isArray(computed));
  return get(
    computed.find(p => get(p, 'name') === 'color'),
    'value'
  );
}

test('CSS.getMatchedStylesForNode of a sandboxed node, as in Chrome', async () => {
  const results = [];
  for (const side of [chrome, ours]) {
    assert.ok(side);
    results.push({ rules: await matched(side), color: await color(side) });
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[0], {
    rules: [{ selector: '#target', sheet: true, declared: ['color: rgb(1, 2, 3)'] }],
    color: 'rgb(1, 2, 3)',
  });
});

test("CSS.setStyleTexts on the sandboxed frame's rule, as in Chrome", async () => {
  const results = [];
  for (const side of [chrome, ours]) {
    assert.ok(side);
    const set = setUpOf(side);
    const reply = await side.send('CSS.setStyleTexts', {
      edits: [
        {
          styleSheetId: set.sheetId,
          range: { startLine: 0, startColumn: 9, endLine: 0, endColumn: 31 },
          text: ' color: rgb(4, 5, 6); ',
        },
      ],
    });
    const styles = get(reply, 'styles');
    assert.ok(Array.isArray(styles), String(reply));
    results.push({
      declared: declared(styles[0]),
      color: await color(side),
      text: get(await side.send('CSS.getStyleSheetText', { styleSheetId: set.sheetId }), 'text'),
      rules: await matched(side),
    });
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0]?.color, 'rgb(4, 5, 6)');
});
