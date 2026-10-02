import { describe, expect, it } from '../../server/test/bun-test.mts'
import { JSDOM } from 'jsdom'
import type * as HistoryDiffModule from './history-diff.ts'
import { exceedsComparisonInputLimits, MAX_COMPARISON_CHARACTERS } from './history-diff.ts'
import { computeHistoryPatch, createHistoryDiffEngine, renderHistoryPatch } from './history-diff-engine.ts'

const request = (overrides: Partial<HistoryDiffModule.HistoryDiffRequest> = {}): HistoryDiffModule.HistoryDiffRequest => ({
  key: '1:2',
  path: 'home',
  source: 'Original paragraph\n',
  target: 'Updated paragraph\n',
  format: 'line-by-line',
  ...overrides
})

const lines = (prefix: string, count: number): string => Array.from({ length: count }, (_, index) => `${prefix}${index}\n`).join('')

describe('history comparison engine', () => {
  it('renders unified and side-by-side markup from one cached patch', () => {
    const compare = createHistoryDiffEngine()
    const unified = compare(request())
    const sideBySide = compare(request({ format: 'side-by-side' }))
    if (unified.status !== 'ready' || sideBySide.status !== 'ready') throw new Error('expected rendered comparisons')
    const unifiedDom = JSDOM.fragment(unified.html)
    expect(unifiedDom.querySelectorAll('.d2h-file-diff')).toHaveLength(1)
    expect(unifiedDom.querySelector('.d2h-file-side-diff')).toBeNull()
    expect(unified.html).toContain('d2h-ins')
    const sideDom = JSDOM.fragment(sideBySide.html)
    expect(sideDom.querySelectorAll('.d2h-file-side-diff')).toHaveLength(2)
  })

  it('reports identical texts as empty without rendering', () => {
    expect(createHistoryDiffEngine()(request({ source: 'same\n', target: 'same\n' }))).toEqual({ status: 'empty' })
  })

  it('rejects oversized input before running the diff', () => {
    const huge = 'a'.repeat(MAX_COMPARISON_CHARACTERS + 1)
    expect(exceedsComparisonInputLimits(huge, 'b')).toBe(true)
    expect(exceedsComparisonInputLimits('x\n'.repeat(50_001), 'y\n'.repeat(50_000))).toBe(true)
    expect(exceedsComparisonInputLimits('small', 'text')).toBe(false)
    expect(computeHistoryPatch('home', huge, 'b')).toEqual({ status: 'limit' })
  })

  it('stops wholly rewritten revisions below the input limits quickly', () => {
    const started = performance.now()
    const result = computeHistoryPatch('home', lines('old', 18_000), lines('new', 18_000))
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result).toEqual({ status: 'limit' })
  })

  it('caps rendered patch rows before diff2html builds markup', () => {
    // 500 separated one-line insertions stay under the edit limit, but each
    // hunk adds context rows, so the patch exceeds the rendered-row cap.
    const source = Array.from({ length: 5_000 }, (_, index) => `line ${index}`)
    const target = source.flatMap((line, index) => (index % 10 === 5 ? [line, `added ${index}`] : [line]))
    expect(computeHistoryPatch('home', `${source.join('\n')}\n`, `${target.join('\n')}\n`)).toEqual({ status: 'limit' })
  })

  it('limits expensive line matching for larger patches', () => {
    const small = computeHistoryPatch('home', 'Original paragraph\n', 'Updated paragraph\n')
    if (small.status !== 'patch') throw new Error('expected a patch')
    expect(small.lines).toBeLessThanOrEqual(200)
    const large = computeHistoryPatch('home', 'Original paragraph\n', 'Updated paragraph\n'.repeat(250))
    if (large.status !== 'patch') throw new Error('expected a patch')
    expect(large.lines).toBeGreaterThan(200)
    const rendered = renderHistoryPatch(large.patch, large.lines, 'line-by-line')
    if (rendered.status !== 'ready') throw new Error('expected markup')
    expect(rendered.html).toContain('d2h-ins')
  })

  it('keeps word comparisons within long changed lines bounded', () => {
    const started = performance.now()
    const outcome = createHistoryDiffEngine()(request({ source: 'old '.repeat(2_000), target: 'new '.repeat(2_000) }))
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(outcome.status).toBe('ready')
  })

  it('escapes revision text in rendered markup', () => {
    const outcome = createHistoryDiffEngine()(request({ source: 'safe\n', target: '<img src=x onerror=alert(1)>\n' }))
    if (outcome.status !== 'ready') throw new Error('expected markup')
    expect(JSDOM.fragment(outcome.html).querySelector('img')).toBeNull()
  })
})
