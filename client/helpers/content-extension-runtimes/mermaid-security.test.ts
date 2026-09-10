import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { MERMAID_MAX_DIAGRAMS_PER_ROOT, parseSafeMermaidSvg, selectMermaidRenderHosts } from './mermaid.ts'

const svgWithStyle = (style: string, body = '<rect class="node" width="20" height="20" />'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" id="safe-mermaid" viewBox="0 0 20 20"><style>${style}</style>${body}</svg>`

afterEach(() => {
  document.body.replaceChildren()
})

describe('Mermaid SVG security boundary', () => {
  it('selects only the first eight distinct caller-provided hosts', () => {
    const hosts = Array.from({ length: 9 }, () => document.createElement('figure'))
    const selected = selectMermaidRenderHosts([hosts[0]!, hosts[1]!, hosts[0]!, ...hosts.slice(2)])

    expect([...selected]).toEqual(hosts.slice(0, MERMAID_MAX_DIAGRAMS_PER_ROOT))
  })

  it.each([
    ['escaped url function', svgWithStyle('.node { fill: u\\72l(https://attacker.test/pixel) }')],
    ['escaped url property', svgWithStyle('.node { u\\72l: red }')],
    ['unknown function', svgWithStyle('.node { fill: paint(https://attacker.test/pixel) }')],
    ['raw declaration syntax', svgWithStyle('.node { fill: red garbage }')],
    ['escaped selector', svgWithStyle('.\\66futer { fill: red }')],
    ['remote presentation URL', svgWithStyle('', '<path fill="url(https://attacker.test/paint.svg#x)" d="M0 0h20v20z" />')],
    ['remote quoted style URL', svgWithStyle('.node { fill: url("https://attacker.test/paint.svg#x") }')],
    ['unresolved local marker', svgWithStyle('', '<path marker-end="url(#missing-marker)" d="M0 0h20" />')],
    ['remote style attribute URL', '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill: url(https://attacker.test/paint.svg#x)" d="M0 0h20" /></svg>']
  ])('rejects %s before live insertion', async (_case: string, svg: string) => {
    await expect(parseSafeMermaidSvg(document, svg)).rejects.toThrow()
  })

  it('drops every stylesheet at-rule before serialization', async () => {
    const svg = await parseSafeMermaidSvg(
      document,
      svgWithStyle('@\\69 mport url(https://attacker.test/theme.css); @keyframes hostile { from { fill: red; } } .node { fill: red; }')
    )
    const style = svg.querySelector('style')?.textContent ?? ''

    expect(style).not.toContain('@')
    expect(style).toContain('#safe-mermaid .node')
  })

  it('accepts comments and whitespace only after structural normalization', async () => {
    const svg = await parseSafeMermaidSvg(document, svgWithStyle('/* ignored */\n .node { /* ignored */ fill : rgb(1 2 3 / .5) ; stroke: #123456 ; }'))
    const style = svg.querySelector('style')?.textContent ?? ''

    expect(style).toContain('#safe-mermaid .node')
    expect(style).not.toContain('ignored')
    expect(style).toContain('fill:rgb(1 2 3/.5)')
  })

  it('retains safe local marker references and distinctive static styling', async () => {
    const svg = await parseSafeMermaidSvg(
      document,
      svgWithStyle(
        '.node { fill: #fef3c7; stroke: #92400e; stroke-width: 2px; }',
        '<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0l6 3-6 3z" fill="#92400e" /></marker></defs><path class="node" transform="translate(1, 2)" marker-end="url(#arrow)" d="M0 10h10" />'
      )
    )
    const styledPath = svg.querySelector('path.node')

    expect(styledPath?.getAttribute('marker-end')).toBe('url(#arrow)')
    expect(styledPath?.getAttribute('transform')).toBe('translate(1,2)')
    expect(svg.querySelector('style')?.textContent).toContain('#fef3c7')
    expect(svg.querySelector('style')?.textContent).toContain('#92400e')
  })
})
