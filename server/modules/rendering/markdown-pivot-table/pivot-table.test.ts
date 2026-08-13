import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'

import pivotTable from './pivot-table.ts'

const render = (source: string): string => new MarkdownIt().use(pivotTable).render(source)

describe('Markdown pivot table renderer', () => {
  it('groups rows and evaluates arithmetic expressions', () => {
    const result = render(`
|Group=Category|Unit Cost|Qty|Subtotal=SUM({Unit Cost}*{Qty})|
|---|---|---|---|
|Hardware|2.50|4||
|Hardware|3|2||
|Software|5|3||
`)

    expect(result).toContain('<th>Category</th>')
    expect(result).toContain('<th>Subtotal</th>')
    expect(result).toContain('<td>Hardware</td>')
    expect(result).toContain('<td>16.00</td>')
    expect(result).toContain('<td>Software</td>')
    expect(result).toContain('<td>15.00</td>')
  })

  it('keeps delimiter-like group values in separate groups', () => {
    const result = render(`
|Group=First|Group=Second|Total=SUM()|
|---|---|---|
|a:b|c|1|
|a|b:c|2|
`)

    expect(result).toContain('<td>a:b</td>')
    expect(result).toContain('<td>1.00</td>')
    expect(result).toContain('<td>b:c</td>')
    expect(result).toContain('<td>2.00</td>')
  })

  it('rejects circular column references', () => {
    expect(() => render(`
|Group=Category|Left|Right|Total=SUM({Left})|
|---|---|---|---|
|Hardware|{Right}|{Left}||
`)).toThrow('contains a circular reference')
  })

  it('bounds hostile arithmetic expressions', () => {
    const expression = '1+'.repeat(3000) + '1'
    expect(() => render(`
|Group=Category|Total=SUM()|
|---|---|
|Hardware|${expression}|
`)).toThrow('exceeds 4096 characters')
  })
})
