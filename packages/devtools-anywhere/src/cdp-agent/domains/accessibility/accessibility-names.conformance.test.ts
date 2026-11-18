// Accessible names (accname), compared with real Chrome one element at a time. The input HTML is
// in cases/names.html, imported from dom-accessibility-api (commit
// a1828981f407b6cd6dc9d7b1046a618af93d0270; MIT License, Copyright (c) 2020 Sebastian Silbermann)
// and web-platform-tests (commit 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD
// License, Copyright © web-platform-tests contributors). The expected values are Chrome's, not theirs.
import { describeCases, readCases } from '../../../../test-support/accessibility.ts';

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {};

describeCases(readCases(new URL('cases/names.html', import.meta.url)), {
  todo: TODO,
  // What the cases' scripts did, written anew.
  setups: {
    'dom-accessibility-api script and shadow roots': () => {
      // Adjacent text nodes are joined without a space.
      const h1 = document.getElementById('lib-A19');
      for (const text of ['Hello ', 'Jill', '!']) h1?.appendChild(document.createTextNode(text));
    },
    'wpt accname/name/shadowdom/basic.html': () => {
      const shadow = (id: string, html: string) => {
        const root = document.getElementById(id)?.attachShadow({ mode: 'open' });
        if (root) root.innerHTML = html;
      };
      shadow('host1', 'foo');
      shadow('host2', '<div aria-label="bar"></div>');
    },
    'wpt accname/name/shadowdom/slot.html': () => {
      const shadow = (id: string, html: string) => {
        const root = document.getElementById(id)?.attachShadow({ mode: 'open' });
        if (root) root.innerHTML = html;
      };
      shadow('host1', 'foo <slot></slot> bar');
      shadow('host2', 'foo <slot>default</slot> bar');
      shadow('host3', 'foo <slot aria-label="label"></slot> bar');
      shadow('host4', 'foo <slot aria-label="label">default</slot> bar');
    },
    'wpt accname/name/comp_name_from_content_alt_counter_invalidation.html': () => {
      // The counter changes after a first layout.
      void document.documentElement.offsetTop;
      const rule = document.body.querySelector('style')?.sheet?.cssRules[0];
      if (rule instanceof CSSStyleRule) rule.style.setProperty('counter-set', 'cnt 228');
      void document.documentElement.offsetTop;
    },
  },
});
