/**
 * The scripts the lexer benchmarks run on: acorn's build from node_modules, the DevTools front
 * end's largest bundle from the front-end package's build output, and a REPL-sized input. Neither
 * file is in git: both are located here, and the report names the version or hash it ran on.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where extracted lexer revisions are kept; ignored by git (`*.ignore`). */
export const cacheDir = fileURLToPath(new URL('./cache.ignore/', import.meta.url));

export interface Material {
  name: string;
  /** Where it comes from and what is in it, for the report. */
  about: string;
  text: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** A line typed in the console: destructuring, a template, a regular expression, `typeof`. */
export const REPL = 'const {a, b: [c]} = await fetch(`/x/${id}`).then(r => r.json()); let re = /a\\/b/g; typeof foo; x';

/** acorn's dist/acorn.js (8.19.0: 246,615 code units), a devDependency of the package. */
function acorn(): Material {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('acorn/package.json');
  const version = (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
  const text = readFileSync(join(dirname(pkg), 'dist/acorn.js'), 'utf8');
  return {
    name: 'acorn.js',
    about: `acorn ${version} dist/acorn.js from node_modules`,
    text,
  };
}

/**
 * packages/devtools-frontend/dist/bundle/anywhere_app-*.js, the front end's 7 MB bundle, built by
 * `pnpm --filter @devtools-anywhere/devtools-frontend run build:frontend` (ignored by git). A git
 * worktree without the build output looks in the main checkout. The reference results were taken
 * on anywhere_app-BWStrK_m.js, 7,356,685 code units, SHA-256 4d6737bd…78e57b.
 */
function anywhereApp(): Material | undefined {
  const roots = [join(here, '../../../../../..')];
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: here,
      encoding: 'utf8',
    });
    const main = /^worktree (.+)$/m.exec(list)?.[1];
    if (main !== undefined) roots.push(main);
  } catch {
    // Not in git: this checkout only.
  }
  for (const root of roots) {
    const dir = join(root, 'packages/devtools-frontend/dist/bundle');
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find(f => /^anywhere_app-.*\.js$/.test(f));
    if (file === undefined) continue;
    const bytes = readFileSync(join(dir, file));
    const sum = createHash('sha256').update(bytes).digest('hex');
    return {
      name: 'anywhere_app',
      about: `${file}, SHA-256 ${sum.slice(0, 8)}…${sum.slice(-6)}`,
      text: bytes.toString('utf8'),
    };
  }
  console.warn('anywhere_app: no packages/devtools-frontend/dist/bundle/anywhere_app-*.js; build the front end first');
  return undefined;
}

export function materials(): Material[] {
  const app = anywhereApp();
  return [
    {
      name: 'repl',
      about: `${REPL.length} code units typed in the console`,
      text: REPL,
    },
    acorn(),
    ...(app ? [app] : []),
  ];
}
