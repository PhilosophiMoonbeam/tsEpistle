const renderer = require('../../modules/rendering/markdown-core/renderer')

const baseConfig = {
  allowHTML: false,
  linebreaks: false,
  linkify: false,
  typographer: false,
  quotes: 'English',
  underline: false
}

const renderMarkdown = (input, { config = {}, children = [] } = {}) => {
  return renderer.render.call({
    input,
    config: {
      ...baseConfig,
      ...config
    },
    children
  })
}

describe('markdown core renderer plugin behavior', () => {
  it('pins core attrs allowlist and escapes raw HTML by default', async () => {
    await expect(renderMarkdown('# Title {#hero .lead target=_blank onclick=alert(1)}\n\n<strong>ok</strong>')).resolves.toBe(
      '<h1 id="hero" class="lead" target="_blank">Title</h1>\n' +
      '<p>&lt;strong&gt;ok&lt;/strong&gt;</p>\n'
    )
  })

  it('honors selected markdown-it core config toggles', async () => {
    await expect(renderMarkdown('hello\nworld\n\nhttps://example.com\n\n"hi"', {
      config: {
        linebreaks: true,
        linkify: true,
        typographer: true,
        quotes: 'French'
      }
    })).resolves.toBe(
      '<p>hello<br>\nworld</p>\n' +
      '<p><a href="https://example.com">https://example.com</a></p>\n' +
      '<p>« hi »</p>\n'
    )
  })

  it('allows raw HTML only when allowHTML is enabled', async () => {
    await expect(renderMarkdown('<strong>ok</strong>', {
      config: {
        allowHTML: true
      }
    })).resolves.toBe('<p><strong>ok</strong></p>\n')
  })

  it('pins code fence highlighting and diagram decoding', async () => {
    await expect(renderMarkdown('```js\nif (a < b) return "x"\n```\n\n```diagram\nPGI+aGk8L2I+\n```')).resolves.toBe(
      '<pre><code class="language-js">if (a &lt; b) return &quot;x&quot;\n</code></pre>\n' +
      '<pre class="diagram"><b>hi</b></pre>\n'
    )
  })

  it('pins abbreviation rendering', async () => {
    await expect(renderMarkdown('*[HTML]: Hyper Text Markup Language\n\nHTML rocks', {
      children: [
        { key: 'markdownAbbr', config: {} }
      ]
    })).resolves.toBe('<p><abbr title="Hyper Text Markup Language">HTML</abbr> rocks</p>\n')
  })

  it('pins footnote markup', async () => {
    await expect(renderMarkdown('Footnote ref[^1].\n\n[^1]: Footnote **body**.', {
      children: [
        { key: 'markdownFootnotes', config: {} }
      ]
    })).resolves.toBe(
      '<p>Footnote ref<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>.</p>\n' +
      '<hr class="footnotes-sep">\n' +
      '<section class="footnotes">\n' +
      '<ol class="footnotes-list">\n' +
      '<li id="fn1" class="footnote-item"><p>Footnote <strong>body</strong>. <a href="#fnref1" class="footnote-backref">↩︎</a></p>\n' +
      '</li>\n' +
      '</ol>\n' +
      '</section>\n'
    )
  })

  it('pins subscript and superscript rendering, including config gating', async () => {
    await expect(renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: true, supEnabled: true } }
      ]
    })).resolves.toBe('<p>H<sub>2</sub>O and x<sup>2</sup></p>\n')

    await expect(renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: true, supEnabled: false } }
      ]
    })).resolves.toBe('<p>H<sub>2</sub>O and x^2^</p>\n')

    await expect(renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: false, supEnabled: true } }
      ]
    })).resolves.toBe('<p>H~2~O and x<sup>2</sup></p>\n')

    await expect(renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: false, supEnabled: false } }
      ]
    })).resolves.toBe('<p>H~2~O and x^2^</p>\n')
  })

  it('pins task list and image size plugin output', async () => {
    await expect(renderMarkdown('- [x] done\n- [ ] todo\n\n![alt](img.png =120x80)', {
      children: [
        { key: 'markdownTasklists', config: {} },
        { key: 'markdownImsize', config: {} }
      ]
    })).resolves.toBe(
      '<ul class="contains-task-list">\n' +
      '<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> done</li>\n' +
      '<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> todo</li>\n' +
      '</ul>\n' +
      '<p><img src="img.png" alt="alt" width="120" height="80"></p>\n'
    )
  })
})
