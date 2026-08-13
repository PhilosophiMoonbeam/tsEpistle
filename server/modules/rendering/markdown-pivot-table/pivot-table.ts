import type { MarkdownIt, Token } from 'markdown-it'

const variablePattern = /\{([^{}]+)\}/g
const aggregatePattern = /^(SUM|AVG|MIN|MAX|CNT|ANY)\((.*)\)$/
const maximumExpressionLength = 4096
const maximumParenthesisDepth = 64

type Aggregator = 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'CNT' | 'ANY'

type PivotColumn = {
  index: number
  type: string
  name: string
  aggregator?: Aggregator
  equation?: string
}

type PivotTable = {
  isPivotTable: true
  columns: PivotColumn[]
  visibleColumns: PivotColumn[]
  rows: string[][]
  tokens: {
    open: Token
    close: Token
  }
}

type RegularTable = {
  isPivotTable: false
}

const sliceByTokenTypes = (tokens: Token[], startType: string, endType: string): Token[][] => {
  const slices: Token[][] = []
  for (let start = 0; start < tokens.length; start += 1) {
    if (tokens[start]?.type !== startType) continue
    for (let end = start; end < tokens.length; end += 1) {
      if (tokens[end]?.type !== endType) continue
      slices.push(tokens.slice(start, end + 1))
      start = end
      break
    }
  }
  return slices
}

const parseArithmetic = (expression: string): number => {
  if (expression.length > maximumExpressionLength) {
    throw new SyntaxError(`Pivot table expression exceeds ${maximumExpressionLength} characters.`)
  }

  let position = 0
  let depth = 0
  const skipWhitespace = (): void => {
    while (/\s/.test(expression[position] ?? '')) position += 1
  }

  const parseNumber = (): number => {
    skipWhitespace()
    const match = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(expression.slice(position))
    if (!match) throw new SyntaxError(`Invalid pivot table expression at character ${position + 1}.`)
    position += match[0].length
    return Number(match[0])
  }

  const parsePrimary = (): number => {
    skipWhitespace()
    if (expression[position] !== '(') return parseNumber()
    depth += 1
    if (depth > maximumParenthesisDepth) {
      throw new SyntaxError(`Pivot table expression exceeds ${maximumParenthesisDepth} nested parentheses.`)
    }
    position += 1
    const value = parseAddSubtract()
    skipWhitespace()
    if (expression[position] !== ')') throw new SyntaxError(`Invalid pivot table expression at character ${position + 1}.`)
    position += 1
    depth -= 1
    return value
  }

  const parseUnary = (): number => {
    skipWhitespace()
    let sign = 1
    while (expression[position] === '+' || expression[position] === '-') {
      if (expression[position] === '-') sign *= -1
      position += 1
      skipWhitespace()
    }
    return sign * parsePrimary()
  }

  const parseMultiplyDivide = (): number => {
    let value = parseUnary()
    while (true) {
      skipWhitespace()
      const operator = expression[position]
      if (operator !== '*' && operator !== '/') return value
      position += 1
      const right = parseUnary()
      value = operator === '*' ? value * right : value / right
    }
  }

  const parseAddSubtract = (): number => {
    let value = parseMultiplyDivide()
    while (true) {
      skipWhitespace()
      const operator = expression[position]
      if (operator !== '+' && operator !== '-') return value
      position += 1
      const right = parseMultiplyDivide()
      value = operator === '+' ? value + right : value - right
    }
  }

  const result = parseAddSubtract()
  skipWhitespace()
  if (position !== expression.length || !Number.isFinite(result)) {
    throw new SyntaxError(`Invalid pivot table expression at character ${position + 1}.`)
  }
  return result
}

const parseTable = (tokens: Token[]): PivotTable | RegularTable => {
  let isPivotTable = false
  let foundAggregatedColumn = false
  const columns = sliceByTokenTypes(tokens, 'th_open', 'th_close').map((columnTokens, index): PivotColumn => {
    const content = columnTokens[1]?.content.trim() ?? ''
    if (!content.includes('=')) return { index, type: 'regular', name: content }

    isPivotTable = true
    const separator = content.indexOf('=')
    const left = content.slice(0, separator).trim()
    const right = content.slice(separator + 1).trim()
    if (!left || !right) throw new Error('Pivot table columns require values on both sides of the equal sign.')

    const aggregate = aggregatePattern.exec(right)
    if (aggregate) {
      foundAggregatedColumn = true
      return {
        index,
        type: 'aggregated',
        name: left,
        aggregator: aggregate[1] as Aggregator,
        equation: aggregate[2] ?? ''
      }
    }
    return { index, type: left.toLowerCase(), name: right }
  })

  if (!isPivotTable || !foundAggregatedColumn) return { isPivotTable: false }
  const body = sliceByTokenTypes(tokens, 'tbody_open', 'tbody_close')[0]
  const open = tokens[0]
  const close = tokens.at(-1)
  if (!body || !open || !close) return { isPivotTable: false }

  const rows = sliceByTokenTypes(body, 'tr_open', 'tr_close').map(row =>
    sliceByTokenTypes(row, 'td_open', 'td_close').map(cell => cell[1]?.content ?? '')
  )
  const columnMap = new Map(columns.map(column => [column.name, column]))

  const resolveCell = (row: string[], column: PivotColumn, resolving = new Set<number>()): string => {
    if (resolving.has(column.index)) throw new Error(`Pivot table column ${column.name} contains a circular reference.`)
    resolving.add(column.index)
    let value = row[column.index] || column.equation || ''
    value = value.replace(variablePattern, (_match, columnName: string) => {
      const referencedColumn = columnMap.get(columnName)
      if (!referencedColumn) throw new Error(`Pivot table references unknown column ${columnName}.`)
      return resolveCell(row, referencedColumn, resolving)
    })
    resolving.delete(column.index)
    row[column.index] = value
    return value
  }

  for (const row of rows) {
    for (const column of columns) resolveCell(row, column)
  }

  return {
    isPivotTable: true,
    columns,
    visibleColumns: columns.filter(column => column.type !== 'regular'),
    rows,
    tokens: { open, close }
  }
}

const aggregateColumn = (rows: string[][], column: PivotColumn): string => {
  if (column.type === 'group') return rows[0]?.[column.index] ?? ''
  if (column.type !== 'aggregated' || !column.aggregator) return ''
  if (column.aggregator === 'ANY') return rows.map(row => row[column.index] ?? '').find(value => value.trim()) ?? ''
  if (column.aggregator === 'CNT') return rows.length.toFixed(2)

  const values = rows.map(row => parseArithmetic(row[column.index] || '0'))
  const sum = values.reduce((total, value) => total + value, 0)
  const result = column.aggregator === 'SUM'
    ? sum
    : column.aggregator === 'AVG'
      ? sum / values.length
      : column.aggregator === 'MIN'
        ? values.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY)
        : values.reduce((maximum, value) => Math.max(maximum, value), Number.NEGATIVE_INFINITY)
  return result.toFixed(2)
}

const escapeCell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', '<br>')

const renderTableMarkdown = (table: PivotTable): string => {
  const groups = new Map<string, string[][]>()
  for (const row of table.rows) {
    const key = JSON.stringify(table.visibleColumns
      .filter(column => column.type === 'group')
      .map(column => row[column.index] ?? ''))
    const rows = groups.get(key) ?? []
    rows.push(row)
    groups.set(key, rows)
  }

  const header = `| ${table.visibleColumns.map(column => escapeCell(column.name)).join(' | ')} |`
  const separator = `| ${table.visibleColumns.map(() => '---').join(' | ')} |`
  const body = Array.from(groups.values(), rows =>
    `| ${table.visibleColumns.map(column => escapeCell(aggregateColumn(rows, column))).join(' | ')} |`
  )
  return [header, separator, ...body].join('\n')
}

export default function pivotTable (markdown: MarkdownIt): void {
  markdown.core.ruler.push('pivot_table', state => {
    const tables = sliceByTokenTypes(state.tokens, 'table_open', 'table_close')
      .map(parseTable)
      .filter((table): table is PivotTable => table.isPivotTable)

    for (const table of tables) {
      const replacement = markdown.parse(renderTableMarkdown(table), state.env)
      const openIndex = state.tokens.indexOf(table.tokens.open)
      const closeIndex = state.tokens.indexOf(table.tokens.close)
      state.tokens.splice(openIndex, closeIndex - openIndex + 1, ...replacement)
    }
  })
}
