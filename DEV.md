# Development guide

English | [简体中文](DEV.zh-CN.md)

How to set up a development environment, work on the packages with live rebuilds, and get changes merged or released. For what the project does and how it is designed, see the [README](README.md).

## 1. First-time setup

### Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22.18+ | The build scripts are TypeScript run directly by Node (type stripping). `.nvmrc` pins the version: `nvm use` |
| pnpm | as in `packageManager` | `corepack enable` installs the right version |
| Google Chrome | recent | Used by the tests (Puppeteer). Set `CHROME_PATH` if it is not at the default macOS location |
| Git | any | |

`engine-strict` is on: `pnpm install` refuses to run on an older Node.

### Install and check

```bash
git clone https://github.com/jerrychan7/devtools.git
cd devtools
pnpm install     # also enables the pre-commit hook (husky)
pnpm test        # builds all packages, then runs every test against real Chrome
```

If the hook is not active (`git config core.hooksPath` prints nothing), run `pnpm run prepare`. `HUSKY=0` disables it, for example in scripts.

Tests that need the DevTools frontend are skipped until it is built (next step).

### Build the DevTools frontend (once)

The frontend is built from the official [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend) sources with Chromium's tooling. It needs about 6 GB of disk (4.7 GB checkout, 0.8 GB depot_tools) and a fast connection the first time.

```bash
# depot_tools: Chromium's fetch/gclient/gn/autoninja
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git depot_tools.ignore
export PATH="$PWD/depot_tools.ignore:$PATH"

# Source checkout (directories ending in .ignore are git-ignored)
mkdir devtools-frontend.ignore && cd devtools-frontend.ignore
fetch --nohooks devtools-frontend
gclient sync
cd ..

# Build the revision pinned in packages/devtools-frontend/REVISION
pnpm --filter @devtools-anywhere/devtools-frontend build:frontend
```

The result goes to `packages/devtools-frontend/dist/` (English and Chinese) and `packages/devtools-frontend-locales/dist/` (the other languages). Other locations can be used with `DEVTOOLS_FRONTEND_SRC` (the `devtools-frontend` checkout) and `DEPOT_TOOLS`.

If `gclient sync` fails with a lock error on first use (`Error locking …/gsutil`), run it again.

## 2. Day-to-day development

### Live rebuilds

Run these in two terminals:

```bash
pnpm dev          # builds once, then rebuilds every package on change
pnpm playground   # http://localhost:8788/playground/
```

`pnpm dev` runs esbuild in watch mode for `cdp-server`, `devtools-anywhere` and `vite-plugin`. A change in `cdp-server` also rebuilds the `devtools-anywhere` bundles that include it. There is no hot reload: refresh the page to load the new build. Type declarations are only emitted by `pnpm build`.

The playground server serves the repository root, so any page in it can be opened, for example `/tests/e2e/real-frontend.html`. Every request accepts `?delay=<ms>`, and `/api/echo` returns the request as JSON; `/ws/echo` is a WebSocket that sends every message back.

### Repository layout

```
packages/
  cdp-server/     in-page CDP server
    src/probe/    early capture: zero dependencies, size budget, separate build entry
    src/core/     state shared across domains: remote objects, node ids, DOM observer, stylesheets
    src/domains/  one directory per domain: runtime, network, dom, css, overlay, storage, ...
  devtools-frontend/  pinned devtools-frontend version, patches and build scripts
  devtools-anywhere/  umbrella package: <devtools-anywhere>, iframe, connection layer, shell mode
  vite-plugin/    zero-config injection
tests/
  conformance/    compare CDP output against real Chrome via Puppeteer
  e2e/            probe → CDP → frontend
playground/       pages and server for development
experiments/      validation records
```

### Where things are

| Change | Where | How to see it |
|---|---|---|
| Early capture (console, errors, requests) | `packages/cdp-server/src/probe/` | Keep it small: it runs synchronously before the page's code. Check `probe.iife.js` size (min+gzip) |
| A CDP domain | `packages/cdp-server/src/domains/` | Playground, plus a conformance test |
| The element, connection, shell mode, Service Worker | `packages/devtools-anywhere/src/` | Playground, e2e tests |
| Vite integration | `packages/vite-plugin/src/` | `tests/e2e/vite.test.ts` (app in `tests/e2e/vite-app/`) |
| DevTools frontend | `packages/devtools-frontend/` | See below |

### Constraints and caveats

- Every `postMessage` must check `event.origin` and `event.source`; otherwise any page could send CDP commands to the runtime.
- Detect whether the page is inside the shell through a postMessage handshake rather than reading properties on `window.parent`, which throws a SecurityError across origins.
- Both ends of the handshake need buffering: messages must not be dropped while DevTools is still loading.
- Frontend assets should be self-hostable, with no dependency on third-party CDNs such as unpkg or jsDelivr.
- When injecting with a Service Worker:
  - Only handle navigation requests with `destination === 'iframe'`, and let everything else pass through.
  - Call `unregister()` when f12 is disabled.
  - Insert the probe with a `TransformStream` so SSR streaming is not broken.
  - Mind the scope: the SW script must sit at the site root, or the server must send a `Service-Worker-Allowed` header.

### Tests

```bash
pnpm test                                     # build + all tests
node --test tests/conformance/css.test.ts     # one file (after a build or with pnpm dev running)
pnpm typecheck                                # builds, then checks packages, build scripts, tests and playground
```

- `tests/conformance/`: the same page is inspected through real Chrome's CDP and through ours, and the outputs are compared. When implementing or changing a CDP method, add a test here: real Chrome is the reference, not the protocol documentation.
- `tests/e2e/`: the connection layer, shell mode, zero-config setup, the Vite plugin and the real frontend.

### Working on the frontend

`packages/devtools-frontend` builds the official [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend) at a pinned revision and keeps only what its entrypoint can load. How it fits into upstream with as few patches as possible:

- **Own entrypoint** `anywhere_app` instead of `devtools_app`: it imports only the panels that work against the in-page CDP server (Elements, Console, Sources, Network, Application) and the screencast, so the others are neither shown nor loaded. The only patch registers this entrypoint in the build (7 lines in 4 `BUILD.gn`/`.gni` files).
- **Embedder through the official host API**: Chrome talks to DevTools through native `InspectorFrontendHost` bindings. The entrypoint keeps the hosted-mode stub and only replaces `sendMessageToBackend`/`isHostedMode`, so CDP messages travel through `postMessage` to the embedding window, which passes its origin as `#?embedded=<origin>`. No connection code is patched.
- **Small screens**: upstream's responsive layouts (vertical split in Elements, overflowing tabs) are kept as is.

`packages/devtools-frontend/` contains:

- `REVISION`: the pinned upstream commit.
- `src/anywhere_app/`: our entrypoint, copied into `front_end/entrypoints/` before each build.
- `patches/*.patch`: changes to upstream files, applied in order. Keep them as few and as small as possible.
- `locales/<locale>.json`: translations of anywhere_app's own UI strings (keys of its `UIStrings`), which upstream's translations do not have; merged into that locale's file by the build. Other locales show them in English.
- `scripts/build.ts`: the build.

```bash
cd packages/devtools-frontend
node scripts/build.ts --no-sync     # rebuild after changing src/ (incremental, keeps the checkout as is)
node scripts/build.ts --no-sync --copy-only   # only redo the copy to dist/ (after changing the copy logic)
```

To change a patch, edit the upstream file in the checkout, then regenerate the patch from the checkout's diff:

```bash
cd devtools-frontend.ignore/devtools-frontend
git diff > ../../packages/devtools-frontend/patches/0001-register-anywhere_app-entrypoint.patch
```

To move to the latest upstream:

```bash
pnpm --filter @devtools-anywhere/devtools-frontend update
```

It builds the tip of upstream `main` and pins it in `REVISION` on success. If a patch no longer applies, `git apply --3way` leaves conflict markers in the checkout: resolve them, regenerate the patch, and run `node scripts/build.ts --no-sync`. Then run `pnpm test`: a newer frontend may call CDP methods the server does not answer yet (look for "wasn't found" in the browser console).

## 3. Finishing a change

### Before committing

```bash
pnpm lint        # oxlint
pnpm fmt         # oxfmt: formats in place (Markdown is not formatted)
pnpm typecheck
pnpm test        # with the frontend built, so the real-frontend tests run
```

The pre-commit hook (husky + lint-staged) runs on the staged files only: it formats them with oxfmt and adds the result to the commit, then lints them with oxlint and stops the commit on any error. `git commit --no-verify` skips it once. Lint rules: oxlint's correctness rules, no `any`, no non-null assertions (`!`). Style: 2-space indentation, semicolons, single quotes, 120 columns. `packages/devtools-frontend/src` follows Chromium's style instead and is not linted or formatted.

Also update both `README.md` and `README.zh-CN.md` (and this guide in both languages) when behavior, usage or limitations change.

### Commits

- One logical step per commit.
- Message format: `type(scope): summary`, then a blank line and an English body explaining what changed and why. Types: `feat`, `fix`, `docs`, `test`, `build`, `refactor`, `chore`. Scopes are package or area names, e.g. `cdp-server`, `network`, `devtools-frontend`, `sw`, `readme`.

### Pull requests

```bash
git switch -c my-change
# … commits …
git push -u origin my-change
gh pr create --fill
```

Describe in the PR what was verified, in particular what was checked by hand in a browser and what was not (Safari, mobile devices).

### Releasing to npm

The packages have not been published yet; this is the intended procedure. All packages share one version number and are released together. Publishing needs a member of the [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) organization.

1. Build the frontend at the pinned revision (its `dist/` is not committed, and `pnpm build` does not build it):
   ```bash
   pnpm --filter @devtools-anywhere/devtools-frontend build:frontend
   ```
2. Run `pnpm typecheck` and `pnpm test`.
3. Set the same `version` in every `packages/*/package.json` and commit (`build: release x.y.z`).
4. Publish to the public registry (pnpm replaces `workspace:*` with the real version):
   ```bash
   pnpm -r publish --access public --registry https://registry.npmjs.org
   ```
   Pass `--registry` explicitly if your default registry is a mirror.
5. Tag and push: `git tag vx.y.z && git push origin main vx.y.z`.
