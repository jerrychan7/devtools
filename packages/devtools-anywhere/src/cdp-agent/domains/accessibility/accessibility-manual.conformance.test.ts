// Names and descriptions of web-platform-tests' manual accname tests and dom-accessibility-api's
// description tests, compared with real Chrome one element at a time. The input HTML is in
// cases/manual.html, imported from dom-accessibility-api (commit
// a1828981f407b6cd6dc9d7b1046a618af93d0270; MIT License, Copyright (c) 2020 Sebastian Silbermann)
// and web-platform-tests (commit 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD
// License, Copyright © web-platform-tests contributors). The expected values are Chrome's, not theirs.
import { describeCases, readCases } from '../../../../test-support/accessibility.ts';

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {};

/** Builds what HTML cannot say: nodes made in a frame's realm, moved into the page. */
const SETUPS = {
  'devtools-anywhere nodes of another realm': () => {
    const frame = document.body.appendChild(document.createElement('iframe'));
    const other = frame.contentDocument as Document;
    for (const id of ['da-realm-1', 'da-realm-3']) {
      const span = other.createElement('span');
      span.append(other.createTextNode('from a frame'));
      document.getElementById(id)?.append(span);
    }
    frame.remove();
  },
};

describeCases(readCases(new URL('cases/manual.html', import.meta.url)), { todo: TODO, setups: SETUPS });
