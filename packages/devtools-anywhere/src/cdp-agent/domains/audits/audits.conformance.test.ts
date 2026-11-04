import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSubset, launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';
import type { Protocol } from 'devtools-protocol';

let env: Env | undefined;
before(async () => {
  env = await launch();
});
after(() => env?.close());

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (const start = Date.now(); Date.now() - start < 5000; await new Promise(r => setTimeout(r, 20))) {
    const value = await read();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The `data-k` of the node a backend node id names on one side, for comparing the two. */
async function keyOf(side: Side, backendNodeId: number | undefined): Promise<string | undefined> {
  if (backendNodeId === undefined) return undefined;
  const { object } = await side.send('DOM.resolveNode', { backendNodeId });
  if (!object.objectId) return undefined;
  const { result } = await side.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { return this.dataset?.k ?? this.nodeName; }',
    returnByValue: true,
  });
  return String(result.value);
}

/** One side's issues of a code, each with the node it names as its `data-k`, in a stable order. */
async function issuesOf(side: Side, code: Protocol.Audits.InspectorIssueCode, count: number) {
  const issues = await until(async () => {
    const all = (await side.events('Audits.issueAdded')).map(e => e.issue).filter(i => i.code === code);
    return all.length >= count ? all : undefined;
  }, `${count} ${code}`);
  const keyed = [];
  for (const issue of issues) {
    const generic = issue.details.genericIssueDetails;
    const node = generic?.violatingNodeId;
    keyed.push({ issue, node: await keyOf(side, node) });
  }
  return keyed
    .map(({ issue, node }) => ({ ...issue, node }))
    .sort((a, b) => JSON.stringify([a.node, a.details]).localeCompare(JSON.stringify([b.node, b.details])));
}

const VOLATILE_DETAILS = (issues: unknown[]) =>
  JSON.parse(
    JSON.stringify(issues, (key, value: unknown) =>
      ['violatingNodeId', 'documentNodeId', 'frameId', 'loaderId', 'scriptId'].includes(key) ? undefined : value
    )
  );

describe('Audits', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, ['Audits.issueAdded']);
    await t.chrome.send('Audits.enable');
    await t.ours.send('Audits.enable');
  });

  test('form issues match Chrome', async () => {
    await t.page.evaluate(`document.body.insertAdjacentHTML('beforeend', \`
      <form>
        <input data-k="dup1" id="dup" name="a"><input data-k="dup2" id="dup">
        <input data-k="noname"><select data-k="sel"></select>
        <input data-k="hidden" type="hidden"><input type="submit">
        <input data-k="ac" name="q" autocomplete="">
        <label data-k="nofor">x</label>
        <label data-k="missing" for="nothere">y</label>
        <label data-k="byname" for="q">z</label>
        <label data-k="nested">n<input name="n"></label>
      </form>\`)`);
    const chrome = await issuesOf(t.chrome, 'GenericIssue', 7);
    await new Promise(r => setTimeout(r, 300));
    const ours = await issuesOf(t.ours, 'GenericIssue', 7);
    assert.deepEqual(diffSubset(VOLATILE_DETAILS(ours), VOLATILE_DETAILS(chrome)), []);
  });

  test('deprecations match Chrome', async () => {
    await t.page.evaluate('window.webkitRequestAnimationFrame(() => {})');
    const [chrome] = await issuesOf(t.chrome, 'DeprecationIssue', 1);
    const [ours] = await issuesOf(t.ours, 'DeprecationIssue', 1);
    assert.deepEqual(diffSubset(VOLATILE_DETAILS([ours]), VOLATILE_DETAILS([chrome])), []);
  });

  test('quirks mode documents match Chrome', async () => {
    await t.page.evaluate(`(() => {
      for (const html of ['<p>quirks</p>', '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><p>limited</p>']) {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        frame.contentDocument.open();
        frame.contentDocument.write(html);
        frame.contentDocument.close();
      }
    })()`);
    const chrome = await issuesOf(t.chrome, 'QuirksModeIssue', 2);
    // A change in an iframe's own document is not one of the page's mutations: a later one is.
    await t.page.evaluate('document.body.append(document.createElement("i"))');
    const ours = await issuesOf(t.ours, 'QuirksModeIssue', 2);
    assert.deepEqual(diffSubset(VOLATILE_DETAILS(ours), VOLATILE_DETAILS(chrome)), []);
  });

  test('Content Security Policy violations match Chrome', async () => {
    await t.page.evaluate(`(() => {
      document.head.insertAdjacentHTML('beforeend', '<meta http-equiv="Content-Security-Policy" content="img-src \\'self\\'">');
      document.body.insertAdjacentHTML('beforeend', '<img src="https://example.com/x.png">');
    })()`);
    const [chrome] = await issuesOf(t.chrome, 'ContentSecurityPolicyIssue', 1);
    const [ours] = await issuesOf(t.ours, 'ContentSecurityPolicyIssue', 1);
    assert.deepEqual(diffSubset(VOLATILE_DETAILS([ours]), VOLATILE_DETAILS([chrome])), []);
  });

  test('issues found before enabling are sent on enable', async () => {
    await t.ours.clear();
    await t.ours.send('Audits.disable');
    await t.ours.send('Audits.enable');
    const codes = new Set((await t.ours.events('Audits.issueAdded')).map(e => e.issue.code));
    assert.deepEqual([...codes].sort(), [
      'ContentSecurityPolicyIssue',
      'DeprecationIssue',
      'GenericIssue',
      'QuirksModeIssue',
    ]);
  });
});
