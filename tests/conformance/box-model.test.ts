import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';
import type { Env, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="bm-host" style="position:absolute;left:300px;top:200px">
        <div id="bm-plain" style="width:50px;height:20px;margin:4px;border:2px solid;padding:3px"></div>
        <div id="bm-scale" style="width:50px;height:20px;margin:4px;border:2px solid;padding:3px;transform:scale(2);translate:10% 50%"></div>
        <div id="bm-rotate" style="width:50px;height:20px;margin:4px;border:2px solid;padding:3px;transform:rotate(30deg)"></div>
        <div style="transform:rotate(-20deg) translate(10px,5px)">
          <div id="bm-ancestor" style="width:40px;height:30px;margin:6px;border:1px solid;padding:2px;transform:scale(1.5)"></div>
        </div>
      </div>`
    )
  );
});
after(() => env?.close());

async function nodeId(side: TestPage['chrome'], selector: string) {
  const { root } = await side.send('DOM.getDocument', { depth: 0 });
  return (await side.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
}

const close = (ours: number[], chrome: number[], what: string) => {
  assert.equal(ours.length, chrome.length, what);
  ours.forEach((v, i) => assert.ok(Math.abs(v - (chrome[i] ?? NaN)) <= 0.5, `${what}[${i}]: ${v} vs ${chrome[i]}`));
};

for (const id of ['bm-plain', 'bm-scale', 'bm-rotate', 'bm-ancestor']) {
  test(`getBoxModel and getContentQuads match Chrome: ${id}`, async () => {
    const ours = await t.ours.send('DOM.getBoxModel', { nodeId: await nodeId(t.ours, `#${id}`) });
    const chrome = await t.chrome.send('DOM.getBoxModel', { nodeId: await nodeId(t.chrome, `#${id}`) });
    assert.equal(ours.model.width, chrome.model.width);
    assert.equal(ours.model.height, chrome.model.height);
    for (const box of ['content', 'padding', 'border', 'margin'] as const)
      close(ours.model[box], chrome.model[box], box);
    const oq = await t.ours.send('DOM.getContentQuads', { nodeId: await nodeId(t.ours, `#${id}`) });
    const cq = await t.chrome.send('DOM.getContentQuads', { nodeId: await nodeId(t.chrome, `#${id}`) });
    assert.equal(oq.quads.length, cq.quads.length);
    oq.quads.forEach((q, i) => close(q, cq.quads[i] ?? [], 'quad'));
  });
}
