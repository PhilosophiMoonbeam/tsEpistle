import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { parseSafeMermaidSvg } from './mermaid.ts'
// @ts-expect-error css-tree 3.2.1 does not publish TypeScript declarations.
import { parse, walk } from 'css-tree'

type CssFunction = {
  name: string
  children: { forEach: (callback: (node: { type: string; value: string }) => void) => void }
}

const svgWithStyle = (style: string, body = '<rect class="node" width="20" height="20" />'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" id="safe-mermaid" viewBox="0 0 20 20"><style>${style}</style>${body}</svg>`

afterEach(() => {
  document.body.replaceChildren()
})

describe('Mermaid SVG security boundary', () => {
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
    const fills: number[][] = []
    walk(parse(style), {
      visit: 'Rule',
      enter(rule: { prelude: unknown; block: unknown }) {
        const selectors: string[] = []
        walk(rule.prelude, {
          enter(node: { type: string; name: string }) {
            if (node.type === 'IdSelector' || node.type === 'ClassSelector') selectors.push(`${node.type}:${node.name}`)
          }
        })
        if (!selectors.includes('IdSelector:safe-mermaid') || !selectors.includes('ClassSelector:node')) return
        walk(rule.block, {
          visit: 'Declaration',
          enter(node: { property: string; value: unknown }) {
            if (node.property !== 'fill') return
            const numbers: number[] = []
            walk(node.value, {
              visit: 'Function',
              enter(value: CssFunction) {
                expect(value.name).toBe('rgb')
                value.children.forEach(argument => {
                  if (argument.type === 'Number') numbers.push(Number(argument.value))
                })
              }
            })
            fills.push(numbers)
          }
        })
      }
    })
    expect(fills).toEqual([[1, 2, 3, 0.5]])
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
    const transforms: Array<{ name: string; numbers: number[] }> = []
    walk(parse(styledPath?.getAttribute('transform') ?? '', { context: 'value' }), {
      visit: 'Function',
      enter(node: CssFunction) {
        const numbers: number[] = []
        node.children.forEach(argument => {
          if (argument.type === 'Number') numbers.push(Number(argument.value))
        })
        transforms.push({ name: node.name, numbers })
      }
    })
    expect(transforms).toEqual([{ name: 'translate', numbers: [1, 2] }])
    expect(svg.querySelector('style')?.textContent).toContain('#fef3c7')
    expect(svg.querySelector('style')?.textContent).toContain('#92400e')
  })
})
