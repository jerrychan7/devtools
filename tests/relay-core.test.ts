import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayCore, type Frame, type Session } from '../packages/relay-core/dist/index.js';

/** A relay whose page is always reachable, recording what it delivers. */
class FakeRelay extends RelayCore {
  readonly delivered: string[] = [];
  readonly received: string[] = [];
  readonly session: Session = this.openSession({ send: message => this.received.push(message) });
  protected canDeliver() {
    return true;
  }
  protected deliver(_session: Session | undefined, data: string) {
    this.delivered.push(data);
  }
  protected frame(): Frame {
    return { id: 'f', url: 'https://example.com/', secure: true };
  }
  say(loaderId: string) {
    this.hello(loaderId);
  }
  hide() {
    this.pagehide();
  }
  fromClient(data: object) {
    this.clientMessage(this.session, JSON.stringify(data));
  }
}

for (const [name, next] of [
  ['back from the back/forward cache', 'l1'],
  ['replaced by a new instance', 'l2'],
] as const) {
  test(`a held Debugger.enable disabled since is failed, not sent to the page ${name}`, () => {
    const relay = new FakeRelay();
    relay.say('l1');
    relay.hide();
    relay.fromClient({ id: 1, method: 'Debugger.enable' });
    relay.fromClient({ id: 2, method: 'Debugger.disable' });
    assert.deepEqual(
      relay.received.map(message => JSON.parse(message) as unknown),
      [1, 2].map(id => ({ id, error: { code: -32000, message: 'Inspected target navigated or closed' } }))
    );
    relay.say(next);
    assert.ok(!relay.delivered.some(message => message.includes('"method":"Debugger.enable"')));
  });
}

/** The relay with the page's messages to the session too. */
class PageRelay extends FakeRelay {
  fromPage(data: object) {
    this.pageMessage(this.session, JSON.stringify(data));
  }
}

const json = (messages: string[]) => messages.map(message => JSON.parse(message) as unknown);

test("a child target's messages pass through as they are, its responses back to the frontend", () => {
  const relay = new PageRelay();
  relay.say('l1');
  const command = { id: 1, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'S1' };
  relay.fromClient(command);
  assert.deepEqual(json(relay.delivered), [command]);
  relay.fromPage({ id: 1, result: {}, sessionId: 'S1' });
  relay.fromPage({ method: 'Runtime.consoleAPICalled', params: {}, sessionId: 'S2' });
  assert.deepEqual(json(relay.received), [
    { id: 1, result: {}, sessionId: 'S1' },
    { method: 'Runtime.consoleAPICalled', params: {}, sessionId: 'S2' },
  ]);
});

test("a new page instance replays none of a child target's enables, and detaches the page's child targets", () => {
  const relay = new PageRelay();
  relay.say('l1');
  relay.fromClient({ id: 1, method: 'Page.enable' });
  relay.fromClient({ id: 2, method: 'Runtime.enable', sessionId: 'S1' });
  relay.fromClient({ id: 3, method: 'Debugger.enable', sessionId: 'S1' });
  const info = (targetId: string) => ({ targetId, type: 'iframe', title: '', url: '', attached: true });
  relay.fromPage({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', targetInfo: info('F1') } });
  // The child's own child: its parent's to detach, which goes with the page.
  relay.fromPage({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'S2', targetInfo: info('F2') },
    sessionId: 'S1',
  });
  relay.fromPage({ method: 'Target.attachedToTarget', params: { sessionId: 'S3', targetInfo: info('F3') } });
  relay.fromPage({ method: 'Target.detachedFromTarget', params: { sessionId: 'S3', targetId: 'F3' } });
  relay.hide();
  relay.fromClient({ id: 4, method: 'Runtime.evaluate', sessionId: 'S1' });
  relay.received.length = 0;
  relay.delivered.length = 0;
  relay.say('l2');
  const received = json(relay.received);
  assert.deepEqual(received[0], { method: 'Target.detachedFromTarget', params: { sessionId: 'S1', targetId: 'F1' } });
  assert.equal(received.filter(m => JSON.stringify(m).includes('detachedFromTarget')).length, 1);
  assert.deepEqual(
    json(relay.delivered).map(m => Reflect.get(Object(m), 'method')),
    ['Page.enable']
  );
});

test("a child target's commands between page instances fail, and none is held", () => {
  const relay = new PageRelay();
  relay.say('l1');
  relay.fromClient({ id: 1, method: 'Debugger.enable', sessionId: 'S1' });
  relay.hide();
  relay.fromClient({ id: 2, method: 'Debugger.enable', sessionId: 'S1' });
  const error = { code: -32000, message: 'Inspected target navigated or closed' };
  assert.deepEqual(json(relay.received), [
    { id: 1, error },
    { id: 2, error },
  ]);
  relay.delivered.length = 0;
  relay.say('l2');
  assert.deepEqual(relay.delivered, []);
});
