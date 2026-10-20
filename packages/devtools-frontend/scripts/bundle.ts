// Bundles the release files (one bundle per upstream module: ~150 requests to open DevTools)
// into a few files. What makes opening slow on HTTP/1.1 or a flaky network is the number of
// requests, not their size:
//   - each module loaded with import() (a panel, mostly) is a chunk with what only it needs,
//     loaded when it is; the entry, what several of them share, and the ones too small to be
//     worth a request are the chunk DevTools loads when it opens;
//   - each worker is a single file of its own;
//   - the SVG icons are inlined into Images.js as data: URLs (each declared once, as the CSS
//     variable every use reads);
//   - every bundled file is named after a hash of its content, so it can be cached for good:
//     only anywhere_app.html, which names the entry, must be revalidated.
// Rollup tree-shakes what nothing uses.
//
// Every bundled file lands in bundle/, one level below the root. A module's import.meta.url
// becomes the URL it had before, so that whatever it resolves against it (literals, templates,
// locales, descriptions/) still finds the same file.

import fs from 'node:fs';
import path from 'node:path';
import { rollup, type GetManualChunk, type Plugin } from 'rollup';
import { transform } from 'esbuild';

const OUT_DIR = 'bundle';
const APP = 'entrypoints/anywhere_app/anywhere_app.js';
const WORKERS = [
  'entrypoints/formatter_worker/formatter_worker-entrypoint.js',
  'entrypoints/wasmparser_worker/wasmparser_worker-entrypoint.js',
];
/** Where each worker ends up, seen from bundle/: known once the worker is bundled. */
const workerOutput = new Map<string, string>();
/** A root whose own modules are smaller than this goes into the entry chunk. */
const SMALL_ROOT = 20_000;
/** Stands for the bundled file's own import.meta.url while the others are rewritten. */
const OWN_URL = '__OWN_URL__';

/** An SVG as a data: URL, percent-encoding only what a url("…") or a data: URL cannot hold. */
const svgDataUrl = (file: string) =>
  'data:image/svg+xml,' +
  fs
    .readFileSync(file, 'utf8')
    .replace(/\s+/g, ' ')
    .replace(/[%#"<>]/g, c => encodeURIComponent(c));

/** Bundles the release files in `src` into `out` (replaced). */
export async function bundle(src: string, out: string): Promise<void> {
  const rel = (file: string) => path.relative(src, file).split(path.sep).join('/');

  const rewrite: Plugin = {
    name: 'rewrite-urls',
    resolveId(source, importer) {
      // Only the Node.js host imports node:* (core/platform/node): an empty module in a browser,
      // where a single-file worker would otherwise import it at the top.
      if (source.startsWith('node:')) return `\0${source}`;
      if (importer && source.startsWith('.')) return path.resolve(path.dirname(importer), source);
      return null;
    },
    load(id) {
      return id.startsWith('\0node:') ? 'export {};' : null;
    },
    transform(code, id) {
      const file = rel(id);
      if (file === 'Images/Images.js') {
        code = code.replace(/new URL\('\.\/([^']+\.svg)', import\.meta\.url\)\.toString\(\)/g, (_, name: string) =>
          JSON.stringify(svgDataUrl(path.join(src, 'Images', name)))
        );
      }
      // Workers are bundled on their own: point at their files.
      const entry = (spec: string) =>
        workerOutput.get(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
      code = code
        .replace(
          /new URL\((["'`])(\.{1,2}\/[^"'`]+\.js)\1,\s*import\.meta\.url\)/g,
          (whole, q: string, spec: string) => {
            const to = entry(spec);
            return to ? `new URL(${q}${to}${q},${OWN_URL})` : whole;
          }
        )
        .replace(/import\.meta\.resolve\((["'`])(\.{1,2}\/[^"'`]+\.js)\1\)/g, (whole, q: string, spec: string) => {
          const to = entry(spec);
          return to ? `new URL(${q}${to}${q},${OWN_URL}).href` : whole;
        });
      const dir = path.posix.dirname(file);
      const base = `new URL(${JSON.stringify(`../${dir === '.' ? '' : `${dir}/`}x`)},import.meta.url).href`;
      code = code.replace(/import\.meta\.resolve\(/g, `((s)=>new URL(s,${base}).href)(`);
      code = code.replace(/import\.meta\.url/g, base).replaceAll(OWN_URL, 'import.meta.url');
      // Root.Runtime#loadLegacyModule imports any file by path: left to run time (rollup would
      // otherwise try to resolve the template).
      code = code.replace('import(`../../${e}`)', 'import(e.replace(/^/, "../"))');
      return { code, map: null };
    },
  };

  const minify: Plugin = {
    name: 'minify',
    async renderChunk(code) {
      const result = await transform(code, { minify: true, target: 'es2022', legalComments: 'none', format: 'esm' });
      return { code: result.code, map: null };
    },
  };

  /**
   * The chunk of a module. Each module loaded with import() (a panel, mostly) is a root: it and
   * the modules only it needs are one chunk, loaded when it is (with the chunks of the roots it
   * imports). What the entry imports, what two or more roots need, and the roots smaller than
   * SMALL_ROOT go into the entry chunk, loaded when DevTools opens.
   */
  let chunks: Map<string, string> | undefined;
  const chunkOf: GetManualChunk = (id, { getModuleIds, getModuleInfo }) => {
    if (!chunks) {
      chunks = new Map();
      const closure = (from: string, stop: Set<string>) => {
        const seen = new Set<string>();
        const queue = [from];
        for (let next; (next = queue.pop());) {
          if (seen.has(next) || stop.has(next)) continue;
          seen.add(next);
          queue.push(...(getModuleInfo(next)?.importedIds ?? []));
        }
        return seen;
      };
      const core = closure(path.join(src, APP), new Set());
      const roots = new Set<string>();
      for (const module of getModuleIds()) {
        for (const target of getModuleInfo(module)?.dynamicallyImportedIds ?? []) {
          if (!core.has(target)) roots.add(target);
        }
      }
      const owners = new Map<string, string[]>();
      for (const root of roots) {
        // Another root is a chunk of its own, even where this one imports it statically.
        const stop = new Set([...core, ...[...roots].filter(other => other !== root)]);
        for (const module of closure(root, stop)) owners.set(module, [...(owners.get(module) ?? []), root]);
      }
      const rootSize = new Map<string, number>();
      for (const [module, [owner, ...others]] of owners) {
        if (owner && others.length === 0) {
          rootSize.set(owner, (rootSize.get(owner) ?? 0) + (getModuleInfo(module)?.code?.length ?? 0));
        }
      }
      // A merged root runs when DevTools opens: not the Node.js platform, which only Node.js can run.
      const ownChunk = (root: string) =>
        (rootSize.get(root) ?? 0) >= SMALL_ROOT || rel(root).startsWith('core/platform/node/');
      for (const module of core) chunks.set(module, 'anywhere_app');
      for (const [module, [owner, ...others]] of owners) {
        const own = owner !== undefined && others.length === 0 && ownChunk(owner);
        chunks.set(module, own ? path.posix.basename(owner, '.js') : 'anywhere_app');
      }
      // What the entry chunk imports statically must be in it too: a chunk of its own would
      // import the entry chunk back and run before it.
      const queue = [...chunks].flatMap(([module, chunk]) => (chunk === 'anywhere_app' ? [module] : []));
      for (let next; (next = queue.pop());) {
        for (const imported of getModuleInfo(next)?.importedIds ?? []) {
          if (chunks.get(imported) === 'anywhere_app') continue;
          chunks.set(imported, 'anywhere_app');
          queue.push(imported);
        }
      }
    }
    return chunks.get(id);
  };

  fs.rmSync(out, { recursive: true, force: true });
  /** Bundles `input`, and returns the name of its file in bundle/. */
  const write = async (input: string, split: boolean) => {
    const build = await rollup({
      input: path.join(src, input),
      plugins: [rewrite],
      onwarn: () => {},
      // The entry chunk may export more than the entry: no facade file of its own (a request).
      preserveEntrySignatures: 'allow-extension',
    });
    const { output } = await build.write({
      dir: path.join(out, OUT_DIR),
      format: 'es',
      entryFileNames: '[name]-[hash].js',
      chunkFileNames: '[name]-[hash].js',
      inlineDynamicImports: !split,
      ...(split ? { manualChunks: chunkOf } : {}),
      plugins: [minify],
    });
    await build.close();
    return output[0].fileName;
  };
  // The workers first: the app names their files.
  for (const worker of WORKERS) workerOutput.set(worker, `./${await write(worker, false)}`);
  const app = await write(APP, true);

  // Everything but the JS modules, and the JS files loaded by URL rather than imported.
  for (const file of fs.readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    const name = file.split(path.sep).join('/');
    if (fs.statSync(path.join(src, file)).isDirectory()) continue;
    if (name.endsWith('.js') && !name.includes('.generated.')) continue;
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(path.join(src, file), path.join(out, file));
  }
  const html = path.join(out, 'anywhere_app.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(`./${APP}`, `./${OUT_DIR}/${app}`));
}
