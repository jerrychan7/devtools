// Roles (and the states the library's isInaccessible and isDisabled read), compared with real
// Chrome one element at a time. The input HTML is in cases/roles.html, imported from
// dom-accessibility-api (commit a1828981f407b6cd6dc9d7b1046a618af93d0270; MIT License,
// Copyright (c) 2020 Sebastian Silbermann) and web-platform-tests (commit
// 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD License, Copyright ©
// web-platform-tests contributors). The expected values are Chrome's, not theirs.
import { describeCases, readCases } from '../../../../test-support/accessibility.ts';

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {
  'tbody: Chrome exposes a table body as rowgroup; ours ignores it': `
    lib-R112 html-aam-roles-tentative-2
    `,
  'layout table: Chrome takes the table for layout and gives LayoutTable, LayoutTableRow or LayoutTableCell; ours gives the table roles': `
    lib-R111 lib-R119 lib-R120 lib-R121
    `,
};

describeCases(readCases(new URL('cases/roles.html', import.meta.url)), { todo: TODO });
