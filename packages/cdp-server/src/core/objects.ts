import type { Protocol } from 'devtools-protocol'
import { CdpError } from './server'

type RemoteObject = Protocol.Runtime.RemoteObject
type ObjectPreview = Protocol.Runtime.ObjectPreview
type PropertyPreview = Protocol.Runtime.PropertyPreview
type PropertyDescriptor = Protocol.Runtime.PropertyDescriptor
type InternalPropertyDescriptor = Protocol.Runtime.InternalPropertyDescriptor
type Subtype = RemoteObject['subtype'] | 'internal#entry'

const MAX_OBJECT_PREVIEW = 5
const MAX_ARRAY_PREVIEW = 100
const MAX_ENTRY_PREVIEW = 5

/** An entry of a Map or Set, exposed under the `[[Entries]]` internal property. */
class InternalEntry {
  constructor(
    readonly value: unknown,
    readonly hasKey: boolean,
    readonly key?: unknown
  ) {}
}

const TypedArray = Object.getPrototypeOf(Int8Array)
const toTag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1)
const getter = (proto: object, key: PropertyKey) => Object.getOwnPropertyDescriptor(proto, key)!.get!

/** Returns true if `check` runs on `v` without throwing. */
function brand(v: unknown, check: (v: unknown) => unknown): boolean {
  try {
    check(v)
    return true
  } catch {
    return false
  }
}

const assertType = (value: unknown, type: string) => {
  if (typeof value !== type) throw new TypeError()
}

// Brand checks rely on internal slots: they work across realms (iframes) and do not
// mistake prototypes such as Map.prototype, whose toStringTag is also "Map", for instances.
const BRANDS: [Subtype, (v: unknown) => unknown][] = [
  ['typedarray', v => assertType(getter(TypedArray.prototype, Symbol.toStringTag).call(v), 'string')],
  ['map', v => Map.prototype.has.call(v as Map<unknown, unknown>, undefined)],
  ['set', v => Set.prototype.has.call(v as Set<unknown>, undefined)],
  ['weakmap', v => WeakMap.prototype.has.call(v as WeakMap<object, unknown>, {})],
  ['weakset', v => WeakSet.prototype.has.call(v as WeakSet<object>, {})],
  ['date', v => Date.prototype.getTime.call(v)],
  ['regexp', v => assertType(getter(RegExp.prototype, 'global').call(v), 'boolean')],
  ['arraybuffer', v => getter(ArrayBuffer.prototype, 'byteLength').call(v)],
  ['dataview', v => getter(DataView.prototype, 'byteLength').call(v)],
]

function classify(v: unknown): { type: RemoteObject['type']; subtype?: Subtype } {
  const type = typeof v as RemoteObject['type']
  if (type !== 'object') return { type }
  if (v === null) return { type, subtype: 'null' }
  if (v instanceof InternalEntry) return { type, subtype: 'internal#entry' }
  if (Array.isArray(v)) return { type, subtype: 'array' }
  if (typeof Node !== 'undefined' && v instanceof Node) return { type, subtype: 'node' }
  for (const [subtype, check] of BRANDS) if (brand(v, check)) return { type, subtype }
  if (v instanceof Error || toTag(v) === 'Error') return { type, subtype: 'error' }
  // A promise's prototype is tagged "Promise"; Promise.prototype's own prototype is not.
  if (v instanceof Promise || toTag(Object.getPrototypeOf(v)) === 'Promise') return { type, subtype: 'promise' }
  return { type }
}

const MAX_PREVIEW_STRING = 100

/** Shortens long strings in previews by cutting out the middle, as V8 does. */
function abbreviate(s: string): string {
  if (s.length <= MAX_PREVIEW_STRING) return s
  const half = MAX_PREVIEW_STRING / 2
  return s.slice(0, half) + '…' + s.slice(s.length - half + 1)
}

const isNativeFunction = (fn: unknown) =>
  typeof fn === 'function' && /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn))

function className(v: any): string {
  try {
    const ctor = Object.getPrototypeOf(v)?.constructor
    return (typeof ctor === 'function' && ctor.name) || 'Object'
  } catch {
    return 'Object'
  }
}

function describeNode(node: Node): string {
  if (node instanceof Element) {
    let desc = node.tagName.toLowerCase()
    if (node.id) desc += '#' + node.id
    const cls = node.getAttribute('class')
    if (cls && cls.trim()) desc += '.' + cls.trim().split(/\s+/).join('.')
    return desc
  }
  return node.nodeName
}

function shortValue(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : describe(v, classify(v).subtype)
}

function describe(v: any, subtype: Subtype): string {
  try {
    switch (typeof v) {
      case 'string':
        return v
      case 'number':
      case 'boolean':
        return String(v)
      case 'bigint':
        return v + 'n'
      case 'symbol':
        return v.toString()
      case 'undefined':
        return 'undefined'
      case 'function':
        return Function.prototype.toString.call(v)
    }
    switch (subtype) {
      case 'null':
        return 'null'
      case 'array':
        return `Array(${v.length})`
      case 'typedarray':
        return `${className(v)}(${v.length})`
      case 'map':
      case 'set':
        return `${className(v)}(${v.size})`
      case 'arraybuffer':
      case 'dataview':
        return `${className(v)}(${v.byteLength})`
      case 'date':
        return Date.prototype.toString.call(v)
      case 'regexp':
        return RegExp.prototype.toString.call(v)
      case 'error':
        return typeof v.stack === 'string' && v.stack ? v.stack : `${v.name}: ${v.message}`
      case 'node':
        return describeNode(v)
      case 'internal#entry':
        return v.hasKey ? `{${shortValue(v.key)} => ${shortValue(v.value)}}` : shortValue(v.value)
    }
    return className(v)
  } catch {
    return className(v)
  }
}

export interface WrapOptions {
  generatePreview?: boolean
  returnByValue?: boolean
  group?: string
}

/** Turns page values into CDP RemoteObjects and keeps the objects alive by id. */
export class ObjectRegistry {
  private prefix = Math.floor(Math.random() * 1e9) + '.'
  private seq = 0
  private byId = new Map<string, unknown>()
  private ids = new Map<unknown, string>()
  private groups = new Map<string, Set<string>>()
  /** Arrays created for `[[Entries]]`; like Chrome, they have no visible prototype. */
  private entryLists = new WeakSet<object>()

  wrap(value: any, options: WrapOptions = {}): RemoteObject {
    const { type, subtype } = classify(value)
    switch (type) {
      case 'undefined':
        return { type }
      case 'string':
      case 'boolean':
        return { type, value }
      case 'number':
        if (Number.isNaN(value) || !Number.isFinite(value) || Object.is(value, -0)) {
          const s = Object.is(value, -0) ? '-0' : String(value)
          return { type, unserializableValue: s, description: s }
        }
        return { type, value, description: String(value) }
      case 'bigint':
        return { type, unserializableValue: value + 'n', description: value + 'n' }
    }
    if (subtype === 'null') return { type, subtype, value: null }
    if (options.returnByValue && type === 'object') return { type, value: cloneByValue(value) }

    const result: RemoteObject = { type, description: describe(value, subtype) }
    if (subtype) result.subtype = subtype as RemoteObject['subtype']
    if (type === 'function') result.className = 'Function'
    else if (type === 'object') result.className = subtype === 'error' ? value.name || className(value) : className(value)
    if (options.generatePreview && type === 'object') result.preview = this.preview(value, subtype)
    result.objectId = this.idOf(value, options.group)
    return result
  }

  get(objectId: string): any {
    if (!this.byId.has(objectId)) throw new CdpError('Could not find object with given id')
    return this.byId.get(objectId)
  }

  release(objectId: string) {
    this.ids.delete(this.byId.get(objectId))
    this.byId.delete(objectId)
  }

  releaseGroup(group: string) {
    this.groups.get(group)?.forEach(id => this.release(id))
    this.groups.delete(group)
  }

  getProperties(params: Protocol.Runtime.GetPropertiesRequest): Protocol.Runtime.GetPropertiesResponse {
    const obj = this.get(params.objectId)
    const opts: WrapOptions = { generatePreview: params.generatePreview }

    if (obj instanceof InternalEntry) {
      const result: PropertyDescriptor[] = []
      if (obj.hasKey) result.push(this.dataProperty('key', obj.key, opts))
      result.push(this.dataProperty('value', obj.value, opts))
      return { result }
    }

    if (params.accessorPropertiesOnly) {
      return { result: this.accessorProperties(obj) }
    }

    const result: PropertyDescriptor[] = []
    const seen = new Set<PropertyKey>()
    const isArrayLike = Array.isArray(obj) || obj instanceof TypedArray
    let target = obj
    let isOwn = true
    while (target !== null && target !== undefined) {
      for (const key of Reflect.ownKeys(target)) {
        if (seen.has(key)) continue
        if (params.nonIndexedPropertiesOnly && isArrayLike && typeof key === 'string' && /^\d+$/.test(key)) continue
        seen.add(key)
        const desc = Object.getOwnPropertyDescriptor(target, key)
        if (desc) result.push(this.describeProperty(key, desc, isOwn, opts))
      }
      if (params.ownProperties) break
      target = Object.getPrototypeOf(target)
      isOwn = false
    }

    const internalProperties: InternalPropertyDescriptor[] = []
    const proto = Object.getPrototypeOf(obj)
    if (proto !== null && typeof obj === 'object' && params.ownProperties && !this.entryLists.has(obj)) {
      internalProperties.push({ name: '[[Prototype]]', value: this.wrap(proto) })
    }
    const { subtype } = classify(obj)
    if (subtype === 'map' || subtype === 'set') {
      const entries: InternalEntry[] = []
      if (subtype === 'map') (obj as Map<unknown, unknown>).forEach((v, k) => entries.push(new InternalEntry(v, true, k)))
      else (obj as Set<unknown>).forEach(v => entries.push(new InternalEntry(v, false)))
      this.entryLists.add(entries)
      internalProperties.push({ name: '[[Entries]]', value: this.wrap(entries) })
    }
    if (obj instanceof Number || obj instanceof String || obj instanceof Boolean) {
      internalProperties.push({ name: '[[PrimitiveValue]]', value: this.wrap(obj.valueOf()) })
    }
    return internalProperties.length ? { result, internalProperties } : { result }
  }

  private idOf(value: unknown, group?: string): string {
    let id = this.ids.get(value)
    if (!id) {
      id = this.prefix + ++this.seq
      this.ids.set(value, id)
      this.byId.set(id, value)
    }
    if (group) {
      let ids = this.groups.get(group)
      if (!ids) this.groups.set(group, (ids = new Set()))
      ids.add(id)
    }
    return id
  }

  private dataProperty(name: string, value: unknown, opts: WrapOptions): PropertyDescriptor {
    return { name, value: this.wrap(value, opts), writable: false, configurable: false, enumerable: true, isOwn: true }
  }

  private describeProperty(key: PropertyKey, desc: globalThis.PropertyDescriptor, isOwn: boolean, opts: WrapOptions) {
    const prop: PropertyDescriptor = {
      name: String(key),
      configurable: !!desc.configurable,
      enumerable: !!desc.enumerable,
      isOwn,
    }
    if (typeof key === 'symbol') prop.symbol = this.wrap(key)
    if ('value' in desc) {
      prop.value = this.wrap(desc.value, opts)
      prop.writable = !!desc.writable
    } else {
      if (desc.get) prop.get = this.wrap(desc.get)
      if (desc.set) prop.set = this.wrap(desc.set)
    }
    return prop
  }

  /** Accessors along the prototype chain; the frontend invokes the getters on demand. */
  private accessorProperties(obj: any): PropertyDescriptor[] {
    const result: PropertyDescriptor[] = []
    const seen = new Set<PropertyKey>()
    let target = obj
    let isOwn = true
    while (target !== null && target !== undefined && target !== Object.prototype) {
      for (const key of Reflect.ownKeys(target)) {
        if (seen.has(key)) continue
        seen.add(key)
        const desc = Object.getOwnPropertyDescriptor(target, key)
        if (desc && (desc.get || desc.set)) result.push(this.describeProperty(key, desc, isOwn, {}))
      }
      target = Object.getPrototypeOf(target)
      isOwn = false
    }
    return result
  }

  private preview(obj: any, subtype: Subtype): ObjectPreview {
    const preview: ObjectPreview = {
      type: 'object',
      description: describe(obj, subtype),
      overflow: false,
      properties: [],
    }
    if (subtype) preview.subtype = subtype as ObjectPreview['subtype']
    if (subtype === 'internal#entry') return preview

    const isArrayLike = subtype === 'array' || subtype === 'typedarray'
    const limit = isArrayLike ? MAX_ARRAY_PREVIEW : MAX_OBJECT_PREVIEW
    const add = (property: PropertyPreview) => {
      if (preview.properties.length >= limit) {
        preview.overflow = true
        return false
      }
      preview.properties.push(property)
      return true
    }

    // Own properties (indexes only for arrays), then native getters along the prototype chain.
    const seen = new Set<PropertyKey>()
    let own: PropertyKey[]
    try {
      own = isArrayLike ? Array.from({ length: obj.length }, (_, i) => String(i)) : Reflect.ownKeys(obj)
    } catch {
      own = []
    }
    for (const key of own) {
      seen.add(key)
      const property = this.previewProperty(obj, obj, key)
      if (property && !add(property)) return this.withEntries(preview, obj, subtype)
    }

    for (let proto = Object.getPrototypeOf(obj); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Reflect.ownKeys(proto)) {
        if (seen.has(key)) continue
        seen.add(key)
        const desc = Object.getOwnPropertyDescriptor(proto, key)
        if (!desc?.get) continue
        const property = this.previewProperty(obj, proto, key)
        if (property && property.type !== 'accessor' && !add(property)) return this.withEntries(preview, obj, subtype)
      }
    }
    return this.withEntries(preview, obj, subtype)
  }

  /**
   * Previews `holder[key]` as read from `obj`. Like V8, native getters (e.g. Map#size,
   * Element#title, Error#stack) are invoked since they have no side effects; user-defined
   * getters are never invoked and show up as accessors.
   */
  private previewProperty(obj: any, holder: object, key: PropertyKey): PropertyPreview | null {
    if (key === '__proto__') return null
    const desc = Object.getOwnPropertyDescriptor(holder, key)
    if (!desc) return null
    const name = String(key)
    if ('value' in desc) return propertyPreview(name, desc.value)
    if (!desc.get || !isNativeFunction(desc.get)) return { name, type: 'accessor' }
    try {
      return propertyPreview(name, desc.get.call(obj))
    } catch {
      return null
    }
  }

  private withEntries(preview: ObjectPreview, obj: any, subtype: Subtype): ObjectPreview {
    if (subtype === 'map' || subtype === 'set') {
      preview.entries = []
      for (const [k, v] of subtype === 'map' ? (obj as Map<unknown, unknown>).entries() : (obj as Set<unknown>).entries()) {
        if (preview.entries.length >= MAX_ENTRY_PREVIEW) {
          preview.overflow = true
          break
        }
        preview.entries.push(subtype === 'map' ? { key: entryPreview(k), value: entryPreview(v) } : { value: entryPreview(v) })
      }
    }
    return preview
  }
}

function propertyPreview(name: string, value: unknown): PropertyPreview {
  const { type, subtype } = classify(value)
  const preview: PropertyPreview = { name, type, value: '' }
  if (subtype) preview.subtype = subtype as PropertyPreview['subtype']
  if (type === 'function') return preview
  if (type === 'object' && subtype === 'error') {
    const err = value as Error
    preview.value = `${err.name}: ${err.message}`
  } else {
    preview.value = abbreviate(describe(value, subtype))
  }
  return preview
}

function entryPreview(value: unknown): ObjectPreview {
  const { type, subtype } = classify(value)
  const preview: ObjectPreview = { type, description: describe(value, subtype), overflow: false, properties: [] }
  if (subtype) preview.subtype = subtype as ObjectPreview['subtype']
  return preview
}

function cloneByValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new CdpError("Object couldn't be returned by value")
  }
}
