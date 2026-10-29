// The remote server's command line, devtools-anywhere-remote: its options reach the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/remote-server/dist/cli.js', import.meta.url));

/** Runs the CLI with `args` until it has printed the script tag (or exits), and returns its output. */
function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${out}`));
    }, 10000);
    const done = () => {
      clearTimeout(timer);
      child.kill();
      resolve(out);
    };
    child.stdout.on('data', chunk => {
      out += String(chunk);
      if (out.includes('</script>')) done();
    });
    child.on('exit', done);
  });
}

test('--id-in-query makes pages connect with the target in the query', async () => {
  const out = await run(['--port', '0', '--host', '127.0.0.1', '--no-token', '--id-in-query']);
  assert.match(out, /<script src="[^"]*probe\.iife\.js" data-remote data-id-in-query><\/script>/);
});

test('without it, pages connect by path', async () => {
  const out = await run(['--port', '0', '--host', '127.0.0.1', '--no-token']);
  assert.match(out, /probe\.iife\.js" data-remote><\/script>/);
});

test('--help lists --id-in-query', async () => {
  assert.match(await run(['--help']), /--id-in-query/);
});
