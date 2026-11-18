// Accessible names (accname), compared with real Chrome one element at a time. The input HTML is
// in cases/names.html, imported from dom-accessibility-api (commit
// a1828981f407b6cd6dc9d7b1046a618af93d0270; MIT License, Copyright (c) 2020 Sebastian Silbermann)
// and web-platform-tests (commit 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD
// License, Copyright © web-platform-tests contributors). The expected values are Chrome's, not theirs.
import { describeCases, readCases } from '../../../../test-support/accessibility.ts';

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {
  'name: Chrome and ours compute different names': `
    lib-A9 lib-L1 lib-L6 lib-L8 lib-L9 lib-C3 lib-C5 lib-C6 lib-C7 lib-SL1 lib-SL3 lib-S2
    accname-aria-owns-1 accname-aria-owns-2 accname-aria-owns-5 accname-aria-owns-6
    name-comp-embedded-control-1 name-comp-hidden-not-referenced-1 name-comp-hidden-not-referenced-4
    name-comp-hidden-not-referenced-5 name-comp-host-language-label-74 name-comp-host-language-label-77
    name-comp-label-110 name-comp-label-111 name-comp-label-120 name-comp-label-121 name-comp-label-123
    name-comp-label-125 name-comp-label-126 name-comp-label-127 name-comp-labeledby-non-standard-1 g2 g2
    name-comp-labelledby-hidden-nodes-1 name-comp-labelledby-hidden-nodes-2
    name-comp-labelledby-hidden-nodes-3 name-comp-labelledby-hidden-nodes-4
    name-comp-labelledby-hidden-nodes-5 name-comp-labelledby-hidden-nodes-6
    name-comp-labelledby-hidden-nodes-7 name-comp-labelledby-hidden-nodes-8
    name-comp-labelledby-hidden-nodes-9 name-comp-labelledby-hidden-nodes-10
    name-comp-labelledby-hidden-nodes-11 name-comp-labelledby-hidden-nodes-17
    name-comp-labelledby-hidden-nodes-21 name-comp-labelledby-hidden-nodes-23
    name-comp-labelledby-hidden-nodes-24 name-comp-labelledby-hidden-nodes-25
    name-comp-labelledby-hidden-nodes-26 name-comp-name-from-content-13 name-comp-name-from-content-14
    name-comp-name-from-content-15 name-comp-name-from-content-28 name-comp-name-from-content-29
    name-comp-name-from-content-30 name-comp-name-from-content-34 name-comp-name-from-content-35
    name-comp-name-from-content-36 name-comp-name-from-content-51 name-comp-name-from-content-52
    name-comp-name-from-content-64 name-comp-name-from-content-65 name-comp-name-from-content-66
    name-comp-name-from-content-68 name-comp-name-from-content-69 name-comp-name-from-content-70
    name-comp-name-from-content-71 name-comp-name-from-content-72 name-comp-name-from-content-73
    name-comp-name-from-content-74 name-comp-name-from-content-75 name-comp-name-from-content-76
    name-comp-name-from-content-77 name-comp-name-from-content-78 name-comp-name-from-content-79
    name-comp-name-from-content-display-contents-11 name-comp-name-from-content-display-contents-12
    name-comp-name-from-content-display-contents-13 name-comp-text-node-11 name-comp-text-node-12
    name-comp-text-node-13 name-comp-text-node-14 name-comp-text-node-15 name-comp-text-node-21
    name-comp-text-node-22 name-comp-text-node-23 name-comp-text-node-24 name-comp-text-node-25
    name-comp-text-node-26 name-comp-text-node-27 name-comp-text-node-28 name-comp-text-node-29
    name-comp-text-node-30 name-comp-text-node-31 name-comp-text-node-32 name-comp-text-node-33
    name-comp-text-node-34 name-comp-text-node-35 name-comp-text-node-36 name-comp-text-node-37
    name-comp-text-node-38 name-comp-text-node-39 name-comp-text-node-40 name-comp-text-node-41
    name-comp-text-node-42 name-comp-text-node-43 name-comp-text-node-44 name-comp-text-node-45
    labelled1 labelled2 labelled1 labelled2 labelled3 labelled4 html-aam-hidden-names-2
    html-aam-hidden-names-3 html-aam-hidden-names-4 html-aam-hidden-names-5
    aria-actions-aria-actions-host-accname-excludes-target-tentative-1
    aria-actions-aria-actions-host-accname-multiple-targets-tentative-1
    aria-actions-aria-actions-target-accname-from-aria-label-tentative-1
    `,
  'name sources: same name, different source list': `
    lib-A20 lib-C8 lib-T8 lib-T10 name-comp-hidden-not-referenced-2 name-comp-hidden-not-referenced-3
    input-01 name-comp-hidden-not-referenced-7 name-comp-hidden-not-referenced-8
    name-comp-host-language-label-1 name-comp-host-language-label-3 name-comp-host-language-label-4
    name-comp-label-32 name-comp-label-51 name-comp-label-61 name-comp-label-99 name-comp-label-112
    name-comp-label-128 name-comp-label-129 name-comp-label-130 name-comp-labelledby-hidden-nodes-12
    name-comp-labelledby-hidden-nodes-13 name-comp-labelledby-hidden-nodes-14
    name-comp-labelledby-hidden-nodes-15 name-comp-labelledby-hidden-nodes-16
    name-comp-labelledby-hidden-nodes-18 name-comp-labelledby-hidden-nodes-19
    name-comp-labelledby-hidden-nodes-20 name-comp-labelledby-hidden-nodes-22
    name-comp-labelledby-hidden-nodes-27 input-01
    `,
  'Chrome gives one of its internal roles (Abbr, Canvas, DateTime, LayoutTable…); ours gives an ARIA role': `
    lib-A12 lib-P13 lib-T6 co cov da dav dtl dtlv mo mov time timev week weekv
    name-comp-host-language-label-43 name-comp-host-language-label-44 name-comp-host-language-label-45
    name-comp-host-language-label-46 name-comp-host-language-label-47 name-comp-host-language-label-48
    name-comp-host-language-label-51 name-comp-host-language-label-52 name-comp-host-language-label-67
    name-comp-host-language-label-68 name-comp-host-language-label-71 name-comp-host-language-label-72
    `,
  'implicit role: Chrome gives the element its own role (deletion, emphasis, meter, time…); ours gives generic': `
    name-comp-host-language-label-tentative-4 name-comp-host-language-label-tentative-7
    name-comp-label-94
    `,
  'value: Chrome and ours give different values': `
    lib-C10 name-comp-embedded-control-8 name-comp-embedded-control-10 name-comp-embedded-control-12
    name-comp-embedded-control-20 name-comp-embedded-control-22 name-comp-embedded-control-24
    name-comp-embedded-control-26 pwv name-comp-host-language-label-56 name-comp-label-38
    name-comp-label-49 name-comp-label-53 name-comp-label-54 name-comp-label-98
    `,
  'properties: Chrome and ours differ in orientation': `
    lib-L2 name-comp-label-33 name-comp-label-34 name-comp-label-63
    `,
  'properties: Chrome and ours differ in modal': `
    name-comp-label-2 name-comp-label-14 name-comp-name-from-heading-tentative-1
    name-comp-name-from-heading-tentative-3
    `,
  'properties: Chrome and ours differ in owns': `
    accname-aria-owns-7 accname-aria-owns-8 accname-aria-owns-9
    `,
  'properties: Chrome and ours differ in orientation, required': `
    name-comp-embedded-control-14 name-comp-label-27 name-comp-label-65
    `,
  'properties: Chrome and ours differ in atomic, live, relevant': `
    name-comp-label-1 name-comp-label-29 name-comp-label-55
    `,
  'ignored: Chrome exposes the node; ours ignores it': `
    name-comp-label-86 name-comp-label-104 name-comp-tooltip-tentative-1
    `,
  'properties: Chrome and ours differ in readonly, required': `
    lib-A4 name-comp-label-21
    `,
  'properties: Chrome and ours differ in selected': `
    lib-A15 name-comp-label-57
    `,
  'properties: Chrome and ours differ in focusable': `
    name-comp-name-from-content-display-contents-4 name-comp-name-from-content-display-contents-10
    `,
  'role: Chrome gives listitem; ours gives treeitem': `
    lib-A17
    `,
  'properties: Chrome and ours differ in atomic, invalid, live, relevant': `
    lib-C1
    `,
  'properties: Chrome and ours differ in activedescendant, orientation, required': `
    name-comp-embedded-control-6
    `,
  'properties: Chrome and ours differ in url': `
    name-comp-host-language-label-76
    `,
  'properties: Chrome and ours differ in hasPopup, required': `
    name-comp-label-11
    `,
  'properties: Chrome and ours differ in readonly': `
    name-comp-label-20
    `,
  'role: Chrome gives generic; ours gives listitem': `
    name-comp-label-28
    `,
  'role: Chrome gives generic; ours gives option': `
    name-comp-label-41
    `,
  'properties: Chrome and ours differ in valuemax, valuemin, valuetext': `
    name-comp-label-42
    `,
  'properties: Chrome and ours differ in required': `
    name-comp-label-44
    `,
  'properties: Chrome and ours differ in settable': `
    name-comp-label-52
    `,
  'properties: Chrome and ours differ in multiselectable, readonly, required': `
    name-comp-label-66
    `,
  'role: Chrome gives generic; ours gives treeitem': `
    name-comp-label-67
    `,
  'properties: Chrome and ours differ in focusable, modal': `
    name-comp-name-from-heading-tentative-5
    `,
  'description: Chrome and ours compute different descriptions': `
    html-aam-summary-1
    `,
};

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
