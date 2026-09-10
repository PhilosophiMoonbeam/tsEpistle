export const MERMAID_MAX_TEXT_SIZE = 32_768
export const MERMAID_MAX_DIAGRAMS_PER_ROOT = 8
const MERMAID_MAX_EDGES = 500
const MERMAID_ERROR_CLASS = 'content-extension-diagram__error'
const MERMAID_ERROR_MESSAGE = 'Diagram could not be rendered locally. Its source remains available below.'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const MERMAID_ROOT_ID_PREFIX = 'content-extension-mermaid-root'
const FORBIDDEN_SVG_TAGS: Record<string, true> = {
  a: true,
  animate: true,
  animatemotion: true,
  animatetransform: true,
  audio: true,
  base: true,
  canvas: true,
  embed: true,
  foreignobject: true,
  form: true,
  iframe: true,
  image: true,
  input: true,
  link: true,
  mpath: true,
  object: true,
  script: true,
  select: true,
  set: true,
  switch: true,
  textarea: true,
  use: true,
  video: true
}

const SVG_CSS_PROPERTIES = new Set([
  'alignment-baseline',
  'baseline-shift',
  'clip',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'cursor',
  'dominant-baseline',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'glyph-orientation-horizontal',
  'glyph-orientation-vertical',
  'image-rendering',
  'kerning',
  'letter-spacing',
  'lighting-color',
  'line-height',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'opacity',
  'overflow',
  'paint-order',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-rendering',
  'text-align',
  'text-orientation',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'white-space',
  'word-spacing',
  'writing-mode',
  'transform'
])

// Mermaid emits ordinary CSS properties for HTML-label and tooltip paths. They are
// intentionally parsed and then discarded: none is needed to render the static SVG
// shape/text contract, and discarded declarations never reach the browser.
const MERMAID_DISCARDED_CSS_PROPERTIES = new Set([
  'animation',
  'animation-delay',
  'animation-direction',
  'animation-duration',
  'animation-fill-mode',
  'animation-iteration-count',
  'animation-name',
  'animation-play-state',
  'animation-timing-function',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-radius',
  'box-shadow',
  'content',
  'cursor',
  'display',
  'height',
  'margin',
  'max-width',
  'min-height',
  'outline',
  'overflow',
  'padding',
  'pointer-events',
  'position',
  'transition',
  'transition-delay',
  'transition-duration',
  'transition-property',
  'transition-timing-function',
  'vertical-align',
  'width',
  'z-index'
])

const URL_CSS_PROPERTIES = new Set(['clip-path', 'fill', 'filter', 'marker-end', 'marker-mid', 'marker-start', 'mask', 'stroke'])

const SAFE_CSS_FUNCTIONS = new Set(
  [
    'calc',
    'clamp',
    'color',
    'color-mix',
    'drop-shadow',
    'hsl',
    'hsla',
    'hwb',
    'lab',
    'lch',
    'light-dark',
    'max',
    'min',
    'matrix',
    'matrix3d',
    'oklab',
    'oklch',
    'rotate',
    'scale',
    'scaleX',
    'scaleY',
    'skew',
    'skewX',
    'skewY',
    'translate',
    'translateX',
    'translateY',
    'rgb',
    'rgba',
    'circle',
    'ellipse',
    'inset',
    'polygon'
  ].map(value => value.toLowerCase())
)

const SAFE_SELECTOR_PSEUDO_CLASSES = new Set([
  'active',
  'checked',
  'disabled',
  'empty',
  'enabled',
  'first-child',
  'first-of-type',
  'focus',
  'focus-visible',
  'focus-within',
  'hover',
  'indeterminate',
  'is',
  'last-child',
  'last-of-type',
  'link',
  'not',
  'nth-child',
  'nth-last-child',
  'nth-last-of-type',
  'nth-of-type',
  'only-child',
  'only-of-type',
  'optional',
  'read-only',
  'read-write',
  'required',
  'visited',
  'where'
])

const SAFE_SELECTOR_COMBINATORS = new Set([' ', '>', '+', '~'])
const SAFE_ATTRIBUTE_MATCHERS = new Set(['=', '~=', '|=', '^=', '$=', '*='])

const FALLBACK_IDENTIFIERS: Record<string, ReadonlySet<string>> = {
  'color-interpolation': new Set(['auto', 'inherit', 'initial', 'linear-rgb', 'revert', 'revert-layer', 'srgb', 'unset']),
  'color-interpolation-filters': new Set(['auto', 'inherit', 'initial', 'linear-rgb', 'revert', 'revert-layer', 'srgb', 'unset']),
  'color-rendering': new Set(['auto', 'geometricprecision', 'inherit', 'initial', 'optimizequality', 'optimizespeed', 'revert', 'revert-layer', 'unset']),
  'image-rendering': new Set(['auto', 'crisp-edges', 'inherit', 'initial', 'pixelated', 'revert', 'revert-layer', 'unset']),
  'shape-rendering': new Set(['auto', 'crispedges', 'geometricprecision', 'inherit', 'initial', 'optimizespeed', 'revert', 'revert-layer', 'unset']),
  'stroke-alignment': new Set(['center', 'inherit', 'initial', 'inner', 'outer', 'revert', 'revert-layer', 'unset']),
  'text-rendering': new Set(['auto', 'geometricprecision', 'inherit', 'initial', 'optimizelegibility', 'optimizespeed', 'revert', 'revert-layer', 'unset']),
  'vector-effect': new Set([
    'default',
    'fixed-position',
    'inherit',
    'initial',
    'non-scaling-size',
    'non-scaling-stroke',
    'non-scaling-text',
    'revert',
    'revert-layer',
    'unset'
  ])
}

const CSS_DIMENSION_UNITS = new Set([
  'cap',
  'ch',
  'cm',
  'cqh',
  'cqw',
  'deg',
  'dpcm',
  'dpi',
  'dppx',
  'dvh',
  'dvw',
  'em',
  'ex',
  'fr',
  'grad',
  'hz',
  'ic',
  'in',
  'khz',
  'lh',
  'mm',
  'pc',
  'pt',
  'px',
  'q',
  'rad',
  'rcap',
  'rch',
  'rem',
  'rex',
  'ric',
  'rlh',
  'svh',
  'svw',
  'turn',
  'vh',
  'vmax',
  'vmin',
  'vw'
])

const SAFE_NUMERIC_OPERATORS = new Set([',', '+', '-', '*', '/'])

type MermaidTheme = 'default' | 'dark' | 'neutral' | 'forest'

type MermaidRenderResult = {
  svg?: unknown
}

type MermaidRuntime = {
  initialize: (config: {
    startOnLoad: false
    securityLevel: 'strict'
    htmlLabels: false
    maxTextSize: number
    maxEdges: number
    suppressErrorRendering: true
    theme: MermaidTheme
    secure: string[]
  }) => void
  render: (id: string, source: string) => Promise<MermaidRenderResult>
}

export interface RenderMermaidSvgOptions {
  ownerDocument: Document
  theme: MermaidTheme
  signal?: AbortSignal
  isCurrent: () => boolean
}

type CssTreeNode = {
  type: string
  [key: string]: unknown
}

type CssTreeList = Iterable<CssTreeNode> & {
  appendData: (node: CssTreeNode) => unknown
  clear: () => void
}

type CssTreeRuntime = {
  generate: (node: CssTreeNode) => string
  ident: {
    decode: (value: string) => string
  }
  lexer: {
    matchProperty: (property: string, value: CssTreeNode) => { error?: unknown }
  }
  parse: (source: string, options?: { context?: string; positions?: boolean }) => CssTreeNode
}

let diagramInstance = 0
let mermaidQueue: Promise<void> = Promise.resolve()
let mermaidModulePromise: Promise<MermaidRuntime> | null = null
let cssTreeModulePromise: Promise<CssTreeRuntime> | null = null

const isCurrentRender = (options: RenderMermaidSvgOptions): boolean => !options.signal?.aborted && options.isCurrent()

const loadMermaid = (): Promise<MermaidRuntime> => {
  if (mermaidModulePromise) return mermaidModulePromise

  const loading = import('mermaid').then(module => {
    const runtime = module.default as Partial<MermaidRuntime> | undefined
    if (!runtime || typeof runtime.initialize !== 'function' || typeof runtime.render !== 'function') {
      throw new TypeError('Mermaid runtime is unavailable.')
    }
    return runtime as MermaidRuntime
  })
  mermaidModulePromise = loading.catch(error => {
    mermaidModulePromise = null
    throw error
  })
  return mermaidModulePromise
}

const loadCssTree = (): Promise<CssTreeRuntime> => {
  if (cssTreeModulePromise) return cssTreeModulePromise

  // css-tree 3.2.1 is intentionally untyped; keep its full parser behind the render boundary.
  // @ts-expect-error css-tree does not publish TypeScript declarations.
  const loading = import('css-tree').then(module => module as unknown as CssTreeRuntime)
  cssTreeModulePromise = loading.catch(error => {
    cssTreeModulePromise = null
    throw error
  })
  return cssTreeModulePromise
}

const listChildren = (node: CssTreeNode, field = 'children'): CssTreeNode[] => {
  const value = node[field]
  if (!value || typeof value !== 'object' || !(Symbol.iterator in value)) throw new Error('Mermaid returned invalid CSS.')
  return [...(value as CssTreeList)]
}

const replaceList = (node: CssTreeNode, children: CssTreeNode[], field = 'children'): void => {
  const value = node[field]
  if (!value || typeof value !== 'object' || typeof (value as CssTreeList).clear !== 'function' || typeof (value as CssTreeList).appendData !== 'function') {
    throw new Error('Mermaid returned invalid CSS.')
  }
  const list = value as CssTreeList
  list.clear()
  for (const child of children) list.appendData(child)
}

const cssName = (tree: CssTreeRuntime, value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Mermaid returned invalid CSS.')
  const decoded = tree.ident.decode(value)
  if (!decoded || decoded.includes('\u0000') || decoded.includes('\\')) throw new Error('Mermaid returned invalid CSS.')
  return decoded.toLowerCase()
}

const safeNumber = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && Number.isFinite(Number(value))

const safeIdentifier = (tree: CssTreeRuntime, node: CssTreeNode): string => {
  if (typeof node.name !== 'string') throw new Error('Mermaid returned invalid CSS.')
  const decoded = tree.ident.decode(node.name)
  if (!decoded || decoded.includes('\u0000') || decoded.includes('\\')) throw new Error('Mermaid returned invalid CSS.')
  node.name = decoded
  return decoded.toLowerCase()
}

const hasUnsafeUrlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || character === '"' || character === "'" || character === '<' || character === '>') return true
  }
  return false
}

const cssUrlFragment = (value: string): string => {
  const fragment = value.trim()
  if (!fragment.startsWith('#') || fragment.length < 2 || hasUnsafeUrlCharacter(fragment)) throw new Error('Mermaid returned an external reference.')
  return fragment
}

const localUrlFromFunction = (tree: CssTreeRuntime, node: CssTreeNode): string => {
  const children = listChildren(node)
  if (children.length !== 1) throw new Error('Mermaid returned an external reference.')
  const child = children[0]
  if (!child) throw new Error('Mermaid returned an external reference.')
  if (child.type === 'Hash' && typeof child.value === 'string') return cssUrlFragment(`#${tree.ident.decode(child.value)}`)
  if (child.type === 'String' && typeof child.value === 'string') return cssUrlFragment(child.value)
  if (child.type === 'Identifier') return cssUrlFragment(safeIdentifier(tree, child))
  throw new Error('Mermaid returned an external reference.')
}

const normalizeUrlFunction = (tree: CssTreeRuntime, node: CssTreeNode, property: string, localIds: ReadonlySet<string>): void => {
  if (!URL_CSS_PROPERTIES.has(property)) throw new Error('Mermaid returned an external reference.')
  const fragment = localUrlFromFunction(tree, node)
  if (!localIds.has(fragment.slice(1))) throw new Error('Mermaid returned an unresolved local reference.')
  node.type = 'Url'
  node.value = fragment
  delete node.name
  delete node.children
}

const validateCssValue = (tree: CssTreeRuntime, node: CssTreeNode, property: string, localIds: ReadonlySet<string>): void => {
  if (!node || typeof node.type !== 'string') throw new Error('Mermaid returned invalid CSS.')

  switch (node.type) {
    case 'Value':
    case 'Parentheses':
    case 'Brackets':
      for (const child of listChildren(node)) validateCssValue(tree, child, property, localIds)
      return
    case 'Raw':
      throw new Error('Mermaid returned invalid CSS.')
    case 'Url': {
      if (!URL_CSS_PROPERTIES.has(property) || typeof node.value !== 'string') throw new Error('Mermaid returned an external reference.')
      const fragment = cssUrlFragment(node.value)
      if (!localIds.has(fragment.slice(1))) throw new Error('Mermaid returned an unresolved local reference.')
      node.value = fragment
      return
    }
    case 'Function': {
      const functionName = cssName(tree, node.name)
      if (functionName === 'url') {
        normalizeUrlFunction(tree, node, property, localIds)
        return
      }
      if (!SAFE_CSS_FUNCTIONS.has(functionName)) throw new Error('Mermaid returned an unsupported CSS function.')
      for (const child of listChildren(node)) validateCssValue(tree, child, property, localIds)
      node.name = functionName
      return
    }
    case 'Identifier':
      safeIdentifier(tree, node)
      return
    case 'Hash':
      if (typeof node.value !== 'string' || !/^[0-9a-f]{3,8}$/i.test(node.value)) throw new Error('Mermaid returned an invalid color.')
      node.value = node.value.toLowerCase()
      return
    case 'String':
      if (property !== 'font-family') throw new Error('Mermaid returned an unsupported CSS string.')
      if (typeof node.value !== 'string' || node.value.includes('\u0000')) throw new Error('Mermaid returned invalid CSS.')
      return
    case 'Number':
    case 'Percentage':
      if (!safeNumber(node.value)) throw new Error('Mermaid returned an invalid CSS number.')
      return
    case 'Dimension': {
      if (!safeNumber(node.value) || typeof node.unit !== 'string') throw new Error('Mermaid returned an invalid CSS dimension.')
      const unit = tree.ident.decode(node.unit).toLowerCase()
      if (!CSS_DIMENSION_UNITS.has(unit)) throw new Error('Mermaid returned an invalid CSS dimension.')
      node.unit = unit
      return
    }
    case 'Operator':
      if (typeof node.value !== 'string' || !SAFE_NUMERIC_OPERATORS.has(node.value)) throw new Error('Mermaid returned an unsupported CSS operator.')
      return
    default:
      throw new Error('Mermaid returned unsupported CSS syntax.')
  }
}
const SVG_TRANSFORM_FUNCTIONS: Record<string, { arity: readonly [number, number]; canonical: string }> = {
  matrix: { arity: [6, 6], canonical: 'matrix' },
  rotate: { arity: [1, 3], canonical: 'rotate' },
  scale: { arity: [1, 2], canonical: 'scale' },
  skewx: { arity: [1, 1], canonical: 'skewX' },
  skewy: { arity: [1, 1], canonical: 'skewY' },
  translate: { arity: [1, 2], canonical: 'translate' }
}

type CssTreeLocation = {
  start?: { offset?: number }
  end?: { offset?: number }
}

const transformOffset = (node: CssTreeNode, side: 'start' | 'end'): number | null => {
  const location = node.loc
  if (!location || typeof location !== 'object') return null
  const offset = (location as CssTreeLocation)[side]?.offset
  return typeof offset === 'number' && Number.isInteger(offset) ? offset : null
}

const validateSvgTransformValue = (tree: CssTreeRuntime, value: CssTreeNode, source: string): void => {
  if (value.type !== 'Value') throw new Error('Mermaid returned invalid SVG transform.')
  const transforms = listChildren(value)
  if (transforms.length === 0) throw new Error('Mermaid returned invalid SVG transform.')

  for (const transform of transforms) {
    if (transform.type !== 'Function' || typeof transform.name !== 'string') throw new Error('Mermaid returned invalid SVG transform.')
    const name = cssName(tree, transform.name)
    const definition = SVG_TRANSFORM_FUNCTIONS[name]
    if (!definition) throw new Error('Mermaid returned unsupported SVG transform.')
    transform.name = definition.canonical

    const args = listChildren(transform)
    const numbers: CssTreeNode[] = []
    let expectNumber = true
    let previousNumber: CssTreeNode | null = null
    for (const arg of args) {
      if (arg.type === 'Operator') {
        if (arg.value !== ',' || expectNumber) throw new Error('Mermaid returned invalid SVG transform.')
        expectNumber = true
        previousNumber = null
        continue
      }
      if (arg.type !== 'Number' || !safeNumber(arg.value)) {
        throw new Error('Mermaid returned invalid SVG transform.')
      }
      if (!expectNumber) {
        if (!previousNumber) throw new Error('Mermaid returned invalid SVG transform.')
        const previousEnd = transformOffset(previousNumber, 'end')
        const currentStart = transformOffset(arg, 'start')
        if (previousEnd === null || currentStart === null || currentStart <= previousEnd || !/^\s+$/.test(source.slice(previousEnd, currentStart))) {
          throw new Error('Mermaid returned invalid SVG transform.')
        }
      }
      expectNumber = false
      previousNumber = arg
      numbers.push(arg)
    }
    if (args.length === 0 || expectNumber) throw new Error('Mermaid returned invalid SVG transform.')
    if (numbers.length < definition.arity[0] || numbers.length > definition.arity[1]) throw new Error('Mermaid returned invalid SVG transform.')
  }
}

const validateFallbackProperty = (tree: CssTreeRuntime, property: string, value: CssTreeNode): boolean => {
  const allowed = FALLBACK_IDENTIFIERS[property]
  if (!allowed) return false
  const nodes = value.type === 'Value' ? listChildren(value) : []
  if (nodes.length === 0) return false
  return nodes.every(node => {
    if (node.type !== 'Identifier') return false
    return allowed.has(safeIdentifier(tree, node))
  })
}

const validatePropertySyntax = (tree: CssTreeRuntime, property: string, value: CssTreeNode): void => {
  try {
    const result = tree.lexer.matchProperty(property, value)
    if (!result || result.error) throw new Error('Mermaid returned an invalid CSS value.')
  } catch (error) {
    if (!validateFallbackProperty(tree, property, value)) throw error
  }
}

const isDiscardedProperty = (property: string): boolean => property.startsWith('--') || MERMAID_DISCARDED_CSS_PROPERTIES.has(property)

const sanitizeDeclaration = (tree: CssTreeRuntime, declaration: CssTreeNode, localIds: ReadonlySet<string>): CssTreeNode | null => {
  if (declaration.type !== 'Declaration' || typeof declaration.property !== 'string') {
    throw new Error('Mermaid returned invalid CSS.')
  }
  const property = cssName(tree, declaration.property)
  if (!SVG_CSS_PROPERTIES.has(property) && !isDiscardedProperty(property)) throw new Error('Mermaid returned an unsupported CSS property.')
  declaration.property = property
  // Animation, layout, custom-property, and other discarded declarations never reach
  // the browser. Drop them before walking values so their intentionally unsupported
  // syntax cannot widen the retained static SVG grammar.
  if (isDiscardedProperty(property)) return null
  if (!declaration.value || typeof declaration.value !== 'object') throw new Error('Mermaid returned invalid CSS.')

  const value = declaration.value as CssTreeNode
  validateCssValue(tree, value, property, localIds)
  validatePropertySyntax(tree, property, value)
  return declaration
}

const selectorName = (tree: CssTreeRuntime, node: CssTreeNode): string => {
  if (typeof node.name !== 'string') throw new Error('Mermaid returned invalid CSS selector.')
  const generated = tree.generate(node)
  if (generated.includes('\\')) throw new Error('Mermaid returned an escaped CSS selector.')
  const decoded = tree.ident.decode(node.name)
  if (!decoded || decoded.includes('\u0000') || decoded.includes('\\')) throw new Error('Mermaid returned an invalid CSS selector.')
  node.name = decoded
  return decoded.toLowerCase()
}

const validateSelectorNode = (tree: CssTreeRuntime, node: CssTreeNode): void => {
  switch (node.type) {
    case 'Selector':
    case 'SelectorList':
      for (const child of listChildren(node)) validateSelectorNode(tree, child)
      return
    case 'IdSelector':
    case 'ClassSelector':
      selectorName(tree, node)
      return
    case 'Combinator':
      if (!SAFE_SELECTOR_COMBINATORS.has(String(node.name ?? ''))) throw new Error('Mermaid returned an unsupported CSS combinator.')
      return
    case 'TypeSelector': {
      const name = selectorName(tree, node)
      if (!/^[a-z_][a-z0-9_-]*$/i.test(name) && name !== '*') throw new Error('Mermaid returned an invalid CSS selector.')
      return
    }
    case 'AttributeSelector': {
      const matcher = node.matcher
      if (matcher !== null && (typeof matcher !== 'string' || !SAFE_ATTRIBUTE_MATCHERS.has(matcher)))
        throw new Error('Mermaid returned an unsupported CSS attribute selector.')
      if (!node.name || typeof node.name !== 'object') throw new Error('Mermaid returned an invalid CSS selector.')
      const attributeName = node.name as CssTreeNode
      if (attributeName.type !== 'Identifier') throw new Error('Mermaid returned an invalid CSS selector.')
      selectorName(tree, attributeName)
      if (node.value && typeof node.value === 'object') {
        const value = node.value as CssTreeNode
        if (value.type === 'String') {
          if (typeof value.value !== 'string' || value.value.includes('\\')) throw new Error('Mermaid returned an escaped CSS selector.')
        } else if (value.type === 'Identifier') {
          selectorName(tree, value)
        } else {
          throw new Error('Mermaid returned an invalid CSS selector.')
        }
      }
      if (node.flags !== null && node.flags !== undefined && typeof node.flags !== 'string') throw new Error('Mermaid returned an invalid CSS selector.')
      return
    }
    case 'Identifier':
      selectorName(tree, node)
      return
    case 'PseudoClassSelector': {
      const name = selectorName(tree, node)
      if (name === 'root' || !SAFE_SELECTOR_PSEUDO_CLASSES.has(name)) throw new Error('Mermaid returned an unsupported CSS pseudo-class.')
      if (node.children && typeof node.children === 'object') {
        for (const child of listChildren(node)) validateSelectorNode(tree, child)
      }
      return
    }
    default:
      throw new Error('Mermaid returned unsupported CSS selector syntax.')
  }
}

const selectorStartsAtRoot = (tree: CssTreeRuntime, selector: CssTreeNode, sourceRootId: string): boolean => {
  const children = listChildren(selector)
  const first = children[0]
  return Boolean(first?.type === 'IdSelector' && typeof first.name === 'string' && tree.ident.decode(first.name) === sourceRootId)
}

const rewriteRootId = (tree: CssTreeRuntime, selector: CssTreeNode, sourceRootId: string, rootId: string): void => {
  const visit = (node: CssTreeNode): void => {
    if (node.type === 'IdSelector' && typeof node.name === 'string' && tree.ident.decode(node.name) === sourceRootId) node.name = rootId
    const children = node.children
    if (!children || typeof children !== 'object' || !(Symbol.iterator in children)) return
    for (const child of children as CssTreeList) visit(child)
  }
  visit(selector)
}

const scopeSelector = (tree: CssTreeRuntime, selector: CssTreeNode, sourceRootId: string, rootId: string): void => {
  validateSelectorNode(tree, selector)
  if (tree.generate(selector).includes('\\')) throw new Error('Mermaid returned an escaped CSS selector.')
  const rooted = selectorStartsAtRoot(tree, selector, sourceRootId)
  if (rooted) {
    if (sourceRootId !== rootId) rewriteRootId(tree, selector, sourceRootId, rootId)
    return
  }
  const children = listChildren(selector)
  children.unshift({ type: 'IdSelector', name: rootId }, { type: 'Combinator', name: ' ' })
  replaceList(selector, children)
}

const sanitizeStyleSheet = (tree: CssTreeRuntime, styleElement: Element, localIds: ReadonlySet<string>, sourceRootId: string, rootId: string): void => {
  const source = styleElement.textContent ?? ''
  let sheet: CssTreeNode
  try {
    sheet = tree.parse(source, { context: 'stylesheet', positions: true })
  } catch {
    throw new Error('Mermaid returned invalid CSS.')
  }
  if (sheet.type !== 'StyleSheet') throw new Error('Mermaid returned invalid CSS.')

  const rules: CssTreeNode[] = []
  for (const child of listChildren(sheet)) {
    // Stylesheet at-rules (including escaped @import/font-face/keyframes forms)
    // are never needed by the static SVG contract and are dropped as subtrees.
    if (child.type === 'Atrule') continue
    if (child.type !== 'Rule' || !child.prelude || typeof child.prelude !== 'object' || !child.block || typeof child.block !== 'object') {
      throw new Error('Mermaid returned invalid CSS.')
    }

    const declarations: CssTreeNode[] = []
    const block = child.block as CssTreeNode
    for (const declaration of listChildren(block)) {
      const sanitized = sanitizeDeclaration(tree, declaration, localIds)
      if (sanitized) declarations.push(sanitized)
    }
    replaceList(block, declarations)
    if (declarations.length === 0) continue

    const prelude = child.prelude as CssTreeNode
    if (prelude.type !== 'SelectorList') throw new Error('Mermaid returned invalid CSS selector.')
    const selectorStart = transformOffset(prelude, 'start')
    const selectorEnd = transformOffset(prelude, 'end')
    if (selectorStart === null || selectorEnd === null || selectorEnd < selectorStart || source.slice(selectorStart, selectorEnd).includes('\\')) {
      throw new Error('Mermaid returned an escaped CSS selector.')
    }
    const selectors = listChildren(prelude)
    if (selectors.length === 0) throw new Error('Mermaid returned invalid CSS selector.')
    for (const selector of selectors) {
      if (selector.type !== 'Selector') throw new Error('Mermaid returned invalid CSS selector.')
      scopeSelector(tree, selector, sourceRootId, rootId)
    }
    rules.push(child)
  }
  replaceList(sheet, rules)
  styleElement.textContent = tree.generate(sheet)
}

const sanitizeStyleAttribute = (tree: CssTreeRuntime, element: Element, attribute: Attr, localIds: ReadonlySet<string>): void => {
  let declarations: CssTreeNode
  try {
    declarations = tree.parse(attribute.value, { context: 'declarationList' })
  } catch {
    throw new Error('Mermaid returned invalid CSS.')
  }
  if (declarations.type !== 'DeclarationList') throw new Error('Mermaid returned invalid CSS.')
  const sanitized: CssTreeNode[] = []
  for (const declaration of listChildren(declarations)) {
    const safeDeclaration = sanitizeDeclaration(tree, declaration, localIds)
    if (safeDeclaration) sanitized.push(safeDeclaration)
  }
  replaceList(declarations, sanitized)
  if (sanitized.length === 0) element.removeAttribute(attribute.name)
  else element.setAttribute(attribute.name, tree.generate(declarations))
}

const hasDuplicateRootId = (ownerDocument: Document, svg: SVGElement, id: string): boolean => {
  if (ownerDocument.getElementById(id)) return true
  return [...svg.querySelectorAll('[id]')].some(element => element !== svg && element.getAttribute('id') === id)
}

const ensureUniqueRootId = (ownerDocument: Document, svg: SVGElement): { sourceRootId: string; rootId: string } => {
  const sourceRootId = svg.getAttribute('id') ?? ''
  const safeSourceRootId = /^[a-z_][a-z0-9_-]*$/i.test(sourceRootId) ? sourceRootId : ''
  if (safeSourceRootId && !hasDuplicateRootId(ownerDocument, svg, safeSourceRootId)) return { sourceRootId: safeSourceRootId, rootId: safeSourceRootId }

  let suffix = ++diagramInstance
  let rootId = `${MERMAID_ROOT_ID_PREFIX}-${suffix}`
  while (hasDuplicateRootId(ownerDocument, svg, rootId)) rootId = `${MERMAID_ROOT_ID_PREFIX}-${++suffix}`
  svg.setAttribute('id', rootId)
  return { sourceRootId, rootId }
}

export const parseSafeMermaidSvg = async (ownerDocument: Document, source: string): Promise<SVGElement> => {
  const Parser = ownerDocument.defaultView?.DOMParser ?? (typeof DOMParser === 'undefined' ? null : DOMParser)
  if (!Parser) throw new Error('Mermaid returned invalid SVG.')
  const parsed = new Parser().parseFromString(source, 'image/svg+xml')
  const svg = parsed.documentElement
  const rootName = (svg.localName || svg.tagName || '').toLowerCase()
  if (rootName !== 'svg' || parsed.querySelector('parsererror') || (svg.namespaceURI && svg.namespaceURI !== SVG_NAMESPACE)) {
    throw new Error('Mermaid returned invalid SVG.')
  }

  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    const tagName = (element.localName || element.tagName || '').toLowerCase()
    if (FORBIDDEN_SVG_TAGS[tagName]) throw new Error('Mermaid returned active SVG content.')
    if (element.namespaceURI && element.namespaceURI !== SVG_NAMESPACE) {
      throw new Error('Mermaid returned invalid SVG.')
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on')) throw new Error('Mermaid returned an event handler.')
      if (name === 'href' || name === 'xlink:href') {
        if (!value.startsWith('#') || value.length < 2) throw new Error('Mermaid returned an external reference.')
      }
      if (name === 'src' || name === 'srcset' || name === 'action' || name === 'formaction') {
        throw new Error('Mermaid returned an external reference.')
      }
    }
  }

  const tree = await loadCssTree()
  const { sourceRootId, rootId } = ensureUniqueRootId(ownerDocument, svg as unknown as SVGElement)
  const localIds = new Set<string>()
  for (const element of [svg, ...svg.querySelectorAll('[id]')]) {
    const id = element.getAttribute('id')
    if (id) localIds.add(id)
  }
  localIds.add(rootId)

  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name === 'style') {
        sanitizeStyleAttribute(tree, element, attribute, localIds)
      } else if (SVG_CSS_PROPERTIES.has(name) || MERMAID_DISCARDED_CSS_PROPERTIES.has(name)) {
        const value = tree.parse(attribute.value, { context: 'value', positions: name === 'transform' })
        if (name === 'transform') {
          validateSvgTransformValue(tree, value, attribute.value)
          attribute.value = tree.generate(value)
        } else {
          validateCssValue(tree, value, name, localIds)
          if (SVG_CSS_PROPERTIES.has(name) && !isDiscardedProperty(name)) {
            validatePropertySyntax(tree, name, value)
            attribute.value = tree.generate(value)
          } else {
            element.removeAttribute(attribute.name)
          }
        }
      }
    }
    if (tagNameIsStyle(element)) sanitizeStyleSheet(tree, element, localIds, sourceRootId, rootId)
  }

  return ownerDocument.importNode(svg, true) as unknown as SVGElement
}

const tagNameIsStyle = (element: Element): boolean => (element.localName || element.tagName || '').toLowerCase() === 'style'

export const selectMermaidRenderHosts = (hosts: Iterable<HTMLElement>): ReadonlySet<HTMLElement> => {
  const selected = new Set<HTMLElement>()
  for (const host of hosts) {
    if (selected.has(host)) continue
    selected.add(host)
    if (selected.size >= MERMAID_MAX_DIAGRAMS_PER_ROOT) break
  }
  return selected
}

export const renderMermaidSvg = async (source: string, options: RenderMermaidSvgOptions): Promise<SVGElement | null> => {
  if (!isCurrentRender(options)) return null

  const drawing = mermaidQueue.then(async () => {
    if (!isCurrentRender(options)) return null
    if (source.length > MERMAID_MAX_TEXT_SIZE) {
      throw new Error('Mermaid source exceeds the maximum supported size.')
    }
    const mermaid = await loadMermaid()
    if (!isCurrentRender(options)) return null
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      maxTextSize: MERMAID_MAX_TEXT_SIZE,
      maxEdges: MERMAID_MAX_EDGES,
      suppressErrorRendering: true,
      theme: options.theme,
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'htmlLabels',
        'theme',
        'themeCSS',
        'themeVariables',
        'fontFamily',
        'altFontFamily'
      ]
    })
    if (!isCurrentRender(options)) return null
    const id = `content-extension-diagram-${++diagramInstance}`
    const result = await mermaid.render(id, source)
    if (!isCurrentRender(options)) return null
    if (typeof result?.svg !== 'string') throw new Error('Mermaid returned invalid SVG.')
    const svg = await parseSafeMermaidSvg(options.ownerDocument, result.svg)
    if (!isCurrentRender(options)) return null
    return svg
  })
  mermaidQueue = drawing.then(
    () => {},
    () => {}
  )

  try {
    return await drawing
  } catch (error) {
    if (!isCurrentRender(options)) return null
    throw error
  }
}

export const hydrateMermaid = async (figure: HTMLElement, signal: AbortSignal): Promise<void> => {
  const output = figure.querySelector<HTMLElement>('.content-extension-diagram__output')
  const sourceElement = output?.querySelector<HTMLElement>('.content-extension-diagram__source code')
  if (!output || !sourceElement) return
  const source = sourceElement.textContent ?? ''
  const requestedTheme = figure.dataset.diagramTheme ?? 'auto'
  const theme = requestedTheme === 'auto' ? (figure.closest('.v-theme--dark') ? 'dark' : 'default') : (requestedTheme as MermaidTheme)
  const isRenderCurrent = (): boolean =>
    figure.isConnected && output.isConnected && figure.contains(output) && sourceElement.isConnected && output.contains(sourceElement)
  const isHostCurrent = (): boolean => !signal.aborted && figure.isConnected && output.isConnected && figure.contains(output)
  output.setAttribute('aria-busy', 'true')
  try {
    const safeSvg = await renderMermaidSvg(source, {
      ownerDocument: figure.ownerDocument,
      theme,
      signal,
      isCurrent: isRenderCurrent
    })
    if (!safeSvg || !isRenderCurrent()) return
    safeSvg.setAttribute('role', 'img')
    safeSvg.setAttribute('aria-label', figure.querySelector('figcaption')?.textContent?.trim() || 'Mermaid diagram')
    output.replaceChildren(safeSvg)
  } catch {
    if (!isHostCurrent()) return
    if (!output.querySelector(`.${MERMAID_ERROR_CLASS}`)) {
      const status = figure.ownerDocument.createElement('p')
      status.className = MERMAID_ERROR_CLASS
      status.setAttribute('role', 'alert')
      status.textContent = MERMAID_ERROR_MESSAGE
      output.prepend(status)
    }
  } finally {
    if (isHostCurrent()) output.setAttribute('aria-busy', 'false')
  }
}
