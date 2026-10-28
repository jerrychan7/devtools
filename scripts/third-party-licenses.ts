// Writes THIRD_PARTY_LICENSES.md at the repo root and in every package whose build contains
// third-party code (`pnpm licenses:update`). The output depends only on the inputs below, so
// running it again without changes leaves the files untouched.
//
// Inputs:
//   - the es-module-lexer license (embedded below: the port lives in packages/devtools-anywhere/src/cdp-agent)
//   - @zumer/snapdom from node_modules
//   - the devtools-frontend checkout at packages/devtools-frontend/REVISION, for the DevTools
//     license and the README.chromium + LICENSE of every library under front_end/third_party
//     that ends up in packages/devtools-frontend/dist (which must be built: the frontend build
//     lists those libraries in packages/devtools-frontend/dist-third-party.ignore.json)
//
// Env: DEVTOOLS_FRONTEND_SRC  checkout of devtools-frontend
//                             default: <repo>/devtools-frontend.ignore/devtools-frontend
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(
  process.env['DEVTOOLS_FRONTEND_SRC'] ?? path.join(repo, 'devtools-frontend.ignore/devtools-frontend')
);
const thirdParty = path.join(src, 'front_end/third_party');
const frontendDist = path.join(repo, 'packages/devtools-frontend/dist');
const frontendThirdParty = path.join(repo, 'packages/devtools-frontend/dist-third-party.ignore.json');

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!fs.existsSync(frontendDist)) {
  fail(
    'packages/devtools-frontend/dist does not exist: build the frontend first ' +
      '(pnpm --filter @devtools-anywhere/devtools-frontend build:frontend).'
  );
}
if (!fs.existsSync(frontendThirdParty)) {
  fail(
    'packages/devtools-frontend/dist-third-party.ignore.json does not exist: build the frontend again ' +
      '(pnpm --filter @devtools-anywhere/devtools-frontend build:frontend --copy-only reuses the last build).'
  );
}
if (!fs.existsSync(thirdParty)) fail(`No devtools-frontend checkout at ${src} (set DEVTOOLS_FRONTEND_SRC).`);

interface Component {
  name: string;
  version: string;
  license: string;
  copyright: string;
  url: string;
  text: string;
  packages: string[];
  note: string;
}

const read = (file: string): string => fs.readFileSync(file, 'utf8').trimEnd();

const ES_MODULE_LEXER_LICENSE = `MIT License
-----------

Copyright (C) 2018-2022 Guy Bedford

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const require = createRequire(path.join(repo, 'packages/devtools-anywhere/package.json'));
const snapdomDir = path.dirname(require.resolve('@zumer/snapdom/package.json'));
const snapdomVersion = (JSON.parse(read(path.join(snapdomDir, 'package.json'))) as { version: string }).version;

const lexer: Component = {
  name: 'es-module-lexer (ported code)',
  version: '3.0.4',
  license: 'MIT',
  copyright: 'Guy Bedford',
  url: 'https://github.com/guybedford/es-module-lexer',
  text: ES_MODULE_LEXER_LICENSE,
  packages: ['devtools-anywhere'],
  note: 'The lexer in packages/devtools-anywhere/src/cdp-agent/core/lexer.ts is ported from it.',
};
const snapdom: Component = {
  name: 'snapDOM (@zumer/snapdom)',
  version: snapdomVersion,
  license: 'MIT',
  copyright: 'ZumerLab',
  url: 'https://github.com/zumerlab/snapdom',
  text: read(path.join(snapdomDir, 'LICENSE')),
  packages: ['devtools-anywhere'],
  note: 'Bundled as dist/snapdom.js, loaded on demand for the screencast.',
};
const devtools: Component = {
  name: 'Chrome DevTools frontend',
  version: read(path.join(repo, 'packages/devtools-frontend/REVISION')),
  license: 'BSD-3-Clause',
  copyright: 'The Chromium Authors',
  url: 'https://chromium.googlesource.com/devtools/devtools-frontend',
  text: read(path.join(src, 'LICENSE')),
  packages: ['devtools-frontend', 'devtools-frontend-locales'],
  note: "dist/ is its build output (with this project's patches); the translations in devtools-frontend-locales come from it too.",
};

/**
 * Libraries of front_end/third_party in the frontend's dist: directory, where it comes from in the
 * release files (bundled into dist/bundle/, or a directory copied to dist), copyright.
 */
const frontendLibraries: [dir: string, distPath: string, copyright: string][] = [
  ['acorn', 'third_party/acorn', 'acorn contributors (see its AUTHORS)'],
  ['chromium', 'third_party/chromium', 'The Chromium Authors'],
  ['codemirror.next', 'third_party/codemirror.next', 'Marijn Haverbeke and others'],
  ['csp_evaluator', 'third_party/csp_evaluator', 'not stated in the license text'],
  ['diff', 'third_party/diff', 'Google Inc. (diff-match-patch)'],
  ['i18n', 'third_party/i18n', 'Google LLC (Lighthouse)'],
  ['intl-messageformat', 'third_party/intl-messageformat', 'Oath Inc. (includes tslib, 0BSD, Microsoft Corporation)'],
  ['json5', 'third_party/json5', 'Aseem Kishore and others'],
  ['legacy-javascript', 'third_party/legacy-javascript', 'Google LLC (Lighthouse)'],
  ['lit', 'third_party/lit', 'Google LLC'],
  ['marked', 'third_party/marked', 'Christopher Jeffrey / MarkedJS'],
  ['source-map-scopes-codec', 'third_party/source-map-scopes-codec', 'The Chromium Authors'],
  ['third-party-web', 'third_party/third-party-web', 'Patrick Hulce'],
  ['wasmparser', 'third_party/wasmparser', 'not stated in the license text'],
  ['web-vitals', 'models/live-metrics/web-vitals-injected', 'Google LLC'],
];

// A library added to (or dropped from) the frontend's dist must be added to (or dropped from) the list.
// What is under third_party/ is checked against the build's list, the rest against dist/.
const listed = new Set(frontendLibraries.map(([, distPath]) => distPath));
const inDist = new Set(JSON.parse(read(frontendThirdParty)) as string[]);
const unlisted = [...inDist].filter(distPath => !listed.has(distPath));
const missing = [...listed].filter(distPath =>
  distPath.startsWith('third_party/') ? !inDist.has(distPath) : !fs.existsSync(path.join(frontendDist, distPath))
);
if (unlisted.length || missing.length) {
  fail(
    'The frontend dist does not match the list in scripts/third-party-licenses.ts.\n' +
      (unlisted.length ? `  not listed: ${unlisted.join(', ')}\n` : '') +
      (missing.length ? `  not in dist: ${missing.join(', ')}\n` : '')
  );
}

const frontendComponents = frontendLibraries.map(([dir, distPath, copyright]): Component => {
  const readme = read(path.join(thirdParty, dir, 'README.chromium'));
  const field = (key: string): string =>
    readme.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ??
    fail(`front_end/third_party/${dir}/README.chromium has no ${key} field.`);
  return {
    name: `${dir} (DevTools front_end/third_party/${dir})`,
    version: field('Version'),
    license: field('License'),
    copyright,
    // README.chromium says `Internal` for code that lives in the DevTools repository itself.
    url: /^https?:\/\//.test(field('URL'))
      ? field('URL')
      : `https://chromium.googlesource.com/devtools/devtools-frontend/+/${devtools.version}/front_end/third_party/${dir}/`,
    text: read(path.join(thirdParty, dir, field('License File'))),
    packages: ['devtools-frontend'],
    note: distPath.startsWith('third_party/')
      ? `Bundled into dist/bundle/ (from ${distPath}/).`
      : `In dist/${distPath}/.`,
  };
});

const all = [lexer, snapdom, devtools, ...frontendComponents];

const DEV_DEPENDENCIES = `| Dependency | License | Used for |
| --- | --- | --- |
| typescript | Apache-2.0 | type checking, declaration files |
| esbuild | MIT | building the packages |
| vite | MIT | the playground, developing and testing vite-plugin |
| puppeteer-core (with @puppeteer/browsers, chromium-bidi, …) | Apache-2.0 | end-to-end tests |
| acorn | MIT | tests |
| devtools-protocol | BSD-3-Clause | CDP type definitions (types only, not in any build output) |
| oxlint / oxfmt | MIT | linting and formatting |
| husky / lint-staged | MIT | git hooks |
| @types/node | MIT | type definitions |

Licenses of all transitive development dependencies (\`pnpm licenses list -r --dev\`): MIT, Apache-2.0, ISC, BSD-3-Clause, BSD-2-Clause, 0BSD. None is GPL, LGPL, AGPL or unlicensed.
`;

const HEADER = '<!-- Generated by scripts/third-party-licenses.ts (pnpm licenses:update). Do not edit. -->\n\n';

const table = (components: Component[]): string =>
  '| Component | Version | License | Copyright | Included in |\n| --- | --- | --- | --- | --- |\n' +
  components
    .map(c => `| [${c.name}](${c.url}) | ${c.version} | ${c.license} | ${c.copyright} | ${c.packages.join(', ')} |`)
    .join('\n') +
  '\n';

const section = (c: Component): string =>
  `### ${c.name}\n\n- Version: ${c.version}\n- License: ${c.license}\n- Copyright: ${c.copyright}\n- Source: ${c.url}\n` +
  `- Included in: ${c.packages.join(', ')}\n- Notes: ${c.note}\n\n\`\`\`text\n${c.text}\n\`\`\`\n`;

const write = (file: string, content: string): void => {
  const target = path.join(repo, file);
  const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
  if (old === content) return;
  fs.writeFileSync(target, content);
  console.log(`updated ${file}`);
};

write(
  'THIRD_PARTY_LICENSES.md',
  HEADER +
    '# Third-party licenses\n\ndevtools-anywhere itself is licensed under the MIT license (see [LICENSE](LICENSE)). ' +
    'The third-party code below ends up in the published packages (their dist/ and npm contents); ' +
    'its copyright notices and full license texts are reproduced as its licenses require. The ' +
    'THIRD_PARTY_LICENSES.md of each published package covers only what that package contains.\n\n' +
    `## Components in the published packages\n\n${table(all)}\n` +
    '## Development-only dependencies\n\nThese are only used to build, type-check, test, format and lint, ' +
    'and are not part of any published package (vite and @devtools-anywhere/devtools-frontend-locales are ' +
    `peerDependencies of vite-plugin, installed by its users, not bundled).\n\n${DEV_DEPENDENCIES}\n## License texts\n\n` +
    all.map(section).join('\n') +
    '\n## Referenced, not included\n\n' +
    'The source code of these projects was read for reference only: none of their code is copied, ' +
    'and no published package depends on them.\n\n' +
    '| Project | License | Copyright |\n| --- | --- | --- |\n' +
    '| [Chii](https://github.com/liriliri/chii) | MIT | liriliri |\n' +
    '| [chobitsu](https://github.com/liriliri/chobitsu) | MIT | liriliri |\n\n' +
    'The experiments in experiments/early-capture load chobitsu at run time from a local chii.ignore ' +
    'checkout (not committed); that directory is not part of any published package.\n'
);

for (const pkg of ['devtools-anywhere', 'devtools-frontend', 'devtools-frontend-locales']) {
  const components = all.filter(c => c.packages.includes(pkg));
  write(
    `packages/${pkg}/THIRD_PARTY_LICENSES.md`,
    HEADER +
      '# Third-party licenses\n\nThis package contains the third-party code below, with its copyright ' +
      'notices and license texts. The full list is in THIRD_PARTY_LICENSES.md at the root of the ' +
      `devtools-anywhere repository.\n\n${table(components)}\n` +
      components.map(section).join('\n')
  );
}
