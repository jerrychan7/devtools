# Development guide

English | [简体中文](DEV.zh-CN.md)

How to set up a development environment, work on the packages with live rebuilds, and get changes merged or released. For what the project does and how it is designed, see the [README](README.md).

## 1. First-time setup

### Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22.18+ | The build scripts are TypeScript run directly by Node (type stripping). `.nvmrc` pins the version: `nvm use` |
| pnpm | as in `packageManager` | `corepack enable` installs the right version |
| Google Chrome | recent | Used by the tests (Puppeteer). The tests look for it at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; elsewhere (Linux, Windows, another location), set `CHROME_PATH` to its executable |
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

The frontend is built from the official [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend) sources with Chromium's tooling. It needs about 3 GB of disk (2 GB checkout without history, 0.3 GB build output, 0.8 GB depot_tools) and a fast connection the first time.

```bash
# depot_tools: Chromium's gclient/gn/autoninja (directories ending in .ignore are git-ignored);
# the build finds it on its own
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git depot_tools.ignore

# Check out and build the revision pinned in packages/devtools-frontend/REVISION
pnpm --filter @devtools-anywhere/devtools-frontend build:frontend
```

The first build creates the checkout in `devtools-frontend.ignore/`, with `.gclient` next to it (rewritten on every sync): only the pinned commit, without history, and without what only upstream's own tests use.

The result goes to `packages/devtools-frontend/dist/` (English and Chinese) and `packages/devtools-frontend-locales/dist/` (the other languages). Other locations can be used with `DEVTOOLS_FRONTEND_SRC` (the checkout, by default `devtools-frontend.ignore/devtools-frontend`) and `DEPOT_TOOLS`.

If `gclient sync` fails with a lock error on first use (`Error locking …/gsutil`), run it again.

## 2. Day-to-day development

### Live rebuilds

Run these in two terminals:

```bash
pnpm dev          # builds once, then rebuilds every package on change
pnpm playground   # http://localhost:8788/playground/
```

`pnpm dev` runs esbuild in watch mode for `devtools-anywhere`, `vite-plugin` and `remote-server`. There is no hot reload: refresh the page to load the new build. Type declarations are only emitted by `pnpm build`.

The playground server serves the repository root, so any page in it can be opened, for example `/tests/e2e/pages/real-frontend.html`. Every request accepts `?delay=<ms>`, and `/api/echo` returns the request as JSON; `/ws/echo` is a WebSocket that sends every message back.

For remote debugging, also run `pnpm remote` (a remote server at http://localhost:8790/, local only and without a token) and open `/playground/remote.html`: it appears in the server's target list, from which DevTools inspects it.

### Repository layout

```
packages/
  devtools-frontend/  pinned devtools-frontend version, patches and build scripts
  devtools-frontend-locales/  the frontend's languages other than English and Chinese, built with it
  devtools-anywhere/  umbrella package: <devtools-anywhere>, iframe, connection layer, shell mode
    src/cdp-agent/    in-page CDP agent; imports nothing outside this directory (tsconfig.cdp-agent.json),
                      the rest of the package uses it through index.ts and probe/
      probe/          early capture: zero dependencies, size budget, separate build entry
      core/           state shared across domains: remote objects, node ids, DOM observer, stylesheets
      domains/        one directory per domain: runtime/, network/, dom/, css/, overlay/, storage/, ...,
                      with its conformance tests
    test-support/     conformance harness, fixture page and assets
  vite-plugin/    zero-config injection
  remote-server/  remote debugging: relay between a page and DevTools elsewhere, target list, CLI
  relay-core/     internal, never published: the relay logic shell mode and remote-server share (reloads,
                  `enable` replay, pending commands); bundled into both
tests/            tests that span packages
  e2e/            probe → CDP → frontend
  support/        launches Chrome with the static server
playground/       pages and server for development
experiments/      validation records
```

### Where things are

| Change | Where | How to see it |
|---|---|---|
| Early capture (console, errors, requests) | `packages/devtools-anywhere/src/cdp-agent/probe/` | Keep it small: it runs synchronously before the page's code. Check `probe.iife.js` size (min+gzip) |
| A CDP domain | `packages/devtools-anywhere/src/cdp-agent/domains/` | Playground, plus a conformance test |
| The element, connection, shell mode, Service Worker | `packages/devtools-anywhere/src/` | Playground, e2e tests |
| Vite integration | `packages/vite-plugin/src/` | `tests/e2e/vite.test.ts` (app in `tests/e2e/vite-app/`) |
| Remote debugging | `packages/remote-server/src/` (relay, server), `packages/devtools-anywhere/src/remote.ts` (page side) | `tests/e2e/remote.test.ts`; `node packages/remote-server/dist/cli.js` |
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
  - Mind the scope: the Service Worker script must sit at the site root, or the server must send a `Service-Worker-Allowed` header.

### Where contracts live

What two pieces of code must agree on is written once, where it is owned, and imported by the others:

| Contract | Defined in | Used by |
|---|---|---|
| Relay messages (hello, pagehide, detach, ping), hello's params, the replaced-page close code | `packages/relay-core/src/protocol.ts` | `remote.ts`, `connection.ts`, remote-server's `relay.ts` |
| Frontend ↔ `<devtools-anywhere>`: requests, dock sides, hash parameters, our scripts' file names | `packages/devtools-anywhere/src/embedder.ts` | the element, the build; `anywhere_app` through a copy made by the frontend build |
| Shell mode's messages between the page and its Service Worker | `packages/devtools-anywhere/src/shell-messages.ts`, and the agent's `probe/messages.ts` | `element.ts`, `probe.ts`, `service-worker.ts`, the probe |
| `window.DevtoolsAnywhere`, the API the bundle exposes (`RemoteOptions` included) | `packages/devtools-anywhere/src/api.ts` | `iife.ts`, `probe.ts`, `tests/globals.d.ts` |
| The probe script's `data-*` attributes | `packages/devtools-anywhere/src/probe-script.ts` (`ProbeScriptAttributes`, exported as `@public`) | `probe.ts`, the Vite plugin, remote-server |

`pnpm lint` and the pre-commit hook check that each literal with a prefix of ours (`DevtoolsAnywhere.`, `devtools-anywhere:`, `devtools-anywhere-`, `__devtoolsAnywhere`) is written in one source file only (`scripts/check-contracts.ts`; comments and tests are not checked). Names checked by the type checker against a contract, such as `keyof ProbeScriptAttributes`, may be spelled out where they are used. oxlint also stops the rest of `devtools-anywhere/src` from importing the CDP agent's `core/` or `domains/`: it goes through `cdp-agent/index.ts` and `cdp-agent/probe/`.

### Tests

```bash
pnpm test                                     # build + all tests
node --test packages/devtools-anywhere/src/cdp-agent/domains/css/css.conformance.test.ts
                                              # one file (after a build or with pnpm dev running)
pnpm typecheck                                # builds, then checks packages, build scripts, tests and playground
```

A test sits next to what it tests, as `<name>.test.ts`; only tests that span packages are under `tests/`.
- `*.conformance.test.ts` (next to the CDP agent's domains): the same page is inspected through real Chrome's CDP and through ours, and the outputs are compared. When implementing or changing a CDP method, add a test here: real Chrome is the reference, not the protocol documentation. They load the built bundles, as pages do.
- `tests/e2e/`: the connection layer, shell mode, zero-config setup, the Vite plugin and the real frontend. The pages they open are in `pages/` (their scripts and styles in `pages/assets/`), the stand-in frontends in `frontends/`.

### Working on the frontend

`packages/devtools-frontend` builds the official [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend) at a pinned revision and keeps only what its entrypoint can load. How it fits into upstream with as few patches as possible:

- **Own entrypoint** `anywhere_app` instead of `devtools_app`: it imports only the panels that work against the in-page CDP agent (Elements, Console, Sources, Network, Application) and the screencast, so the others are neither shown nor loaded. The only patch registers this entrypoint in the build (7 lines in 4 `BUILD.gn`/`.gni` files).
- **Embedder through the official host API**: Chrome talks to DevTools through native `InspectorFrontendHost` bindings. The entrypoint keeps the hosted-mode stub and only replaces `sendMessageToBackend`/`isHostedMode`, so CDP messages travel through `postMessage` to the embedding window, which passes its origin as `#?embedded=<origin>`. No connection code is patched.
- **Device mode in shell mode**: the entrypoint loads the emulation module, whose app (upstream's `AdvancedApp`) lays out the page and DevTools as in Chrome, when the shell passes `#?shell=1` (`can_emulate_device`); elsewhere upstream's simple app and the screencast stay. `setInspectedPageBounds` goes to the shell (`page-bounds`), which places the page iframe and answers `Emulation.setDeviceMetricsOverride` by sizing it (`packages/devtools-anywhere/src/shell-layout.ts`). Undocked, device mode's page `device_mode_emulation_frame.html` is shown by the shell in an iframe instead of a window, and the entrypoint hands it its document. `patches/device-mode-in-shell.patch` adds the condition, keeps the screencast out of shell mode, opens device mode's page next to `anywhere_app.html`, and drops the device pixel ratio and device type from the toolbar's menu.
- **Small screens**: upstream's responsive layouts (vertical split in Elements, overflowing tabs) are kept as is.
- **Few requests**: upstream ships one bundle per module, about 150 requests to open DevTools, which is slow over HTTP/1.1 or a flaky network. `scripts/bundle.ts` rebundles them with rollup (tree-shaken) into `dist/bundle/`: each lazily loaded module (a panel, mostly) is a chunk loaded when it is, and the entry chunk holds what the entry imports, what several panels share and the small ones; each worker is one file, and so is device mode's page for undocked DevTools; the SVG icons are inlined as data: URLs. Opening DevTools takes about 10 requests. Every bundled file is named after a hash of its content and can be cached for good; only `anywhere_app.html`, which names the entry, must be revalidated. Since modules are no files of their own any more, the end-to-end tests reach them through `modules` exported by the entrypoint.

`packages/devtools-frontend/` contains:

- `REVISION`: the pinned upstream commit.
- `src/anywhere_app/`: our entrypoint, copied into `front_end/entrypoints/` before each build.
- `patches/*.patch`: changes to upstream files, one patch per change. Each touches its own files, so the order they are applied in does not matter. Keep them as few and as small as possible.
- `locales/<locale>.json`: translations of anywhere_app's own UI strings (keys of its `UIStrings`), which upstream's translations do not have; merged into that locale's file by the build. Other locales show them in English.
- `scripts/build.ts`: the build; `scripts/bundle.ts`: the bundling it ends with.

```bash
cd packages/devtools-frontend
node scripts/build.ts --no-sync     # rebuild after changing src/ (incremental, keeps the checkout as is: builds its HEAD, whatever REVISION says)
node scripts/build.ts --no-sync --reset   # also discard edits in the checkout that no patch holds
node scripts/build.ts --no-sync --copy-only   # only redo the copy to dist/ (after changing the copy logic)
```

The build keeps the checkout at exactly `REVISION` plus every patch: a patch that is missing, changed or removed is applied again from a clean file. A file that differs both from `REVISION` and from what the patches make of it holds edits no patch has yet, so the build stops and lists it rather than discard them; `--reset` discards them. A commit that touches `packages/devtools-frontend/` is stopped on the same edits by the pre-commit hook (`scripts/check-checkout.ts`), so that an edit made in the checkout cannot be left out of the patches; a checkout edit an entrypoint change needs (a `jslog` context in `KnownContextValues.ts`, say) goes into a patch of its own.

To change a patch, edit the upstream files in the checkout, then regenerate the patch from the files it touches, compared with `HEAD`:

```bash
cd devtools-frontend.ignore/devtools-frontend
git diff HEAD -- front_end/panels/console/ConsolePanel.ts > ../../packages/devtools-frontend/patches/console-reveal-makes-room.patch
```

The frontend follows stable Chrome, which is what most users have: once per milestone, a week or two after a new stable release, move to it with

```bash
pnpm --filter @devtools-anywhere/devtools-frontend update
```

It builds the devtools-frontend commit the current stable Chrome ships (on its milestone's branch, `chromium/<branch>`, not on upstream's `main`; Chromium Dash's `fetch_releases` says which) and pins it in `REVISION`, and its Chrome version in the packages' `chrome` field, on success. Should Chromium Dash not answer, write that commit into `REVISION` by hand and run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend`. If a patch no longer applies, the build stops; in the checkout, `git apply --3way <patch>` leaves conflict markers: resolve them, regenerate the patch, and run `node scripts/build.ts --no-sync --latest` (it builds the checkout's `HEAD` and pins it; set `chrome` by hand then). Then run `pnpm test`: a newer frontend may call CDP methods the server does not answer yet (look for "wasn't found" in the browser console).

## 3. Finishing a change

### Before committing

```bash
pnpm lint        # oxlint, then scripts/check-contracts.ts, check-file-size.ts and check-dir-size.ts
pnpm fmt         # oxfmt: formats in place (Markdown is not formatted)
pnpm typecheck
pnpm test        # with the frontend built, so the real-frontend tests run
```

The pre-commit hook (husky + lint-staged) runs on the staged files only: it formats them with oxfmt and adds the result to the commit, then lints them with oxlint and stops the commit on any error; it also runs `scripts/check-contracts.ts` (see "Where contracts live"), and two size guards on what the commit adds or changes: `scripts/check-file-size.ts` warns on a source file (`.ts`, `.js` and their variants) past 1100 lines and rejects the commit past 1500; `scripts/check-dir-size.ts` warns on a directory the commit adds files to that holds more than 20 files directly and rejects it past 30. After a warning, make the next commit the one that splits the file or sorts the directory into subdirectories by concern. Both skip the code that goes into the devtools-frontend checkout, which follows Chromium's style (`packages/devtools-frontend/src` is copied in, `patches` are applied to it) and `experiments/`. `pnpm lint` runs both on every tracked file (`--all`), so a commit that skipped the hook is caught there. `git commit --no-verify` skips the hook once. Lint rules: oxlint's correctness rules, no `any`, no non-null assertions (`!`). Style: 2-space indentation, semicolons, single quotes, 120 columns. `packages/devtools-frontend/src` follows Chromium's style instead and is not linted or formatted.

The build rolls each package's type declarations up into one file per entry point (`dist/index.d.ts`) with API Extractor, and writes the package's API to `packages/<package>/etc/`: `*.public.api.md` for the public API (what is promised), `*.api.md` for everything exported, internal included (`scripts/api-extract.ts`, configured by `api-extractor.base.json`; it copies `declare global` blocks into the rolled-up file, which API Extractor leaves out). `devtools-anywhere` has no runtime entry: its `dist/index.d.ts` is types only, and its scripts are built as IIFEs. Commit a changed report with the change that caused it: it is how a change to the public API shows in review. With `CI=true`, which GitHub Actions sets, a report that no longer matches fails the build, so CI catches a report left uncommitted. Every export of an entry point needs a release tag: `@public` only for what the README documents (remote-server's `startRemoteServer` / `createRemoteHandler`, the Vite plugin), `@internal` for everything else, which is used only between this repository's packages, built and released together, and may change at any time; when in doubt, `@internal`, and export nothing an entry point does not need. Doc comments are TSDoc: put package names such as `@devtools-anywhere/...` in backticks and code examples in fenced blocks.

Also update both `README.md` and `README.zh-CN.md` (and this guide in both languages) when behavior, usage or limitations change, and add a line for users under `Unreleased` in both `CHANGELOG.md` and `CHANGELOG.zh-CN.md` (moving the frontend to a new Chrome milestone also changes its `Based on Chrome` line).

When a dependency that ends up in a build output is added or upgraded, or code is ported from another project (including moving the DevTools frontend to a new `REVISION`), run `pnpm licenses:update` to regenerate `THIRD_PARTY_LICENSES.md` at the root and in the packages (for a new library, add it to the list in `scripts/third-party-licenses.ts` first). It needs the frontend built: the build writes the `front_end/third_party` libraries that end up in `dist/` to `packages/devtools-frontend/dist-third-party.ignore.json` (next to `dist/`, not published), which the script checks its list against; `build:frontend --copy-only` regenerates it from the last build.

### Commits

- One logical step per commit.
- Message format: `type(scope): summary`, then a blank line and an English body explaining what changed and why. Types: `feat`, `fix`, `docs`, `test`, `build`, `ci`, `refactor`, `chore`. Scopes are package or area names, e.g. `cdp-agent`, `network`, `devtools-frontend`, `service-worker`, `readme`.

### Branches and pull requests

`main` is the only long-lived branch: it is where all work lands and what releases are tagged from, and it should always be releasable. There is no `develop` branch: merging into `main` does not release anything (only a pushed `vx.y.z` tag does, see "Releasing to npm"), so `main` itself holds what is merged and not yet released.

| Branch | For | Rules |
| --- | --- | --- |
| `main` | All development; releases are tagged on it | Changed through pull requests only, CI must pass, no force pushes |
| `feat/…`, `fix/…`, `docs/…`, `ci/…`, … | One change each, short-lived; the prefix is the commit type | Branched from `main`, merged back through a pull request and deleted |
| `release/x.y.z` | The pull request that prepares release x.y.z (version and changelog) | Merged into `main`, then the tag goes on `main` |
| `release/x.y` | Patches to an older minor, only when needed (see "Patching an older release") | Branched from the tag `vx.y.0`, kept while that minor is patched |

A fix is not a branch type of its own: it goes through a `fix/…` branch into `main` like any change, and is released as a patch. CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: lint, typecheck, the frontend build and all the tests.

```bash
git switch -c feat/my-change main
# … commits …
git push -u origin feat/my-change
gh pr create --fill
```

Describe in the PR what was verified, in particular what was checked by hand in a browser and what was not (Safari, mobile devices). A change users notice also adds its line under `Unreleased` in both changelogs in the same pull request, so that the changelog is ready when a release is cut.

### Releasing to npm

All packages share one version number and are released together, by `.github/workflows/release.yml` when a tag `vx.y.z` is pushed. npm trusts that workflow (trusted publishing, set on each package on npmjs.com for this repository, `release.yml` and the `npm` environment), so it publishes without a stored token and with provenance; renaming the file or the environment breaks that. Approving the publish takes a reviewer of the repository's `npm` environment. Each package's trusted publisher must allow `npm publish` and `npm dist-tag`, not only `npm stage publish`.

Versions are semver for the library itself, starting at `0.1.0`: a fix is a patch; a new feature, or moving the frontend to a new Chrome milestone (its UI changes), is a minor; before 1.0 a minor may also break. Releases are cut when there is something worth releasing (features that add up to a minor, a fix users are waiting for, a new Chrome milestone), not on every merge. What is promised is what the README documents (`@public`). The Chrome version is not in the version number, where npm would drop it (`+chrome156`) or take it for a prerelease (`-chrome156`): each published package's `package.json` has it as `chrome`, which `update` writes, and each release says it first (`Based on Chrome 156`). Each release also gets the dist-tag `chrome-<milestone>`, so that `npm i devtools-anywhere@chrome-156` installs the last release on that Chrome.

1. On a branch `release/x.y.z` from `main`, set the same `version` in every `packages/*/package.json`, move the `Unreleased` notes in `CHANGELOG.md` and `CHANGELOG.zh-CN.md` under `## x.y.z`, and commit (`build: release x.y.z`). `node scripts/release.ts check x.y.z` checks both. Open a pull request and merge it once CI passes.
2. Tag the merged commit on `main` and push the tag: `git switch main && git pull && git tag vx.y.z && git push origin vx.y.z`.
3. The workflow checks the version, builds the frontend, runs the checks and tests as CI does and packs the packages (pnpm replaces `workspace:*` with the real version). Then approve its `publish` job in the Actions tab: it publishes the packages to npm, tags them `chrome-<milestone>`, and publishes the GitHub release with that version's section of `CHANGELOG.md` followed by that of `CHANGELOG.zh-CN.md`.

#### Patching an older release

Usually a fix is released as the next patch from `main`. Only when `main` already holds changes that should not ship yet (a new minor in progress) and an older release needs the fix:

1. Create `release/x.y` from the tag `vx.y.0` once, if it does not exist yet: `git switch -c release/x.y vx.y.0 && git push -u origin release/x.y`.
2. Merge the fix into `main` first, then cherry-pick it onto `release/x.y` through a pull request (`git cherry-pick -x <commit>`), with its changelog line.
3. Release from `release/x.y` as above, with the tag on that branch.

Not set up yet, to do before the first such release: CI does not run on `release/**` branches, and the publish job moves npm's `latest` to whatever it publishes, so a patch to an older minor would replace the newer release as `latest`; it has to publish with `--tag` (or move `latest` back) instead.
