// Names and descriptions of web-platform-tests' manual accname tests and dom-accessibility-api's
// description tests, compared with real Chrome one element at a time. The input HTML is in
// cases/manual.html, imported from dom-accessibility-api (commit
// a1828981f407b6cd6dc9d7b1046a618af93d0270; MIT License, Copyright (c) 2020 Sebastian Silbermann)
// and web-platform-tests (commit 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD
// License, Copyright © web-platform-tests contributors). The expected values are Chrome's, not theirs.
// The licenses in full: cases/LICENSES.
import { MANUAL_SETUPS, describeCases, readCases } from '../../../../test-support/accessibility.ts';

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {
  // Chrome splits a quote of a marker's content into a text node of its own, and writes counters in
  // the styles of @counter-style rules, which are decimal here.
  'list markers with quotes or @counter-style styles': 'lm-todo',
};

describeCases(readCases(new URL('cases/manual.html', import.meta.url)), {
  todo: TODO,
  setups: MANUAL_SETUPS,
});
