// Accessible names by element, after web-platform-tests' html-aam/accname-computation-by-element
// (commit 73abd6299d0100763f0dfab7d30947282f626021; The 3-Clause BSD License, Copyright ©
// web-platform-tests contributors): each file's testConfig, and its pages built anew the way
// html-aam/scripts/html-aam-accname-utils.js builds them (buildNameComputationTest), compared with
// real Chrome one element at a time. The expected values are Chrome's, not WPT's.
import { describeCases } from '../../../../test-support/accessibility.ts';
import type { CaseGroup } from '../../../../test-support/accessibility.ts';

interface Properties {
  descendants?: string[];
  ancestors?: string[];
  attrs?: string[];
  specialContext?: 'area' | 'ruby' | 'rp' | 'rt';
}
interface Config {
  elements: Record<string, Properties>;
  nameSources: string[];
}

/** Each WPT file's testConfigs, in the order the file builds them (keys it ignores left out). */
const CONFIGS: Record<string, Config[]> = {
  a: [
    {
      elements: {
        a: {
          attrs: ['href'],
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from subtree',
        'from title',
        'to be empty',
      ],
    },
  ],
  area: [
    {
      elements: {
        area: {
          attrs: ['href'],
          specialContext: 'area',
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from alt',
        'from empty alt',
        'from title',
        'to be empty',
      ],
    },
  ],
  button: [
    {
      elements: {
        button: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from 2 labels',
        'from 1 label',
        'from encapsulating label',
        'from subtree',
        'from title',
        'to be empty',
      ],
    },
  ],
  fieldset: [
    {
      elements: {
        fieldset: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from first legend',
        'from title',
        'to be empty',
      ],
    },
  ],
  figure: [
    {
      elements: {
        figure: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from title',
        'to be empty',
      ],
    },
  ],
  iframe: [
    {
      elements: {
        iframe: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from title',
        'to be empty',
      ],
    },
  ],
  img: [
    {
      elements: {
        img: {
          attrs: ['img src'],
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from alt',
        'from empty alt',
        'from title',
        'from ancestor figure figcaption',
        'to be empty',
      ],
    },
  ],
  'input-button-submit-reset': [
    {
      elements: {
        'input[type="button"]': {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from 2 labels',
        'from 1 label',
        'from encapsulating label',
        'from value',
        'from title',
        'to be empty',
      ],
    },
    {
      elements: {
        'input[type="submit"]': {},
        'input[type="reset"]': {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from 2 labels',
        'from 1 label',
        'from encapsulating label',
        'from value',
      ],
    },
  ],
  'input-image': [
    {
      elements: {
        'input[type="image"]': {
          attrs: ['img src'],
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from 2 labels',
        'from 1 label',
        'from encapsulating label',
        'from alt',
        'from empty alt',
        'from title',
      ],
    },
  ],
  'inputs-with-placeholders': [
    {
      elements: {
        'input[type="email"]': {
          attrs: ['value'],
        },
        'input[type="number"]': {
          attrs: ['value'],
        },
        'input[type="password"]': {
          attrs: ['value'],
        },
        'input[type="search"]': {
          attrs: ['value'],
        },
        'input[type="tel"]': {
          attrs: ['value'],
        },
        'input[type="text"]': {
          attrs: ['value'],
        },
        'input[type="url"]': {
          attrs: ['value'],
        },
        textarea: {
          descendants: ['textNode'],
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from 2 labels',
        'from 1 label',
        'from encapsulating label',
        'from title',
        'from placeholder',
        'from aria-placeholder',
        'to be empty',
      ],
    },
  ],
  'other-form-elements': [
    {
      elements: {
        'input[type="checkbox"]': {},
        'input[type="radio"]': {},
        select: {
          descendants: ['option', 'textNode'],
        },
        'input[type="color"]': {},
        'input[type="date"]': {},
        'input[type="datetime-local"]': {},
        'input[type="file"]': {},
        'input[type="month"]': {},
        'input[type="range"]': {},
        'input[type="time"]': {},
        'input[type="week"]': {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from 2 labels',
        'from 1 label',
        'from title',
        'to be empty',
      ],
    },
    {
      elements: {
        optgroup: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from label attribute',
        'from title',
        'to be empty',
      ],
    },
  ],
  output: [
    {
      elements: {
        output: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from 2 labels',
        'from 1 label',
        'from title',
        'to be empty',
      ],
    },
  ],
  'phrasing-elements': [
    {
      elements: {
        dfn: {
          descendants: ['textNode'],
        },
        ruby: {
          specialContext: 'ruby',
        },
        hr: {},
        abbr: {
          descendants: ['textNode'],
        },
        b: {
          descendants: ['textNode'],
        },
        bdi: {
          descendants: ['textNode'],
        },
        bdo: {
          descendants: ['textNode'],
        },
        br: {},
        cite: {
          descendants: ['textNode'],
        },
        code: {
          descendants: ['textNode'],
        },
        em: {
          descendants: ['textNode'],
        },
        i: {
          descendants: ['textNode'],
        },
        kbd: {
          descendants: ['textNode'],
        },
        mark: {
          descendants: ['textNode'],
        },
        q: {
          descendants: ['textNode'],
        },
        rp: {
          specialContext: 'rp',
        },
        rt: {
          specialContext: 'rt',
        },
        s: {
          descendants: ['textNode'],
        },
        samp: {
          descendants: ['textNode'],
        },
        small: {
          descendants: ['textNode'],
        },
        strong: {
          descendants: ['textNode'],
        },
        sub: {
          descendants: ['textNode'],
        },
        sup: {
          descendants: ['textNode'],
        },
        time: {
          descendants: ['textNode'],
        },
        u: {
          descendants: ['textNode'],
        },
        var: {
          descendants: ['textNode'],
        },
        wbr: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from title',
        'to be empty',
      ],
    },
  ],
  'section-and-grouping-elements': [
    {
      elements: {
        header: {},
        nav: {},
        search: {},
        form: {},
        main: {},
        section: {},
        article: {},
        aside: {},
        footer: {},
        hgroup: {},
        dialog: {},
        address: {},
        application: {},
        audio: {},
        video: {},
        ul: {},
        ol: {},
        dl: {},
        meter: {},
        progress: {},
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from title',
        'to be empty',
      ],
    },
  ],
  summary: [
    {
      elements: {
        summary: {
          ancestors: ['details'],
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from subtree',
        'from title',
      ],
    },
  ],
  table: [
    {
      elements: {
        table: {
          descendants: ['tbody', 'tr', 'td', 'textNode'],
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from first caption',
        'from title',
        'to be empty',
      ],
    },
  ],
  'tr-td-th.tentative': [
    {
      elements: {
        tr: {
          ancestors: ['table', 'tbody'],
          descendants: ['td', 'textNode'],
        },
        th: {
          ancestors: ['table', 'thead', 'tr'],
          descendants: ['textNode'],
        },
        td: {
          ancestors: ['table', 'tbody', 'tr'],
          descendants: ['textNode'],
        },
        thead: {
          ancestors: ['table'],
          descendants: ['tr', 'th', 'textNode'],
        },
        tbody: {
          ancestors: ['table'],
          descendants: ['tr', 'td', 'textNode'],
        },
        tfoot: {
          ancestors: ['table'],
          descendants: ['tr', 'td', 'textNode'],
        },
      },
      nameSources: [
        'from 2 aria-labelledby refs',
        'from 1 aria-labelledby ref',
        'from aria-label',
        'from title',
        'to be empty',
      ],
    },
  ],
};

/**
 * Builds a WPT file's page into the body, as buildNameComputationTests does: for each element,
 * one case per name source, each with all the sources from it on. Runs in the page.
 */
function build(configs: Config[], prefix: string) {
  const nameValues: Record<string, string> = {
    'from 1 aria-labelledby ref': 'aria-labelledby ref element #1 text contents',
    'from 2 aria-labelledby refs': 'aria-labelledby ref element #2 text contents',
    'from aria-label': 'aria-label attribute value',
    'from 1 label': 'associated label #1 text contents',
    'from 2 labels': 'associated label #2 text contents',
    'from subtree': 'subtree text contents',
    'from encapsulating label': 'encapsulating label text contents',
    'from first legend': 'legend text contents',
    'from first caption': 'caption text contents',
    'from value': 'value attribute value',
    'from label attribute': 'label attribute value',
    'from alt': 'alt attribute value',
    'from empty alt': '',
    'from title': 'title attribute value',
    'from placeholder': 'placeholder attribute value',
    'from aria-placeholder': 'aria-placeholder attribute value',
    'from ancestor figure figcaption': 'ancestor figure figcaption text contents',
  };
  // A 50×50 PNG, so that the images have a size.
  const img =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAMAAAAp4XiDAAAAP1BMVEWqAKoAAACrAKuqAKqrAKuvAK+vAK+nAKepAKmsAKyrAKutAK2oAKixALGqAKqqAKqqAKqqAKqqAKqqAKqqAKqx+4SNAAAAFHRSTlMzAL9gQBAgIKCfKxQZBu/fr4BwUHCcwvYAAAEASURBVEjHvdbLEoMgDAVQbkKg9f3I/39rpdiZutHAgrtywZkxESEOxTmJCLwqA6SK9PgCXqoeUCWAVR3kQvZpRbwnETzzHyFd8BhS+iNxG4fO3aYLI8cfYQronSE9Au1fMisnYTGbTnIQYRqdMVhWybVEKxlyLS6gs5IOwR9EFc4cqNYRZjvJqwGUEKCOEJUQojYda1a+9yXEt9sw77edpNVtOlbxYm06VvEp23SsTfkVP3Kb8iuOvnYbpuyycLn8wUpCLl/WBVYyEksik269TQysMw6CnaL1Eo/EiaQEHuPTqDBgC5eBhPCY5TKQ8MzPY8867SfJEbh74iGCkxTnA3SZDugOkmV1AAAAAElFTkSuQmCC';
  const voids = new Set([
    'AREA',
    'BASE',
    'BR',
    'COL',
    'EMBED',
    'HR',
    'IMG',
    'INPUT',
    'LINK',
    'META',
    'PARAM',
    'SOURCE',
    'TRACK',
    'WBR',
  ]);
  let testId = 0;
  const parts: string[] = [];

  const special = (elTest: HTMLElement, context: string, id: number): HTMLElement | null => {
    const text = (parent: Node, tag: string, value: string) =>
      parent.appendChild(document.createElement(tag)).appendChild(document.createTextNode(value));
    if (context === 'area') {
      const map = document.createElement('map');
      const image = document.createElement('img');
      map.setAttribute('name', `map-${id}`);
      map.appendChild(elTest);
      image.setAttribute('usemap', `#map-${id}`);
      image.src = img;
      elTest.setAttribute('alt', 'Mapped image alt attribute value');
      elTest.setAttribute('shape', 'rect');
      elTest.setAttribute('coords', '0,0,20,20');
      const div = document.createElement('div');
      div.append(map, image);
      return div;
    }
    if (context === 'ruby') {
      elTest.appendChild(document.createTextNode('ruby text node contents'));
      text(elTest, 'rp', 'rp #1');
      text(elTest, 'rt', 'rt');
      text(elTest, 'rp', 'rp #2');
      return null;
    }
    const ruby = document.createElement('ruby');
    ruby.appendChild(document.createTextNode('ruby text node contents'));
    if (context === 'rp') {
      ruby.appendChild(elTest);
      elTest.appendChild(document.createTextNode('rp #1'));
      text(ruby, 'rt', 'rt');
    } else {
      text(ruby, 'rp', 'rp #1');
      ruby.appendChild(elTest);
      elTest.appendChild(document.createTextNode('rt'));
    }
    text(ruby, 'rp', 'rp #2');
    return ruby;
  };

  const one = (selector: string, nameSources: string[], properties: Properties) => {
    const id = ++testId;
    const [, element = '', attrName, attrValue] = /^(\w+)(?:\[(\w+)="([\w-]+)"\])?$/.exec(selector) ?? [];
    const expSource = nameSources[0];
    let preamble = `<h2>${selector} expecting name ${expSource}</h2>`;
    const elTest = document.createElement(element);
    if (attrName) elTest.setAttribute(attrName, attrValue ?? '');
    elTest.id = `${prefix}-el-${id}`;
    elTest.className = 'ex-label';
    if (properties.attrs?.includes('value')) elTest.setAttribute('value', `${element} value attribute value`);
    if (properties.attrs?.includes('href')) elTest.setAttribute('href', '#');
    if (properties.attrs?.includes('img src')) elTest.setAttribute('src', img);
    let elReturn: HTMLElement | null = null;
    if (properties.ancestors)
      elReturn = properties.ancestors.reduceRight<HTMLElement>((descendant, tag) => {
        const ancestor = document.createElement(tag);
        ancestor.appendChild(descendant);
        return ancestor;
      }, elTest);
    if (properties.descendants) {
      let tagPrevious = element;
      properties.descendants.reduce<Node>((ancestor, tag) => {
        const descendant =
          tag === 'textNode'
            ? document.createTextNode(`${tagPrevious} text node contents`)
            : document.createElement(tag);
        ancestor.appendChild(descendant);
        tagPrevious = tag;
        return descendant;
      }, elTest);
    }
    if (properties.specialContext) elReturn = special(elTest, properties.specialContext, id);
    elReturn ??= elTest;

    if (expSource === 'from ancestor figure figcaption') {
      const figure = document.createElement('figure');
      const figcaption = document.createElement('figcaption');
      figcaption.textContent = nameValues[expSource] ?? '';
      figure.append(elReturn, figcaption);
      elReturn = figure;
    }
    if (expSource === 'from encapsulating label') {
      const label = document.createElement('label');
      label.append(nameValues[expSource] ?? '', elReturn);
      elReturn = label;
    }
    if (nameSources.includes('from 1 label'))
      preamble += `<label for="${elTest.id}">${nameValues['from 1 label']}</label>`;
    if (nameSources.includes('from 2 labels'))
      preamble += `<label for="${elTest.id}">${nameValues['from 2 labels']}</label>`;
    if (nameSources.includes('from 1 aria-labelledby ref')) {
      preamble += `<p id="${elTest.id}-label-1">${nameValues['from 1 aria-labelledby ref']}</p>`;
      elTest.setAttribute('aria-labelledby', `${elTest.id}-label-1`);
    }
    if (nameSources.includes('from 2 aria-labelledby refs')) {
      preamble += `<p id="${elTest.id}-label-2">${nameValues['from 2 aria-labelledby refs']}</p>`;
      elTest.setAttribute('aria-labelledby', `${elTest.id}-label-1 ${elTest.id}-label-2`);
    }
    if (nameSources.includes('from subtree'))
      elTest.appendChild(document.createTextNode(`${element} ${nameValues['from subtree']}`));
    for (const source of ['from first legend', 'from first caption'])
      if (nameSources.includes(source)) {
        const child = source.replace('from first ', '');
        elTest.insertAdjacentHTML('afterbegin', `<${child}>Duplicate ${nameValues[source]}</${child}>`);
        elTest.insertAdjacentHTML('afterbegin', `<${child}>${nameValues[source]}</${child}>`);
      }
    for (const source of [
      'from aria-label',
      'from aria-placeholder',
      'from value',
      'from alt',
      'from title',
      'from placeholder',
      'from label attribute',
    ])
      if (nameSources.includes(source)) {
        const attr = source.replace('from ', '').replace(' attribute', '');
        elTest.setAttribute(
          attr,
          source === 'from alt' ? (nameValues[source] ?? '') : `${element} ${nameValues[source]}`
        );
      }
    if (expSource === 'from empty alt') elTest.setAttribute('alt', '');
    if (!elTest.hasChildNodes() && !voids.has(elTest.nodeName)) {
      const image = document.createElement('img');
      image.src = img;
      elTest.appendChild(image);
    }
    parts.push(preamble + elReturn.outerHTML);
  };

  for (const config of configs)
    for (const [selector, properties] of Object.entries(config.elements))
      for (let i = 0; i < config.nameSources.length; i++) one(selector, config.nameSources.slice(i), properties);
  document.body.insertAdjacentHTML('beforeend', `<h1>${prefix}</h1>` + parts.join(''));
}

/**
 * Cases whose node Chrome gives text in the browser's language: the default name of an image
 * input, the file input's button and label, the video's "cannot play" message.
 */
const LOCALIZED = new Set([
  ...Array.from({ length: 9 }, (_, i) => `input-image-el-${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `other-form-elements-el-${i + 43}`),
  ...Array.from({ length: 5 }, (_, i) => `section-and-grouping-elements-el-${i + 71}`),
]);

const groups: CaseGroup[] = Object.entries(CONFIGS).map(([file, configs]) => {
  const ids: string[] = [];
  for (const config of configs)
    for (const _ of Object.keys(config.elements))
      for (const __ of config.nameSources) ids.push(`${file}-el-${ids.length + 1}`);
  return {
    name: `wpt html-aam/accname-computation-by-element/${file}.html`,
    html: '',
    ids: ids.filter(id => !LOCALIZED.has(id)),
  };
});

/** Cases that differ from Chrome on the current implementation, by what differs. */
const TODO = {
  'Chrome gives one of its internal roles (Abbr, Canvas, DateTime, LayoutTable…); ours gives an ARIA role': `
    other-form-elements-el-22 other-form-elements-el-23 other-form-elements-el-24
    other-form-elements-el-25 other-form-elements-el-26 other-form-elements-el-27
    other-form-elements-el-28 other-form-elements-el-29 other-form-elements-el-30
    other-form-elements-el-31 other-form-elements-el-32 other-form-elements-el-33
    other-form-elements-el-34 other-form-elements-el-35 other-form-elements-el-36
    other-form-elements-el-37 other-form-elements-el-38 other-form-elements-el-39
    other-form-elements-el-40 other-form-elements-el-41 other-form-elements-el-42
    other-form-elements-el-50 other-form-elements-el-51 other-form-elements-el-52
    other-form-elements-el-53 other-form-elements-el-54 other-form-elements-el-55
    other-form-elements-el-56 other-form-elements-el-64 other-form-elements-el-65
    other-form-elements-el-66 other-form-elements-el-67 other-form-elements-el-68
    other-form-elements-el-69 other-form-elements-el-70 other-form-elements-el-71
    other-form-elements-el-72 other-form-elements-el-73 other-form-elements-el-74
    other-form-elements-el-75 other-form-elements-el-76 other-form-elements-el-77 phrasing-elements-el-6
    phrasing-elements-el-7 phrasing-elements-el-8 phrasing-elements-el-9 phrasing-elements-el-10
    phrasing-elements-el-36 phrasing-elements-el-37 phrasing-elements-el-38 phrasing-elements-el-39
    phrasing-elements-el-40 table-el-5 table-el-6 tr-td-th.tentative-el-1 tr-td-th.tentative-el-2
    tr-td-th.tentative-el-3 tr-td-th.tentative-el-4 tr-td-th.tentative-el-5 tr-td-th.tentative-el-11
    tr-td-th.tentative-el-12 tr-td-th.tentative-el-13 tr-td-th.tentative-el-14 tr-td-th.tentative-el-15
    `,
  'implicit role: Chrome gives the element its own role (deletion, emphasis, meter, time…); ours gives generic': `
    section-and-grouping-elements-el-91 section-and-grouping-elements-el-92
    section-and-grouping-elements-el-93 section-and-grouping-elements-el-94
    section-and-grouping-elements-el-95
    `,
  'name sources: same name, different source list': `
    input-button-submit-reset-el-1 input-button-submit-reset-el-2 input-button-submit-reset-el-3
    input-button-submit-reset-el-4 input-button-submit-reset-el-5 input-button-submit-reset-el-6
    input-button-submit-reset-el-7 input-button-submit-reset-el-10 input-button-submit-reset-el-11
    input-button-submit-reset-el-12 input-button-submit-reset-el-13 input-button-submit-reset-el-14
    input-button-submit-reset-el-15 input-button-submit-reset-el-16 input-button-submit-reset-el-17
    input-button-submit-reset-el-18 input-button-submit-reset-el-19 input-button-submit-reset-el-20
    input-button-submit-reset-el-21 input-button-submit-reset-el-22 input-button-submit-reset-el-23
    other-form-elements-el-78 other-form-elements-el-79 other-form-elements-el-80
    `,
  'properties: Chrome and ours differ in invalid': `
    inputs-with-placeholders-el-1 inputs-with-placeholders-el-2 inputs-with-placeholders-el-3
    inputs-with-placeholders-el-4 inputs-with-placeholders-el-5 inputs-with-placeholders-el-6
    inputs-with-placeholders-el-7 inputs-with-placeholders-el-8 inputs-with-placeholders-el-9
    inputs-with-placeholders-el-10 inputs-with-placeholders-el-61 inputs-with-placeholders-el-62
    inputs-with-placeholders-el-63 inputs-with-placeholders-el-64 inputs-with-placeholders-el-65
    inputs-with-placeholders-el-66 inputs-with-placeholders-el-67 inputs-with-placeholders-el-68
    inputs-with-placeholders-el-69 inputs-with-placeholders-el-70
    `,
  'ignored: Chrome exposes the node; ours ignores it': `
    area-el-1 area-el-2 area-el-3 area-el-4 area-el-5 area-el-6 area-el-7 img-el-5
    tr-td-th.tentative-el-21 tr-td-th.tentative-el-22 tr-td-th.tentative-el-23 tr-td-th.tentative-el-24
    tr-td-th.tentative-el-25
    `,
  'value: Chrome and ours give different values': `
    inputs-with-placeholders-el-21 inputs-with-placeholders-el-22 inputs-with-placeholders-el-23
    inputs-with-placeholders-el-24 inputs-with-placeholders-el-25 inputs-with-placeholders-el-26
    inputs-with-placeholders-el-27 inputs-with-placeholders-el-28 inputs-with-placeholders-el-29
    inputs-with-placeholders-el-30
    `,
  'ignored: Chrome ignores the node; ours exposes it': `
    phrasing-elements-el-81 phrasing-elements-el-82 phrasing-elements-el-83 phrasing-elements-el-84
    phrasing-elements-el-85 phrasing-elements-el-131 phrasing-elements-el-132 phrasing-elements-el-133
    phrasing-elements-el-134 phrasing-elements-el-135
    `,
  'properties: Chrome and ours differ in atomic, invalid, live, relevant': `
    output-el-1 output-el-2 output-el-3 output-el-4 output-el-5 output-el-6 output-el-7
    `,
  'description: Chrome and ours compute different descriptions': `
    summary-el-1 summary-el-2 summary-el-3 table-el-1 table-el-2 table-el-3
    `,
  'name: Chrome and ours compute different names': `
    button-el-6 inputs-with-placeholders-el-76 other-form-elements-el-81
    `,
};

describeCases(groups, {
  todo: TODO,
  setups: Object.fromEntries(
    Object.entries(CONFIGS).map(([file, configs]) => [
      `wpt html-aam/accname-computation-by-element/${file}.html`,
      `(${build.toString()})(${JSON.stringify(configs)}, ${JSON.stringify(file)})`,
    ])
  ),
});
