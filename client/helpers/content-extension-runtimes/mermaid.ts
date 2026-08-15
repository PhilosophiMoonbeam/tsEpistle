let diagramInstance = 0
let mermaidQueue = Promise.resolve()

const parseSafeMermaidSvg = (document: Document, source: string): SVGElement => {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const svg = parsed.documentElement
  if (svg.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) throw new Error('Mermaid returned invalid SVG.')
  if (svg.querySelector('a, foreignObject, iframe, image, script, use')) throw new Error('Mermaid returned active SVG content.')
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) throw new Error('Mermaid returned an event handler.')
      if ((name === 'href' || name === 'xlink:href') && !attribute.value.startsWith('#')) {
        throw new Error('Mermaid returned an external reference.')
      }
      if (name === 'style' && (/@import/i.test(attribute.value) || /url\((?!["']?#)/i.test(attribute.value))) {
        throw new Error('Mermaid returned an external style reference.')
      }
    }
    if (element.tagName.toLowerCase() === 'style' && (/@import/i.test(element.textContent ?? '') || /url\((?!["']?#)/i.test(element.textContent ?? ''))) {
      throw new Error('Mermaid returned an external stylesheet reference.')
    }
  }
  return document.importNode(svg, true) as unknown as SVGElement
}

export const hydrateMermaid = async (figure: HTMLElement, signal: AbortSignal): Promise<void> => {
  const output = figure.querySelector<HTMLElement>('.content-extension-diagram__output')
  const sourceElement = output?.querySelector<HTMLElement>('.content-extension-diagram__source code')
  if (!output || !sourceElement) return
  const source = sourceElement.textContent ?? ''
  const requestedTheme = figure.dataset.diagramTheme ?? 'auto'
  const theme = requestedTheme === 'auto' ? (figure.closest('.theme--dark') ? 'dark' : 'default') : requestedTheme
  const id = `content-extension-diagram-${++diagramInstance}`
  const drawing = mermaidQueue.then(async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: theme as 'default' })
    return await mermaid.render(id, source)
  })
  mermaidQueue = drawing.then(() => {}, () => {})
  try {
    const { svg } = await drawing
    if (signal.aborted) return
    const safeSvg = parseSafeMermaidSvg(figure.ownerDocument, svg)
    safeSvg.setAttribute('role', 'img')
    safeSvg.setAttribute('aria-label', figure.querySelector('figcaption')?.textContent?.trim() || 'Mermaid diagram')
    output.replaceChildren(safeSvg)
  } catch {
    if (signal.aborted) return
    const status = figure.ownerDocument.createElement('p')
    status.className = 'content-extension-diagram__error'
    status.setAttribute('role', 'alert')
    status.textContent = 'Diagram could not be rendered locally. Its source remains available below.'
    output.prepend(status)
  }
}
