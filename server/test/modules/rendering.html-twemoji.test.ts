import { describe, expect, it } from 'vitest'

import twemojiRenderer from '../../modules/rendering/html-twemoji/renderer.ts'

describe('HTML Twemoji renderer', () => {
  it('replaces emoji in text while preserving code and script contents', () => {
    const output = twemojiRenderer.init('<p>Hello 👋</p><pre><code>const emoji = "👋"</code></pre><script>window.value = "👋"</script>', {})

    expect(output).toContain('<p>Hello <img class="emoji" draggable="false" alt="👋"')
    expect(output).toContain('<pre><code>const emoji = "👋"</code></pre>')
    expect(output).toContain('<script>window.value = "👋"</script>')
    expect(output.match(/class="emoji"/g)).toHaveLength(1)
  })
})
