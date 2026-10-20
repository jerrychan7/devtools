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
      </div>
      <div id="bm-fixed" style="position:fixed;left:30px;top:40px;width:50px;height:20px;border:2px solid;padding:3px;margin:4px;transform:rotate(10deg)"></div>
      <div id="bm-scroller" style="margin-top:20px;height:100px;width:200px;overflow:auto;border:3px solid">
        <div style="height:300px"><div id="bm-scrolled" style="margin-top:150px;margin-left:10px;width:40px;height:20px;transform:rotate(20deg)"></div></div>
      </div>
      <div style="transform:rotate(15deg);margin:10px;width:300px"><div style="padding:5px"><div id="bm-between" style="width:40px;height:20px;margin:7px;transform:scale(1.2)"></div></div></div>
      <div style="perspective:200px;width:200px;height:100px;margin:20px"><div id="bm-perspective" style="width:100px;height:50px;margin:10px;transform:rotateY(40deg)"></div></div>
      <div style="perspective:300px;perspective-origin:10% 20%;width:200px;height:120px"><div style="transform-style:preserve-3d;transform:rotateX(20deg);width:150px;height:100px"><div id="bm-preserve" style="width:60px;height:40px;transform:rotateY(30deg) translateZ(20px)"></div></div></div>
      <div style="transform:rotateX(30deg);width:150px;height:60px"><div id="bm-flat" style="width:60px;height:40px;transform:rotateY(30deg)"></div></div>
      <svg width="200" height="120" style="margin:5px;border:1px solid" viewBox="0 0 100 60"><g transform="translate(10 5)"><rect id="bm-svg-rect" x="5" y="6" width="30" height="20" stroke="black" stroke-width="4"/><circle id="bm-svg-circle" cx="60" cy="30" r="10" transform="rotate(30)"/></g></svg>
      <div style="width:120px;transform:rotate(10deg)"><span id="bm-inline" style="padding:2px;border:1px solid">some words that wrap over lines here</span></div>`
    )
  );
  await t.page.evaluate(() => {
    scrollTo(0, 25);
    const scroller = document.getElementById('bm-scroller');
    if (scroller) scroller.scrollTop = 60;
  });
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

for (const id of [
  'bm-plain',
  'bm-scale',
  'bm-rotate',
  'bm-ancestor',
  'bm-fixed',
  'bm-scrolled',
  'bm-between',
  'bm-perspective',
  'bm-preserve',
  'bm-flat',
  'bm-svg-rect',
  'bm-svg-circle',
  'bm-inline',
]) {
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

test('getBoxModel matches Chrome under a positioned, transformed body', async () => {
  await t.page.evaluate(() => {
    document.body.style.cssText = 'position:relative;left:5px;top:7px;transform:rotate(5deg)';
  });
  try {
    for (const id of ['bm-plain', 'bm-between', 'bm-scrolled']) {
      const ours = await t.ours.send('DOM.getBoxModel', { nodeId: await nodeId(t.ours, `#${id}`) });
      const chrome = await t.chrome.send('DOM.getBoxModel', { nodeId: await nodeId(t.chrome, `#${id}`) });
      assert.equal(ours.model.width, chrome.model.width);
      for (const box of ['content', 'border', 'margin'] as const)
        close(ours.model[box], chrome.model[box], `${id} ${box}`);
    }
  } finally {
    await t.page.evaluate(() => document.body.style.removeProperty('cssText'));
    await t.page.evaluate(() => document.body.removeAttribute('style'));
  }
});

test('getContentQuads of an inline element leaves out its padding and border like Chrome', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div style="width:120px"><span id="bm-inline-flat" style="padding:2px;border:1px solid">some words that wrap over lines here</span></div>'
    )
  );
  const oq = await t.ours.send('DOM.getContentQuads', { nodeId: await nodeId(t.ours, '#bm-inline-flat') });
  const cq = await t.chrome.send('DOM.getContentQuads', { nodeId: await nodeId(t.chrome, '#bm-inline-flat') });
  assert.equal(oq.quads.length, cq.quads.length);
  oq.quads.forEach((q, i) => close(q, cq.quads[i] ?? [], 'quad'));
});

test('getBoxModel and getContentQuads match Chrome for SVG, sticky, calc() and 45° inline layouts', async () => {
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<svg width="300" height="200" viewBox="0 0 150 100" style="border:2px solid;padding:3px;display:block">
        <g id="sv-g" transform="translate(10 10)" stroke="black" stroke-width="6"><rect x="0" y="0" width="20" height="10"/><line id="sv-square" x1="40" y1="5" x2="80" y2="5" stroke-linecap="square"/></g>
        <path id="sv-miter" d="M 10 50 L 30 90 L 50 50" stroke="red" stroke-width="4" fill="none"/>
        <path id="sv-round" d="M 60 50 L 80 90 L 100 50" stroke="red" stroke-width="4" stroke-linejoin="round" fill="none"/>
        <polyline id="sv-bevel" points="110 50 120 90 130 50" stroke="red" stroke-width="4" stroke-linejoin="bevel" stroke-linecap="round" fill="none"/>
        <line id="sv-butt" x1="5" y1="95" x2="60" y2="95" stroke="blue" stroke-width="4"/>
        <text id="sv-text" x="5" y="20" font-size="10">Hello</text>
        <text id="sv-text2" x="70" y="20" font-size="20">Wy</text>
        <g id="sv-g-degenerate"><rect x="5" y="60" width="10" height="10"/><g transform="scale(0)"><rect x="0" y="0" width="5" height="5"/></g></g>
        <svg id="sv-inner" x="100" y="0" width="40" height="40" viewBox="0 0 10 10"><rect id="sv-inner-rect" x="1" y="1" width="4" height="4"/></svg>
      </svg>
      <svg id="sv-root" width="100" height="60" style="margin:10px;border:1px solid;padding:4px;transform:rotate(20deg)" viewBox="0 0 50 30" preserveAspectRatio="xMinYMid meet"><rect id="sv-root-rect" x="5" y="5" width="10" height="10"/></svg>
      <div style="perspective:300px;margin:20px;width:300px"><div style="transform:rotateY(30deg)"><svg id="sv-3d" width="100" height="60" style="display:block"><rect id="sv-3d-rect" x="5" y="5" width="20" height="10"/></svg></div></div>
      <div style="height:100px;overflow:auto" id="sticky-scroller"><div style="height:30px"></div><div id="sticky" style="position:sticky;top:0;transform:rotate(5deg)"><div id="sticky-in" style="width:30px;height:10px;transform:scale(1.5)"></div></div><div style="height:500px"></div></div>
      <div id="calc" style="width:40px;height:20px;translate:calc(50% + 10px) calc(10px - 25%);rotate:10deg"></div>
      <div style="width:120px;transform:rotate(45deg)"><span id="inline-45" style="padding:2px;border:1px solid">some words that wrap over lines here</span></div>
      <div id="rotate-axis" style="width:40px;height:20px;rotate:x 45deg"></div>
      <div id="rotate-vector" style="width:40px;height:20px;rotate:1 1 0 30deg"></div>
      <div style="writing-mode:vertical-rl;height:120px"><span id="inline-vertical" style="padding:6px 2px 4px 8px;border:1px solid">some words that wrap over lines here</span></div>
      <div style="height:200px"><!-- keeps #inline-45 off the end of the scrolled page --></div>`
    );
    const scroller = document.getElementById('sticky-scroller');
    if (scroller) scroller.scrollTop = 80;
  });
  const failures: string[] = [];
  for (const id of [
    'sv-g',
    'sv-g-degenerate',
    'sv-square',
    'sv-miter',
    'sv-round',
    'sv-bevel',
    'sv-butt',
    'sv-text',
    'sv-text2',
    'sv-inner',
    'sv-inner-rect',
    'sv-root',
    'sv-root-rect',
    'sv-3d',
    'sv-3d-rect',
    'sticky',
    'sticky-in',
    'calc',
    'inline-45',
    'rotate-axis',
    'rotate-vector',
    'inline-vertical',
  ]) {
    try {
      const ours = await t.ours.send('DOM.getBoxModel', { nodeId: await nodeId(t.ours, `#${id}`) });
      const chrome = await t.chrome.send('DOM.getBoxModel', { nodeId: await nodeId(t.chrome, `#${id}`) });
      assert.deepEqual([ours.model.width, ours.model.height], [chrome.model.width, chrome.model.height], 'size');
      for (const box of ['content', 'padding', 'border', 'margin'] as const)
        close(ours.model[box], chrome.model[box], box);
      const oq = await t.ours.send('DOM.getContentQuads', { nodeId: await nodeId(t.ours, `#${id}`) });
      const cq = await t.chrome.send('DOM.getContentQuads', { nodeId: await nodeId(t.chrome, `#${id}`) });
      assert.equal(oq.quads.length, cq.quads.length, 'quads');
      oq.quads.forEach((q, i) => close(q, cq.quads[i] ?? [], 'quad'));
    } catch (e) {
      failures.push(`${id}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('a 45° inline element in a scrolled scroller is estimated without scrolling anything', async () => {
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="m45-scroller" style="width:150px;height:80px;overflow:auto">
        <div style="width:120px;transform:rotate(45deg);margin-top:40px"><span id="m45" style="padding:2px;border:1px solid">some words that wrap over lines here and more words too</span></div>
      </div>
      <style>#m45-important { transform: rotate(45deg) !important }</style>
      <div id="m45-important" style="width:120px"><span id="m45-in" style="padding:2px">some words that wrap over lines here</span></div>`
    );
    const scroller = document.getElementById('m45-scroller');
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.scrollLeft = scroller.scrollWidth;
    }
  });
  const before = await t.page.evaluate(async () => {
    // Let the scroll events of the scrolling above go out first.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = document.getElementById('m45-scroller');
    let events = 0;
    s?.addEventListener('scroll', () => events++);
    Reflect.set(window, '__m45Events', () => events);
    return [s?.scrollLeft, s?.scrollTop];
  });
  assert.ok((before[1] ?? 0) > 0);
  for (const id of ['m45', 'm45-in']) {
    const oq = await t.ours.send('DOM.getContentQuads', { nodeId: await nodeId(t.ours, `#${id}`) });
    // #m45 sticks out at the end its scroller is scrolled to, so its quads are estimated from the
    // client rectangles rather than measured, and not compared with Chrome's.
    assert.ok(oq.quads.length > 0, id);
  }
  await new Promise(r => setTimeout(r, 100));
  const after = await t.page.evaluate(() => {
    const s = document.getElementById('m45-scroller');
    const events: unknown = Reflect.get(window, '__m45Events');
    return [s?.scrollLeft, s?.scrollTop, typeof events === 'function' ? events() : -1];
  });
  assert.deepEqual(after, [...before, 0]);
});

test('a 45° inline element on an unscrolled page is measured like Chrome', async () => {
  const scroll = await t.page.evaluate(() => {
    const y = scrollY;
    scrollTo(0, 0);
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<div style="width:120px;transform:rotate(45deg)"><span id="m45-top" style="padding:2px;border:1px solid">some words that wrap over lines here</span></div>`
    );
    return y;
  });
  try {
    const oq = await t.ours.send('DOM.getContentQuads', { nodeId: await nodeId(t.ours, '#m45-top') });
    const cq = await t.chrome.send('DOM.getContentQuads', { nodeId: await nodeId(t.chrome, '#m45-top') });
    assert.equal(oq.quads.length, cq.quads.length);
    oq.quads.forEach((q, i) => close(q, cq.quads[i] ?? [], 'quad'));
  } finally {
    await t.page.evaluate(y => {
      document.getElementById('m45-top')?.parentElement?.remove();
      scrollTo(0, y);
    }, scroll);
  }
});
