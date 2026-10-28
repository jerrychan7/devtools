import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from './server.ts';
import type { PlaygroundServer } from './server.ts';

let server: PlaygroundServer | undefined;

before(async () => {
  server = await startServer(0);
});
after(() => server?.close());

function get(pathname: string): Promise<number> {
  if (!server) throw new Error('server not started');
  return fetch(new URL(pathname, server.url)).then(r => r.status);
}

test('malformed percent-encoding answers 400 instead of crashing', async () => {
  assert.equal(await get('/%E0%A4'), 400);
  // The server is still up.
  assert.equal(await get('/%E0%A4'), 400);
});

test('a sibling directory sharing the root as a prefix is out of bounds', async () => {
  const sibling = `${path.basename(path.resolve(import.meta.dirname, '..'))}-sibling`;
  assert.equal(await get(`/..%2f${sibling}/x`), 403);
});
