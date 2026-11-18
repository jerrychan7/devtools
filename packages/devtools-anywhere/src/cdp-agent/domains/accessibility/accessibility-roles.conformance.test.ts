// Roles (and the states the library's isInaccessible and isDisabled read), compared with real
// Chrome one element at a time. The input HTML is in cases/roles.html, imported from
// dom-accessibility-api (commit a1828981f407b6cd6dc9d7b1046a618af93d0270; MIT License,
// Copyright (c) 2020 Sebastian Silbermann) and web-platform-tests (commit
// 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD License, Copyright ©
// web-platform-tests contributors). The expected values are Chrome's, not theirs.
import { describeCases, readCases } from '../../../../test-support/accessibility.ts';

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {
  'role attribute with no valid first token (invalid, abstract, case or Unicode variant): Chrome falls back to the next token or the implicit role; ours takes the token as is': `
    html-aam-roles-minimum-tentative-9 role-abstract-roles-1 role-abstract-roles-2 role-abstract-roles-3
    role-abstract-roles-4 role-abstract-roles-5 role-abstract-roles-6 role-abstract-roles-7
    role-abstract-roles-8 role-abstract-roles-9 role-abstract-roles-10 role-abstract-roles-11
    role-abstract-roles-12 role-fallback-roles-4 role-fallback-roles-5 role-fallback-roles-6
    role-fallback-roles-7 role-fallback-roles-8 role-fallback-roles-9 role-fallback-roles-12
    role-fallback-roles-13 role-fallback-roles-14 role-fallback-roles-15 role-fallback-roles-16
    role-fallback-roles-17 role-fallback-roles-18 role-fallback-roles-19 role-fallback-roles-20
    role-fallback-roles-21 role-fallback-roles-22 role-invalid-roles-1 role-invalid-roles-2
    role-invalid-roles-3 role-invalid-roles-4 role-invalid-roles-5 role-invalid-roles-6
    role-invalid-roles-7 role-invalid-roles-8 role-invalid-roles-9 role-invalid-roles-10
    role-invalid-roles-11 role-invalid-roles-12 role-invalid-roles-16 role-invalid-roles-17
    role-invalid-roles-18 role-invalid-roles-20 role-invalid-roles-24 role-invalid-roles-25
    role-invalid-roles-26 role-invalid-roles-28 role-invalid-roles-32 role-invalid-roles-33
    role-invalid-roles-36 role-invalid-roles-37 role-invalid-roles-38 role-invalid-roles-39
    role-invalid-roles-40 role-invalid-roles-41 role-invalid-roles-42 role-invalid-roles-43
    role-invalid-roles-44 role-invalid-roles-45 role-invalid-roles-46 role-invalid-roles-47
    role-invalid-roles-48 role-invalid-roles-49 role-invalid-roles-50 role-invalid-roles-51
    role-invalid-roles-52 role-invalid-roles-53 role-invalid-roles-54 role-invalid-roles-55
    role-invalid-roles-56 role-invalid-roles-57 role-invalid-roles-58 role-invalid-roles-59
    role-invalid-roles-60 role-invalid-roles-61 role-invalid-roles-62 role-invalid-roles-63
    role-invalid-roles-64 role-invalid-roles-65 role-invalid-roles-66 role-invalid-roles-67
    role-invalid-roles-68 role-invalid-roles-69 role-invalid-roles-70 role-invalid-roles-71
    role-invalid-roles-72 role-invalid-roles-73 role-invalid-roles-74 role-invalid-roles-75
    role-invalid-roles-76
    `,
  'ignored: Chrome exposes the node; ours ignores it': `
    lib-R112 lib-R125 lib-R126 lib-R127 lib-R128 lib-R129 lib-E7 lib-E8 lib-E9 lib-E10 lib-E11 lib-E12
    html-aam-area-role-1 html-aam-area-role-2 html-aam-img-src-srcset-roles-tentative-17
    html-aam-img-src-srcset-roles-tentative-18 html-aam-img-src-srcset-roles-tentative-19
    html-aam-img-src-srcset-roles-tentative-20 html-aam-img-src-srcset-roles-tentative-21
    html-aam-img-src-srcset-roles-tentative-22 html-aam-img-src-srcset-roles-tentative-23
    html-aam-img-src-srcset-roles-tentative-24 html-aam-img-src-srcset-roles-tentative-25
    html-aam-img-src-srcset-roles-tentative-26 html-aam-img-src-srcset-roles-tentative-28
    html-aam-roles-contextual-25 html-aam-roles-contextual-26 html-aam-roles-contextual-27
    html-aam-roles-contextual-28 html-aam-roles-contextual-29 html-aam-roles-tentative-2
    role-role-none-conflict-resolution-1 role-role-none-conflict-resolution-2
    `,
  'implicit role: Chrome gives the element its own role (deletion, emphasis, meter, time…); ours gives generic': `
    lib-R4 lib-R20 lib-R26 lib-R40 lib-R73 lib-R83 lib-R105 lib-R108 lib-R110 lib-R117
    html-aam-dir-role-tentative-1 html-aam-roles-minimum-tentative-2 html-aam-roles-minimum-tentative-5
    html-aam-roles-minimum-tentative-14 html-aam-roles-5 html-aam-roles-7 html-aam-roles-9
    html-aam-roles-12 html-aam-roles-22 html-aam-roles-42 html-aam-roles-46 html-aam-roles-48
    html-aam-roles-55 html-aam-roles-58 html-aam-roles-59 html-aam-roles-60 html-aam-roles-61
    role-role-none-conflict-resolution-4 role-role-none-conflict-resolution-5 irn irnro
    `,
  'name: Chrome and ours compute different names': `
    role-roles-contextual-7 html-aam-img-src-srcset-roles-tentative-38
    html-aam-img-src-srcset-roles-tentative-39 html-aam-img-src-srcset-roles-tentative-40
    html-aam-img-src-srcset-roles-tentative-41 html-aam-img-src-srcset-roles-tentative-42
    html-aam-img-src-srcset-roles-tentative-43 html-aam-img-src-srcset-roles-tentative-44
    html-aam-img-src-srcset-roles-tentative-45 html-aam-img-src-srcset-roles-tentative-46
    html-aam-img-src-srcset-roles-tentative-47 html-aam-img-src-srcset-roles-tentative-48
    html-aam-img-src-srcset-roles-tentative-49 html-aam-optgroup-role-tentative-1
    html-aam-roles-contextual-20 html-aam-roles-contextual-37 role-grid-roles-2 role-grid-roles-7
    role-tree-roles-2 role-tree-roles-6
    `,
  'name sources: same name, different source list': `
    lib-R102 lib-E1 lib-E2 lib-E3 role-roles-contextual-8 html-aam-img-src-srcset-roles-tentative-34
    html-aam-roles-contextual-21 html-aam-roles-contextual-38 html-aam-roles-27 html-aam-roles-35
    html-aam-roles-38 html-aam-roles-51
    `,
  'Chrome gives one of its internal roles (Abbr, Canvas, DateTime, LayoutTable…); ours gives an ARIA role': `
    lib-R3 lib-R14 lib-R43 lib-R80 lib-R86 lib-R111 lib-R119 lib-R120 lib-R121
    `,
  'ignored: Chrome ignores the node; ours exposes it': `
    lib-R16 lib-R17 lib-R27 lib-R79 lib-R85 lib-R103 lib-R107 lib-R122
    role-role-none-conflict-resolution-spec-ambiguities-tentative-1
    `,
  'properties: Chrome and ours differ in url': `
    html-aam-img-src-srcset-roles-tentative-5 html-aam-img-src-srcset-roles-tentative-6
    html-aam-img-src-srcset-roles-tentative-7 html-aam-img-src-srcset-roles-tentative-9
    html-aam-img-src-srcset-roles-tentative-11 html-aam-img-src-srcset-roles-tentative-13
    html-aam-img-src-srcset-roles-tentative-15 html-aam-img-src-srcset-roles-tentative-30
    html-aam-img-src-srcset-roles-tentative-32
    `,
  'role: Chrome gives generic; ours gives region': `
    role-roles-contextual-2 role-roles-contextual-3 role-roles-contextual-4 role-roles-contextual-6
    html-aam-roles-contextual-33 html-aam-roles-contextual-34 html-aam-roles-contextual-36
    `,
  'properties: Chrome and ours differ in orientation, required': `
    lib-R100 html-aam-roles-57 role-listbox-roles-1 role-listbox-roles-5 role-tree-roles-1
    `,
  'properties: Chrome and ours differ in selected': `
    role-listbox-roles-2 role-listbox-roles-4 role-listbox-roles-6 role-tab-roles-2 role-tab-roles-27
    `,
  'role: Chrome gives textbox; ours gives combobox': `
    lib-R65 lib-R67 lib-R68 lib-R69
    `,
  'properties: Chrome and ours differ in orientation': `
    role-empty-container-roles-tentative-3 role-empty-container-roles-tentative-4 role-menu-roles-1
    role-menu-roles-7
    `,
  'role: Chrome gives generic; ours gives complementary': `
    html-aam-roles-contextual-16 html-aam-roles-contextual-17 html-aam-roles-contextual-19
    `,
  'properties: Chrome and ours differ in atomic, invalid, live, relevant': `
    lib-R90 html-aam-roles-52
    `,
  'value: Chrome and ours give different values': `
    lib-R98 lib-R99
    `,
  'properties: Chrome and ours differ in pressed': `
    role-button-roles-8 role-button-roles-9
    `,
  'properties: Chrome and ours differ in readonly, required': `
    role-grid-roles-5 role-tree-roles-7
    `,
  'role: Chrome gives generic; ours gives cell': `
    role-role-none-conflict-resolution-spec-ambiguities-tentative-2
    role-role-none-conflict-resolution-spec-ambiguities-tentative-3
    `,
  'role: Chrome gives list; ours gives directory': `
    directory div
    `,
  'role: Chrome gives searchbox; ours gives combobox': `
    lib-R66
    `,
  'properties: Chrome and ours differ in multiselectable, orientation, required': `
    lib-R101
    `,
  'properties: Chrome and ours differ in focusable, modal': `
    html-aam-roles-10
    `,
  'properties: Chrome and ours differ in editable, hasPopup, required, settable': `
    html-aam-roles-37
    `,
  'role: Chrome gives group; ours gives region': `
    role-fallback-roles-1
    `,
  'role: Chrome gives navigation; ours gives form': `
    role-form-roles-1
    `,
  'properties: Chrome and ours differ in readonly': `
    role-grid-roles-1
    `,
  'role: Chrome gives navigation; ours gives region': `
    role-region-roles-1
    `,
  'properties: Chrome and ours differ in level, selected': `
    role-tree-roles-4
    `,
  'properties: Chrome and ours differ in multiselectable, readonly, required': `
    role-tree-roles-5
    `,
};

describeCases(readCases(new URL('cases/roles.html', import.meta.url)), { todo: TODO });
