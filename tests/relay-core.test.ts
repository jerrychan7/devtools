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
