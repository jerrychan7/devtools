// The whole tree (Accessibility.getFullAXTree) of every case group, compared with real Chrome:
// roles, names, which nodes are ignored and how they nest. The per-element tests compare a node's
// fields; these compare the shape around them. Inline text boxes are left out on both sides: the
// page cannot see them, so we will not make them, and their text stays as their StaticText
// parent's name. Set AX_TREE_REPORT=<file> to append each
// differing group's lines only one side has, by kind, and both outlines to the file as JSON lines.
import { appendFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';
import {
  MANUAL_SETUPS,
  fullTree,
  listedTree,
  openAxPage,
  readCases,
  setBody,
  treeDiff,
  treeDiffKind,
} from '../../../../test-support/accessibility.ts';

// Known differences that stay: a details without a summary has Chrome's default summary, whose
// text is the browser's localized "Details", which the page cannot know; a video or audio has
// Chrome's name for media that cannot play, also localized, and the ignored nodes of its media
// controls, which change with the browser version and the media's state (docs/limitations.md).
/** Groups ("file: group") whose tree differs from Chrome's on the current implementation, by what differs. */
const TODO: Record<string, string[]> = {
  'other nodes differ': [
    'roles: dom-accessibility-api roles',
    'names: wpt accname/name/comp_label.html',
    'manual: wpt accname/manual/name_test_case_548-manual.html',
    'names: dom-accessibility-api names',
    'roles: wpt html-aam/optgroup-role.tentative.html',
    'roles: wpt wai-aria/role/role_none_conflict_resolution.tentative.html',
    'names: dom-accessibility-api script and shadow roots',
    'names: wpt accname/name/comp_name_from_content_display_contents.html',
    'manual: wpt accname/manual/name_test_case_544-manual.html',
    'manual: wpt accname/manual/name_test_case_546-manual.html',
    'manual: wpt accname/manual/name_test_case_547-manual.html',
    'manual: wpt accname/manual/name_test_case_549-manual.html',
    'manual: wpt accname/manual/name_test_case_550-manual.html',
    'manual: wpt accname/manual/name_test_case_551-manual.html',
    'manual: wpt accname/manual/name_test_case_552-manual.html',
    'manual: wpt accname/manual/name_test_case_553-manual.html',
    'manual: wpt accname/manual/name_test_case_556-manual.html',
    'manual: wpt accname/manual/name_test_case_558-manual.html',
    'manual: wpt accname/manual/name_test_case_559-manual.html',
    'manual: wpt accname/manual/name_test_case_560-manual.html',
    'manual: wpt accname/manual/name_test_case_561-manual.html',
    'manual: wpt accname/manual/name_test_case_562-manual.html',
    'manual: wpt accname/manual/name_test_case_563-manual.html',
    'manual: wpt accname/manual/name_test_case_564-manual.html',
    'manual: wpt accname/manual/name_test_case_565-manual.html',
    'manual: wpt accname/manual/name_test_case_566-manual.html',
    'manual: wpt accname/manual/name_test_case_604-manual.html',
  ],
  'ListMarker nodes differ; other nodes differ': [
    'roles: wpt wai-aria/role/role_none_conflict_resolution_spec_ambiguities.tentative.html',
    'names: wpt html-aam/summary.html',
  ],
  'input inner nodes differ; other nodes differ': [
    'names: wpt accname/name/comp_embedded_control.html',
    'names: wpt accname/name/comp_host_language_label.html',
    'names: wpt accname/name/comp_host_language_label.tentative.html',
  ],
  'other nodes differ: flex details items, elements in a label': [
    'manual: devtools-anywhere details in a flex box',
    'manual: devtools-anywhere elements in a label',
  ],
};

/** Groups whose listed nodes differ from Chrome's though their tree does not, by what differs. */
const LISTED_TODO = new Map<string, string>(Object.entries({}));

let env: Env | undefined;
let t: TestPage;
setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openAxPage(env);
  },
  () => env?.close()
);

const todo = new Map<string, string>();
for (const [reason, groups] of Object.entries(TODO)) for (const group of groups) todo.set(group, reason);

const files: [string, Record<string, (() => void) | string>][] = [
  ['roles', {}],
  ['names', {}],
  ['manual', MANUAL_SETUPS],
];
for (const [file, setups] of files)
  describe(file, () => {
    for (const group of readCases(new URL(`cases/${file}.html`, import.meta.url))) {
      const key = `${file}: ${group.name}`;
      test(group.name, { todo: todo.get(key) ?? LISTED_TODO.get(key) }, async () => {
        await setBody(t, group.html);
        const setup = setups[group.name];
        if (setup) await t.page.evaluate(setup);
        const [ours, chrome] = await Promise.all([fullTree(t.ours), fullTree(t.chrome)]);
        const report = process.env['AX_TREE_REPORT'];
        if (report) {
          const diff = treeDiff(ours, chrome);
          if (diff.length)
            appendFileSync(
              report,
              JSON.stringify({
                group: key,
                diff: diff.map(d => ({
                  side: d.side,
                  kind: treeDiffKind(d.line),
                  line: d.line.text,
                  parent: d.line.ancestors.at(-1),
                })),
                ours: ours.map(l => l.text),
                chrome: chrome.map(l => l.text),
              }) + '\n'
            );
        }
        assert.deepEqual(
          ours.map(l => l.text),
          chrome.map(l => l.text)
        );
        // Then the nodes as getFullAXTree lists them, in Chrome's order, with the pseudo-elements
        // whose backend ids list markers and generated content carry. In the same test: setting a
        // group's body again changes how Chrome breaks aria-owns cycles.
        const [listedOurs, listedChrome] = await Promise.all([listedTree(t.ours, true), listedTree(t.chrome, false)]);
        assert.deepEqual(listedOurs, listedChrome, 'listed order and pseudo-element ids');
      });
    }
  });
