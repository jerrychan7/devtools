import { FORCE_ATTRIBUTE, OWN_ATTRIBUTE } from '../core/nodes'

const FORCEABLE = /:(hover|focus-within|focus-visible|focus|active|visited|target)(?![\w-])/g

/**
 * Emulates CSS.forcePseudoState. Page scripts cannot put an element into :hover (or
 * :focus, …), so forced elements get a marker attribute, and every rule using a forced
 * pseudo-class gets a copy whose selector uses the marker instead.
 *
 * The copies go into a "companion" style sheet inserted right after each original sheet,
 * and after the first copied rule the companion replays all following rules of the original
 * sheet: the cascade order, which decides between rules of equal specificity, stays exactly
 * as if the pseudo-class matched. The page's own style sheets are not modified.
 */
export class ForcedPseudoClasses {
  private forced = new Map<Element, Set<string>>()
  private companions: HTMLStyleElement[] = []

  constructor(
    private sheets: () => CSSStyleSheet[],
    private rulesOf: (sheet: CSSStyleSheet | CSSGroupingRule) => CSSRule[]
  ) {}

  /** Pseudo-classes forced on at least one element. */
  private active(): Set<string> {
    const all = new Set<string>()
    for (const classes of this.forced.values()) classes.forEach(c => all.add(c))
    return all
  }

  /** `selector` with forced pseudo-classes replaced by the marker attribute. */
  rewrite(selector: string): string {
    const active = this.active()
    if (!active.size) return selector
    return selector.replace(FORCEABLE, (match, name: string) => (active.has(name) ? `[${FORCE_ATTRIBUTE}~="${name}"]` : match))
  }

  set(el: Element, classes: string[]) {
    const known = classes.filter(c => /^(hover|focus-within|focus-visible|focus|active|visited|target)$/.test(c))
    if (known.length) {
      this.forced.set(el, new Set(known))
      el.setAttribute(FORCE_ATTRIBUTE, known.join(' '))
    } else {
      this.forced.delete(el)
      el.removeAttribute(FORCE_ATTRIBUTE)
    }
    this.rebuild()
  }

  clear() {
    for (const el of this.forced.keys()) el.removeAttribute(FORCE_ATTRIBUTE)
    this.forced.clear()
    this.rebuild()
  }

  get isActive() {
    return this.forced.size > 0
  }

  /** Recreates the companion sheets, e.g. after the page's style sheets changed. */
  rebuild() {
    this.companions.forEach(style => style.remove())
    this.companions = []
    if (!this.forced.size) return
    for (const sheet of this.sheets()) {
      const owner = sheet.ownerNode
      if (!(owner instanceof Element) || !owner.isConnected) continue
      const text = this.companionText(this.rulesOf(sheet))
      if (!text) continue
      const style = document.createElement('style')
      style.setAttribute(OWN_ATTRIBUTE, 'forced-pseudo-classes')
      style.textContent = text
      owner.after(style)
      this.companions.push(style)
    }
  }

  private companionText(rules: CSSRule[]): string {
    let started = false
    const walk = (list: CSSRule[]): string => {
      let out = ''
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          const rewritten = this.rewrite(rule.selectorText)
          if (rewritten !== rule.selectorText) {
            out += `${rewritten} { ${rule.style.cssText} }\n`
            started = true
          } else if (started) {
            out += rule.cssText + '\n'
          }
        } else if (rule instanceof CSSGroupingRule) {
          const inner = walk(this.rulesOf(rule))
          if (inner) out += `${rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()} {\n${inner}}\n`
        }
      }
      return out
    }
    return walk(rules)
  }
}
