import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { createRemoteHandler } from '@devtools-anywhere/remote-server';

/** An upgrade request for `url`, and what was written to its socket. */
function upgrade(handler: ReturnType<typeof createRemoteHandler>, url: string) {
  const written: string[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  });
  const req = new IncomingMessage(new Socket());
  req.url = url;
  const handled = handler.handleUpgrade(req, socket, Buffer.alloc(0));
  socket.destroy();
  return { handled, written: written.join('') };
}

test("with singlePath, the base path short of its slash is left to the host's own socket", () => {
  const handler = createRemoteHandler({ basePath: '/devtools/', token: false, singlePath: true });
  assert.equal(upgrade(handler, '/devtools').handled, false);
  assert.equal(upgrade(handler, '/devtools?other=1').handled, false);
  // With the target in the query it is the relay's.
  assert.equal(upgrade(handler, '/devtools?client=missing').handled, true);
  // The base path itself is the relay's either way.
  const own = upgrade(handler, '/devtools/');
  assert.equal(own.handled, true);
  assert.match(own.written, /404/);
  handler.close();
});
