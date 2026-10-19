import type { Protocol } from 'devtools-protocol'
import { FRAME_ID, type Context } from '../core/context'
import { OWN_ATTRIBUTE, PSEUDO_TYPES, PseudoElement, type PseudoType } from '../core/nodes'
import { compareSpecificity, specificity, splitTopLevel } from '../core/selectors'
import { CdpError } from '../core/server'
import { resolveNode } from './dom'

type CSSStyle = Protocol.CSS.CSSStyle
type CSSProperty = Protocol.CSS.CSSProperty
type StyleOrigin = Protocol.CSS.StyleSheetOrigin

const INLINE_PREFIX = 'inline:'

/** A pseudo-element at the end of a selector: `a::before`, legacy `a:after`, `::marker`. */
const PSEUDO_SUFFIX =
  /(?:::(before|after|marker|first-line|first-letter|placeholder|selection|backdrop|file-selector-button|cue|(?:part|slotted|highlight|view-transition[\w-]*)\([^)]*\))|:(before|after|first-line|first-letter))$/i

/** Splits `a.b::before` into the host selector `a.b` and the pseudo-element `before`. */
function splitPseudoElement(selector: string): { host: string; pseudo: string | null } {
  const m = PSEUDO_SUFFIX.exec(selector)
  if (!m) return { host: selector, pseudo: null }
  const host = selector.slice(0, m.index).trim()
  return { host: host && !/[\s>+~]$/.test(host) ? host : `${host}*`, pseudo: (m[1] || m[2]).toLowerCase() }
}

/**
 * Serializes declarations as `name: value;` separated by spaces, the text the client edits.
 * Each declared property gets a range; longhands of shorthands follow without one.
 */
function buildStyle(styleSheetId: string, decl: CSSStyleDeclaration, line: number, column: number): CSSStyle {
  const cssProperties: CSSProperty[] = []
  const shorthandEntries: Protocol.CSS.ShorthandEntry[] = []
  const probe = document.createElement('div').style
  let text = ''
  for (const raw of splitTopLevel(decl.cssText, ';')) {
    const colon = raw.indexOf(':')
    if (colon < 0) continue
    const name = raw.slice(0, colon).trim()
    let value = raw.slice(colon + 1).trim()
    if (!name) continue
    const important = /!\s*important$/i.test(value)
    if (important) value = value.replace(/\s*!\s*important$/i, '')
    const declText = `${name}: ${value}${important ? ' !important' : ''};`
    if (text) text += ' '
    const start = column + text.length
    text += declText
    cssProperties.push({
      name,
      value,
      important,
      implicit: false,
      text: declText,
      parsedOk: true,
      disabled: false,
      range: { startLine: line, startColumn: start, endLine: line, endColumn: start + declText.length },
    })
    // Expand shorthands into their longhands, like Chrome does.
    probe.cssText = `${name}: ${value}`
    const longhands = Array.from({ length: probe.length }, (_, i) => probe[i])
    if (longhands.length > 1 || (longhands.length === 1 && longhands[0] !== name)) {
      shorthandEntries.push({ name, value, important })
      for (const longhand of longhands) {
        cssProperties.push({ name: longhand, value: probe.getPropertyValue(longhand), important, implicit: false })
      }
    }
  }
  return {
    styleSheetId,
    cssProperties,
    shorthandEntries,
    cssText: text,
    range: { startLine: line, startColumn: column, endLine: line, endColumn: column + text.length },
  }
}

interface Entry {
  rule: CSSStyleRule
  media: Protocol.CSS.CSSMedia[]
}

/**
 * Tracks the page's style sheets. Every style rule gets a stable id within its sheet, which
 * also serves as its line in the text served by CSS.getStyleSheetText (one rule per line),
 * so ranges the client sends back keep pointing at the same rule even if the page adds or
 * removes rules in between.
 */
class SheetRegistry {
  private sheetIds = new WeakMap<CSSStyleSheet, string>()
  private sheets = new Map<string, CSSStyleSheet>()
  private ruleIds = new WeakMap<CSSStyleRule, number>()
  private nextRuleId = new WeakMap<CSSStyleSheet, number>()
  private seq = 0
  inspectorSheet: CSSStyleSheet | null = null

  idOf(sheet: CSSStyleSheet): string {
    let id = this.sheetIds.get(sheet)
    if (!id) {
      id = `sheet-${++this.seq}`
      this.sheetIds.set(sheet, id)
      this.sheets.set(id, sheet)
    }
    return id
  }

  get(styleSheetId: string): CSSStyleSheet {
    const sheet = this.sheets.get(styleSheetId)
    if (!sheet) throw new CdpError('No style sheet with given id found')
    return sheet
  }

  /** Document style sheets, including @import-ed ones, that we can read. */
  all(): CSSStyleSheet[] {
    const result: CSSStyleSheet[] = []
    const visit = (sheet: CSSStyleSheet) => {
      result.push(sheet)
      for (const rule of this.rulesOf(sheet)) if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet)
    }
    Array.from(document.styleSheets).forEach(visit)
    return result
  }

  /**
   * Copies of cross-origin sheets, whose rules page scripts cannot read: the CSS text is
   * fetched again (which needs CORS headers) and parsed. null: the fetch failed.
   */
  private copies = new WeakMap<CSSStyleSheet, CSSStyleSheet | null>()
  private loading = new Map<CSSStyleSheet, Promise<void>>()

  rulesOf(sheet: CSSStyleSheet | CSSGroupingRule): CSSRule[] {
    try {
      return Array.from(sheet.cssRules)
    } catch {
      const copy = sheet instanceof CSSStyleSheet ? this.copies.get(sheet) : null
      return copy ? Array.from(copy.cssRules) : []
    }
  }

  /** Whether the sheet's rules come from a fetched copy, so editing them has no effect. */
  isCopy(sheet: CSSStyleSheet): boolean {
    try {
      void sheet.cssRules
      return false
    } catch {
      return !!this.copies.get(sheet)
    }
  }

  /** Fetches copies of the cross-origin sheets not loaded yet; resolves when all are done. */
  loadCopies(onLoaded: (sheet: CSSStyleSheet) => void): Promise<void> {
    for (const sheet of this.all()) {
      if (!sheet.href || this.copies.has(sheet) || this.loading.has(sheet)) continue
      try {
        void sheet.cssRules
        continue
      } catch {
        // Cross-origin: load a copy below.
      }
      const load = fetch(sheet.href, { credentials: 'omit' })
        .then(res => (res.ok ? res.text() : Promise.reject(new Error(res.statusText))))
        .then(text => {
          const copy = new CSSStyleSheet()
          copy.replaceSync(text)
          this.copies.set(sheet, copy)
          onLoaded(sheet)
        })
        .catch(() => void this.copies.set(sheet, null))
        .finally(() => this.loading.delete(sheet))
      this.loading.set(sheet, load)
    }
    return Promise.all(this.loading.values()).then(() => {})
  }

  ruleId(sheet: CSSStyleSheet, rule: CSSStyleRule): number {
    let id = this.ruleIds.get(rule)
    if (id === undefined) {
      id = this.nextRuleId.get(sheet) ?? 0
      this.nextRuleId.set(sheet, id + 1)
      this.ruleIds.set(rule, id)
    }
    return id
  }

  /** Style rules of a sheet in order, with the @media rules around them. */
  entries(sheet: CSSStyleSheet, onlyActive = false): Entry[] {
    const result: Entry[] = []
    const sheetId = this.idOf(sheet)
    const visit = (rules: CSSRule[], media: Protocol.CSS.CSSMedia[]) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          this.ruleId(sheet, rule)
          result.push({ rule, media })
        } else if (rule instanceof CSSMediaRule) {
          if (onlyActive && !matchMedia(rule.conditionText).matches) continue
          visit(this.rulesOf(rule), [{ text: rule.conditionText, source: 'mediaRule', styleSheetId: sheetId }, ...media])
        } else if (rule instanceof CSSSupportsRule) {
          if (onlyActive && !CSS.supports(rule.conditionText)) continue
          visit(this.rulesOf(rule), media)
        } else if (rule instanceof CSSGroupingRule) {
          visit(this.rulesOf(rule), media)
        }
      }
    }
    visit(this.rulesOf(sheet), [])
    return result
  }

  findRule(sheet: CSSStyleSheet, line: number): CSSStyleRule {
    const entry = this.entries(sheet).find(e => this.ruleIds.get(e.rule) === line)
    if (!entry) throw new CdpError('No rule at given range')
    return entry.rule
  }

  /** The text of a sheet with every style rule on the line of its id. */
  text(sheet: CSSStyleSheet): string {
    const lines: string[] = []
    for (const { rule } of this.entries(sheet)) {
      const id = this.ruleId(sheet, rule)
      while (lines.length < id) lines.push('')
      lines[id] = `${rule.selectorText} { ${buildStyle('', rule.style, 0, 0).cssText} }`
    }
    return lines.join('\n')
  }

  header(sheet: CSSStyleSheet): Protocol.CSS.CSSStyleSheetHeader {
    const text = this.text(sheet)
    const lines = text.split('\n')
    const isInspector = sheet === this.inspectorSheet
    return {
      styleSheetId: this.idOf(sheet),
      frameId: FRAME_ID,
      sourceURL: sheet.href ?? (isInspector ? '' : location.href),
      origin: isInspector ? 'inspector' : 'regular',
      title: sheet.title ?? '',
      disabled: sheet.disabled,
      isInline: !sheet.href && !isInspector,
      isMutable: isInspector,
      isConstructed: false,
      startLine: 0,
      startColumn: 0,
      length: text.length,
      endLine: lines.length - 1,
      endColumn: lines[lines.length - 1].length,
    }
  }
}

export function registerCss(ctx: Context) {
  const { server, nodes } = ctx
  const sheets = new SheetRegistry()
  let enabled = false
  let known = new Set<CSSStyleSheet>()
  let observer: MutationObserver | null = null

  const origin = (sheet: CSSStyleSheet): StyleOrigin => (sheet === sheets.inspectorSheet ? 'inspector' : 'regular')

  function header(sheet: CSSStyleSheet) {
    const h = sheets.header(sheet)
    if (sheet.ownerNode && sheet !== sheets.inspectorSheet) h.ownerNode = nodes.backendIdOf(sheet.ownerNode)
    return h
  }

  /** Reports added and removed sheets since the last call. */
  function syncSheets() {
    const current = new Set(sheets.all())
    for (const sheet of current) if (!known.has(sheet)) server.emit('CSS.styleSheetAdded', { header: header(sheet) })
    for (const sheet of known) if (!current.has(sheet)) server.emit('CSS.styleSheetRemoved', { styleSheetId: sheets.idOf(sheet) })
    known = current
    return loadCopies()
  }

  /** Loads copies of cross-origin sheets; the client re-reads a sheet once its copy is in. */
  const loadCopies = () =>
    sheets.loadCopies(sheet => server.emit('CSS.styleSheetChanged', { styleSheetId: sheets.idOf(sheet) }))

  /** Rules of fetched copies are shown, but editing them would not affect the page. */
  function assertEditable(sheet: CSSStyleSheet) {
    if (sheets.isCopy(sheet)) throw new CdpError('This style sheet comes from another origin and cannot be edited')
  }

  function ruleStyle(sheet: CSSStyleSheet, rule: CSSStyleRule): CSSStyle {
    const line = sheets.ruleId(sheet, rule)
    return buildStyle(sheets.idOf(sheet), rule.style, line, rule.selectorText.length + 3)
  }

  function selectorList(sheet: CSSStyleSheet, rule: CSSStyleRule): Protocol.CSS.SelectorList {
    const line = sheets.ruleId(sheet, rule)
    let column = 0
    const selectors = splitTopLevel(rule.selectorText, ',').map(raw => {
      const text = raw.trim()
      const start = column + raw.indexOf(text)
      column += raw.length + 1
      return { text, specificity: specificity(text), range: { startLine: line, startColumn: start, endLine: line, endColumn: start + text.length } }
    })
    return { selectors, text: rule.selectorText }
  }

  function cssRule(sheet: CSSStyleSheet, entry: Entry): Protocol.CSS.CSSRule {
    const rule: Protocol.CSS.CSSRule = {
      styleSheetId: sheets.idOf(sheet),
      selectorList: selectorList(sheet, entry.rule),
      origin: origin(sheet),
      style: ruleStyle(sheet, entry.rule),
    }
    if (entry.media.length) rule.media = entry.media
    return rule
  }

  /**
   * Rules matching `el`, or with `pseudo`, its pseudo-element, in cascade order (lowest
   * priority first). Selectors ending in a pseudo-element only match that pseudo-element.
   */
  function matchedRules(el: Element, pseudo: PseudoType | null = null): Protocol.CSS.RuleMatch[] {
    const matches: { match: Protocol.CSS.RuleMatch; spec: Protocol.CSS.Specificity; order: number }[] = []
    let order = 0
    for (const sheet of sheets.all()) {
      if (sheet.disabled) continue
      for (const entry of sheets.entries(sheet, true)) {
        order++
        const selectors = splitTopLevel(entry.rule.selectorText, ',').map(s => s.trim())
        const matching = selectors
          .map((selector, index) => {
            const split = splitPseudoElement(selector)
            if (split.pseudo !== pseudo) return -1
            try {
              return el.matches(split.host) ? index : -1
            } catch {
              return -1 // Unsupported selector.
            }
          })
          .filter(index => index >= 0)
        if (!matching.length) continue
        const spec = matching.map(i => specificity(selectors[i])).reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m))
        matches.push({ match: { rule: cssRule(sheet, entry), matchingSelectors: matching }, spec, order })
      }
    }
    // Inspector rules win over regular ones of equal specificity, as they come last.
    return matches
      .sort((x, y) => compareSpecificity(x.spec, y.spec) || x.order - y.order)
      .map(m => m.match)
  }

  function inlineStyle(el: Element): CSSStyle | undefined {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return undefined
    return buildStyle(INLINE_PREFIX + nodes.backendIdOf(el), el.style, 0, 0)
  }

  const element = (nodeId: number) => {
    const node = resolveNode(ctx, { nodeId })
    if (!(node instanceof Element)) throw new CdpError('Node is not an Element')
    return node
  }

  /** An element or a pseudo-element, as its host and pseudo type. */
  const target = (nodeId: number): { el: Element; pseudo: PseudoType | null } => {
    const node = nodes.get(nodeId)
    if (node instanceof PseudoElement) return { el: node.host, pseudo: node.pseudoType }
    return { el: element(nodeId), pseudo: null }
  }

  function inheritedEntries(from: Element | null): Protocol.CSS.InheritedStyleEntry[] {
    const inherited: Protocol.CSS.InheritedStyleEntry[] = []
    for (let parent = from; parent; parent = parent.parentElement) {
      const entry: Protocol.CSS.InheritedStyleEntry = { matchedCSSRules: matchedRules(parent) }
      const style = inlineStyle(parent)
      if (style) entry.inlineStyle = style
      inherited.push(entry)
    }
    return inherited
  }

  function applyEdit(edit: Protocol.CSS.StyleDeclarationEdit): CSSStyle {
    if (edit.styleSheetId.startsWith(INLINE_PREFIX)) {
      const el = ctx.nodes.getByBackendId(Number(edit.styleSheetId.slice(INLINE_PREFIX.length)))
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new CdpError('Node not found')
      el.setAttribute('style', edit.text)
      return buildStyle(edit.styleSheetId, el.style, 0, 0)
    }
    const sheet = sheets.get(edit.styleSheetId)
    assertEditable(sheet)
    const rule = sheets.findRule(sheet, edit.range.startLine)
    rule.style.cssText = edit.text
    return ruleStyle(sheet, rule)
  }

  server.register('CSS', {
    enable() {
      if (enabled) return
      enabled = true
      known = new Set()
      syncSheets()
      observer = new MutationObserver(records => {
        const touchesSheets = records.some(r =>
          [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some(
            n => n instanceof HTMLStyleElement || n instanceof HTMLLinkElement
          )
        )
        if (touchesSheets) syncSheets()
      })
      observer.observe(document, { childList: true, subtree: true })
      // A <link> stylesheet becomes available once loaded.
      document.addEventListener('load', syncSheets, true)
    },

    disable() {
      enabled = false
      observer?.disconnect()
      document.removeEventListener('load', syncSheets, true)
    },

    async getMatchedStylesForNode(
      params: Protocol.CSS.GetMatchedStylesForNodeRequest
    ): Promise<Protocol.CSS.GetMatchedStylesForNodeResponse> {
      const { el, pseudo } = target(params.nodeId)
      await loadCopies()
      // For a pseudo-element, its host is the first element it inherits from.
      if (pseudo) {
        return { matchedCSSRules: matchedRules(el, pseudo), pseudoElements: [], inherited: inheritedEntries(el), cssKeyframesRules: [] }
      }
      const pseudoElements = PSEUDO_TYPES.map(type => ({ pseudoType: type, matches: matchedRules(el, type) })).filter(
        p => p.matches.length
      )
      const result: Protocol.CSS.GetMatchedStylesForNodeResponse = {
        matchedCSSRules: matchedRules(el),
        pseudoElements,
        inherited: inheritedEntries(el.parentElement),
        cssKeyframesRules: [],
      }
      const style = inlineStyle(el)
      if (style) result.inlineStyle = style
      return result
    },

    getInlineStylesForNode(params: Protocol.CSS.GetInlineStylesForNodeRequest): Protocol.CSS.GetInlineStylesForNodeResponse {
      const { el, pseudo } = target(params.nodeId)
      const style = pseudo ? undefined : inlineStyle(el)
      return style ? { inlineStyle: style } : {}
    },

    getComputedStyleForNode(params: Protocol.CSS.GetComputedStyleForNodeRequest): Protocol.CSS.GetComputedStyleForNodeResponse {
      const { el, pseudo } = target(params.nodeId)
      const style = getComputedStyle(el, pseudo ? `::${pseudo}` : null)
      return {
        computedStyle: Array.from(style, name => ({ name, value: style.getPropertyValue(name) })),
        extraFields: { isAppearanceBase: false, isTableSetVisuallyTable: false },
      } as Protocol.CSS.GetComputedStyleForNodeResponse
    },

    getBackgroundColors(params: Protocol.CSS.GetBackgroundColorsRequest): Protocol.CSS.GetBackgroundColorsResponse {
      const { el, pseudo } = target(params.nodeId)
      const style = getComputedStyle(el, pseudo ? `::${pseudo}` : null)
      return {
        backgroundColors: [style.backgroundColor],
        computedFontSize: style.fontSize,
        computedFontWeight: style.fontWeight,
      }
    },

    getStyleSheetText: (params: Protocol.CSS.GetStyleSheetTextRequest): Protocol.CSS.GetStyleSheetTextResponse => ({
      text: sheets.text(sheets.get(params.styleSheetId)),
    }),

    setStyleSheetText(params: Protocol.CSS.SetStyleSheetTextRequest): Protocol.CSS.SetStyleSheetTextResponse {
      const owner = sheets.get(params.styleSheetId).ownerNode
      assertEditable(sheets.get(params.styleSheetId))
      if (!(owner instanceof HTMLStyleElement)) throw new CdpError('Style sheet is not editable')
      owner.textContent = params.text
      return {}
    },

    setStyleTexts(params: Protocol.CSS.SetStyleTextsRequest): Protocol.CSS.SetStyleTextsResponse {
      const styles = params.edits.map(applyEdit)
      ctx.refreshPseudoElements?.()
      return { styles }
    },

    setRuleSelector(params: Protocol.CSS.SetRuleSelectorRequest): Protocol.CSS.SetRuleSelectorResponse {
      const sheet = sheets.get(params.styleSheetId)
      assertEditable(sheet)
      const rule = sheets.findRule(sheet, params.range.startLine)
      rule.selectorText = params.selector
      ctx.refreshPseudoElements?.()
      return { selectorList: selectorList(sheet, rule) }
    },

    createStyleSheet(): Protocol.CSS.CreateStyleSheetResponse {
      if (!sheets.inspectorSheet?.ownerNode?.isConnected) {
        const style = document.createElement('style')
        style.setAttribute(OWN_ATTRIBUTE, 'inspector-stylesheet')
        document.head.appendChild(style)
        sheets.inspectorSheet = style.sheet
        known.add(style.sheet!)
        server.emit('CSS.styleSheetAdded', { header: header(style.sheet!) })
      }
      return { styleSheetId: sheets.idOf(sheets.inspectorSheet!) }
    },

    addRule(params: Protocol.CSS.AddRuleRequest): Protocol.CSS.AddRuleResponse {
      const sheet = sheets.get(params.styleSheetId)
      assertEditable(sheet)
      const index = sheet.insertRule(params.ruleText, sheet.cssRules.length)
      const rule = sheet.cssRules[index] as CSSStyleRule
      ctx.refreshPseudoElements?.()
      return { rule: cssRule(sheet, { rule, media: [] }) }
    },

    collectClassNames(params: Protocol.CSS.CollectClassNamesRequest): Protocol.CSS.CollectClassNamesResponse {
      const names = new Set<string>()
      for (const { rule } of sheets.entries(sheets.get(params.styleSheetId))) {
        for (const m of rule.selectorText.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1])
      }
      return { classNames: Array.from(names) }
    },

    getPlatformFontsForNode: (): Protocol.CSS.GetPlatformFontsForNodeResponse => ({ fonts: [] }),
    getMediaQueries: (): Protocol.CSS.GetMediaQueriesResponse => ({ medias: [] }),
    forcePseudoState: () => {},
    trackComputedStyleUpdates: () => {},
    takeComputedStyleUpdates: (): Protocol.CSS.TakeComputedStyleUpdatesResponse => ({ nodeIds: [] }),
    setEffectivePropertyValueForNode(params: Protocol.CSS.SetEffectivePropertyValueForNodeRequest) {
      ;(element(params.nodeId) as HTMLElement).style.setProperty(params.propertyName, params.value)
    },
  })
}
