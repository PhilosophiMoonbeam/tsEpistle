import * as cheerio from 'cheerio'
import { describe, expect, it } from '../bun-test.mts'

import renderer from '../../modules/rendering/html-codehighlighter/renderer.ts'

const enhance = async (html: string): Promise<cheerio.CheerioAPI> => {
  const $ = cheerio.load(html, null, false)
  await renderer.init($, {})
  return $
}

describe('HTML code highlighter metadata', () => {
  it('keeps single-line code compact and numbers real multi-line blocks', async () => {
    const $ = await enhance(
      '<pre><code class="language-js">one</code></pre>' +
      '<pre><code class="language-js">one\ntwo\n</code></pre>'
    )
    const blocks = $('pre').toArray()

    expect($(blocks[0]).hasClass('prismjs')).toBe(true)
    expect($(blocks[0]).hasClass('line-numbers')).toBe(false)
    expect($(blocks[1]).hasClass('prismjs')).toBe(true)
    expect($(blocks[1]).hasClass('line-numbers')).toBe(true)
  })

  it('preserves explicit line metadata and numbering requests', async () => {
    const $ = await enhance(
      '<pre class="prismjs language-ts line-numbers" data-start="30" data-line-offset="29" data-line="30">' +
      '<code class="language-ts">one</code></pre>'
    )
    const block = $('pre')

    expect(block.hasClass('prismjs')).toBe(true)
    expect(block.hasClass('language-ts')).toBe(true)
    expect(block.hasClass('line-numbers')).toBe(true)
    expect(block.attr('data-start')).toBe('30')
    expect(block.attr('data-line-offset')).toBe('29')
    expect(block.attr('data-line')).toBe('30')
  })
})
