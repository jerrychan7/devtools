// Names and descriptions of web-platform-tests' manual accname tests and dom-accessibility-api's
// description tests, compared with real Chrome one element at a time. The input HTML is in
// cases/manual.html, imported from dom-accessibility-api (commit
// a1828981f407b6cd6dc9d7b1046a618af93d0270; MIT License, Copyright (c) 2020 Sebastian Silbermann)
// and web-platform-tests (commit 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD
// License, Copyright © web-platform-tests contributors). The expected values are Chrome's, not theirs.
import { describeCases, readCases } from '../../../../test-support/accessibility.ts';

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {
  'name: Chrome and ours compute different names': `
    m-name-checkbox-label-embedded-menu m-name-file-label-inline-block-styles m-name-from-content
    m-name-from-content-of-label m-name-from-content-of-labelledby-element m-name-link-mixed-content
    m-name-password-label-embedded-menu m-name-radio-label-embedded-menu m-name-test-case-548
    m-name-test-case-617 m-name-test-case-618 m-name-test-case-619 m-name-test-case-620
    m-name-test-case-659 m-name-test-case-660 m-name-test-case-661 m-name-test-case-662
    m-name-test-case-727 m-name-test-case-733 m-name-test-case-734 m-name-test-case-735
    m-name-test-case-738 m-name-test-case-743 m-name-text-label-embedded-menu
    `,
  'properties: the same ones, in another order (Chrome lists describedby before url)': `
    lib-DS1 lib-DS2 lib-DS5 m-description-test-case-664 m-description-test-case-665
    m-description-test-case-666 m-description-test-case-772 m-description-test-case-773
    m-description-test-case-774 m-description-test-case-838 m-description-test-case-one-valid-reference
    `,
  'name sources: same name, different source list': `
    m-name-checkbox-label-multiple-label-alternative m-name-checkbox-label-multiple-label
    m-name-test-case-544 m-name-test-case-559
    `,
  'value: Chrome and ours give different values': `
    m-description-1-0-combobox-focusable m-name-1-0-combobox-focusable-alternative m-name-test-case-748
    `,
  'description: Chrome and ours compute different descriptions': `
    m-description-from-content-of-describedby-element
    m-name-from-content-of-labelledby-elements-one-of-which-is-hidden
    `,
  'properties: Chrome and ours differ in describedby': `
    m-description-test-case-broken-reference
    `,
  'ignored: Chrome exposes the node; ours ignores it': `
    m-name-test-case-566
    `,
};

describeCases(readCases(new URL('cases/manual.html', import.meta.url)), { todo: TODO });
