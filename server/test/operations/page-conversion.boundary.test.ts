import * as cheerio from 'cheerio'
import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import { runPageConversion } from '../../helpers/page-conversion-process.ts'
import { PAGE_CONVERSION_LIMITS as limits, type ConversionWorkerInput } from '../../helpers/page-conversion-protocol.ts'
import { retainPageConversionReview, consumePageConversionReview } from '../../helpers/page-conversion-review.ts'

const request = (source: string): ConversionWorkerInput => ({
  source, page: { path: 'guide/conversion', localeCode: 'en' }, namespaced: false,
  config: { allowHTML: true, linebreaks: true, linkify: true, typographer: false, quotes: 'English', underline: true },
  children: [
    { key: 'markdownSupsub', config: {} }, { key: 'markdownMultiTable', config: {} },
    { key: 'markdownTasklists', config: {} }
  ]
})
afterEach(() => vi.restoreAllMocks())

describe('isolated HTML conversion fidelity and refusal', () => {
  it('retains decoded literal code rather than converted nested formatting or fence delimiters', async () => {
    const result = await runPageConversion(request('<pre><code>&lt;x&gt;<strong>*literal*</strong>\\ &amp; ```</code></pre><p><code><em>nested</em> `code`</code></p>'))
    const $ = cheerio.load(result.report.previewHtml)
    expect($('pre code').text()).toBe('<x>*literal*\\ & ```\n')
    expect($('p code').text()).toBe('nested `code`')
    expect(result.candidate).toContain('````')
    expect(result.report.warnings.join(' ')).toContain('not certified lossless')
  }, 15_000)

  it('reports native renderer interpretation of literal entities, delimiters and backslashes honestly', async () => {
    const source = '<p>~literal~ ^caret^ &amp; &lt;literal&gt; \\ [brackets] {#id}</p>'
    const result = await runPageConversion(request(source))
    const before = cheerio.load(source).root().text().replace(/\s+/g, ' ').trim()
    const after = cheerio.load(result.report.previewHtml).root().text().replace(/\s+/g, ' ').trim()
    expect(result.report.differences.text).toBe(before !== after)
    expect(result.report.warnings.some(warning => warning.includes('lossless'))).toBe(true)
    expect(result.report.roundtripSource).toBeTypeOf('string')
  }, 15_000)

  it('preserves balanced and escaped URL destinations and discloses newly linkified bare URLs', async () => {
    const source = '<p><a href="https://example.test/a_(b)">balanced</a> <a href="https://example.test/a%5Cb?q=a&amp;b=2">escaped</a> https://bare.test/path</p>'
    const result = await runPageConversion(request(source))
    const $ = cheerio.load(result.report.previewHtml)
    expect($('a').map((_i, node) => $(node).attr('href')).toArray()).toEqual([
      'https://example.test/a_(b)', 'https://example.test/a%5Cb?q=a&b=2', 'https://bare.test/path'
    ])
    expect(result.report.differences.links).toBe(true)
  }, 15_000)

  it.each([
    '<table><tr><th>Head</th></tr><tr><td>Body</td></tr></table>',
    '<table><tr><td>Headerless</td></tr></table>',
    '<table><tr><td colspan="2">Merged</td></tr><tr><td>A</td><td>B</td></tr></table>',
    '<table><tr><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></table>'
  ])('keeps table content reviewable without declaring table structure lossless: %s', async source => {
    const result = await runPageConversion(request(source))
    const text = cheerio.load(source).root().text()
    for (const word of text.match(/[A-Z][a-z]+/g) ?? []) expect(result.candidate).toContain(word)
    expect(result.report.warnings.join(' ')).toContain('not certified lossless')
    expect(result.report.differences.tables).toBeTypeOf('boolean')
  }, 15_000)

  it('returns an explicit empty candidate rather than silently retaining the HTML', async () => {
    const result = await runPageConversion(request('<p></p>'))
    expect(result.candidate).toBe('')
    expect(result.report.warnings.join(' ')).toContain('candidate is empty')
  }, 15_000)

  it.each([
    'x'.repeat(limits.inputBytes + 1),
    '<div>'.repeat(limits.depth + 1) + 'deep' + '</div>'.repeat(limits.depth + 1),
    '<i>x</i>'.repeat(limits.nodes),
    '<table>' + '<tr><td>x</td></tr>'.repeat(limits.tableRows + 1) + '</table>',
    '<table><tr><td colspan="999999999">wide</td></tr></table>'
  ])('refuses over-budget input without exposing source in the error', async source => {
    const outcome = await runPageConversion(request(source)).then(() => null, error => error)
    expect(outcome).toMatchObject({ name: 'CONVERSION_REFUSED' })
    expect(outcome.message).not.toContain(source)
  }, 15_000)

  it('refuses exhausted concurrency immediately and releases every cancelled reservation', async () => {
    const controllers = [new AbortController(), new AbortController()]
    const work = controllers.map(controller => runPageConversion(request('<p>pending</p>'), controller.signal).catch(error => error))
    await expect(runPageConversion(request('<p>third</p>'))).rejects.toMatchObject({ name: 'CONVERSION_REFUSED', status: 429 })
    for (const controller of controllers) controller.abort()
    expect((await Promise.all(work)).every(error => error.name === 'AbortError')).toBe(true)
    expect((await runPageConversion(request('<p>capacity returned</p>'))).candidate).toBe('capacity returned')
  }, 15_000)

  it('keeps the event loop responsive and reaps an abandoned real child', async () => {
    const nativeSpawn = Bun.spawn
    const spawned = Promise.withResolvers<Bun.Subprocess<'pipe', 'pipe', 'pipe'>>()
    let reaped = false
    vi.spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
      const child = nativeSpawn(args[0] as string[], args[1] as Bun.SpawnOptions.BaseOptions<'pipe', 'pipe', 'pipe'>)
      void child.exited.then(() => { reaped = true })
      spawned.resolve(child)
      return child as never
    })
    const controller = new AbortController()
    const conversion = runPageConversion(request('<p>bounded text</p>'.repeat(5000)), controller.signal).catch(error => ({ error, reaped }))
    const child = await spawned.promise
    try {
      // Real child/event-loop integration: a fake clock cannot establish host responsiveness.
      const { promise: heartbeat, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 0)
      await heartbeat
      controller.abort()
      // Snapshot at rejection, before test teardown can wait for an unreaped child.
      expect(await conversion).toMatchObject({ error: { name: 'AbortError' }, reaped: true })
    } finally {
      controller.abort()
      if (!reaped) child.kill('SIGKILL')
      await child.exited
    }
  }, 15_000)

  it.each([
    ['output', "process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)"],
    ['memory', "const retained=[];setInterval(()=>retained.push(Buffer.alloc(16*1024*1024,1)),5)"],
    ['deadline', 'while(true){}']
  ])('terminates and reaps a child breaching its %s budget', async (_kind, program) => {
    const nativeSpawn = Bun.spawn
    const spawned = Promise.withResolvers<Bun.Subprocess<'pipe', 'pipe', 'pipe'>>()
    let reaped = false
    // Exercise the real supervisor against an actually hostile subprocess, not a fake timeout.
    vi.spyOn(Bun, 'spawn').mockImplementation((...args: unknown[]) => {
      const child = nativeSpawn([process.execPath, '--no-env-file', '-e', program], args[1] as Bun.SpawnOptions.BaseOptions<'pipe', 'pipe', 'pipe'>)
      void child.exited.then(() => { reaped = true })
      spawned.resolve(child)
      return child as never
    })
    const work = runPageConversion(request('<p>owned budget fixture</p>')).catch(error => ({ error, reaped }))
    const child = await spawned.promise
    try {
      expect(await work).toMatchObject({ error: { name: 'CONVERSION_REFUSED' }, reaped: true })
    } finally {
      if (!reaped) child.kill('SIGKILL')
      await child.exited
    }
  }, 15_000)
})

describe('server-custodied conversion confirmation binding', () => {
  const binding = { pageId: 42, sourceRevision: '9', editor: 'markdown', userId: 7, source: '<p>Exact\r\nsource &amp; bytes</p>' }
  const result = { candidate: '', report: { warnings: ['empty'], differences: { text: true, code: false, links: false, tables: false }, roundtripSource: '', previewHtml: '', renderer: 'native markdownCore' } }
  it.each([
    { pageId: 43 }, { sourceRevision: '10' }, { editor: 'visual-markdown' }, { userId: 8 }, { source: '<p>changed</p>' }
  ])('rejects changed review bindings without consuming the authorized candidate: %j', changes => {
    const review = retainPageConversionReview(binding, result)
    expect(review.originalSource).toBe(binding.source)
    expect(() => consumePageConversionReview({ ...binding, ...changes, reviewToken: review.reviewToken })).toThrow()
    expect(consumePageConversionReview({ ...binding, reviewToken: review.reviewToken })).toBe('')
    expect(() => consumePageConversionReview({ ...binding, reviewToken: review.reviewToken })).toThrow()
  })
  it('refuses unknown browser-authored candidates', () => {
    expect(() => consumePageConversionReview({ ...binding, reviewToken: 'forged' })).toThrow()
  })
  it('retires an expired review rather than accepting a previously authorized snapshot', () => {
    const review = retainPageConversionReview(binding, result)
    const issued = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(issued + limits.reviewTtlMs + 1)
    expect(() => consumePageConversionReview({ ...binding, reviewToken: review.reviewToken })).toThrow()
  })
  it('requires the same server-side session binding when a review belongs to a browser session', () => {
    const session = { ...binding, sessionBinding: 'trusted-session-a' }
    const review = retainPageConversionReview(session, result)
    expect(() => consumePageConversionReview({ ...binding, sessionBinding: 'trusted-session-b', reviewToken: review.reviewToken })).toThrow()
    expect(consumePageConversionReview({ ...session, reviewToken: review.reviewToken })).toBe('')
  })
})
