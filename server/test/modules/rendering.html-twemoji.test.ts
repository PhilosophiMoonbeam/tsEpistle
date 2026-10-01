import * as cheerio from 'cheerio'
import { describe, expect, it } from '../bun-test.mts'

import twemojiRenderer from '../../modules/rendering/html-twemoji/renderer.ts'

describe('HTML Twemoji renderer', () => {
  it('replaces emoji in text while preserving code and script contents', () => {
    const output = twemojiRenderer.init('<p>Hello 👋</p><pre><code>const emoji = "👋"</code></pre><script>window.value = "👋"</script>', {})

    const $ = cheerio.load(output)
    const emoji = $('p > img.emoji')
    expect(emoji).toHaveLength(1)
    expect(emoji.attr('draggable')).toBe('false')
    expect(emoji.attr('alt')).toBe('👋')
    expect($('p').text()).toBe('Hello ')
    expect(output).toContain('<pre><code>const emoji = "👋"</code></pre>')
    expect(output).toContain('<script>window.value = "👋"</script>')
    expect($('img.emoji')).toHaveLength(1)
  })
})
