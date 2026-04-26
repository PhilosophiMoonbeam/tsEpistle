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

  it('pins attrs allowlist behavior on links and images', async () => {
    await expect(renderMarkdown('[x](/url){#lnk .primary target=_blank rel=noopener onclick=alert(1)}\n\n![alt](img.png){#img .thumb target=_blank onload=alert(1) style="color:red"}')).resolves.toBe(
      '<p><a href="/url" id="lnk" class="primary" target="_blank">x</a></p>\n' +
      '<p><img src="img.png" alt="alt" id="img" class="thumb" target="_blank"></p>\n'
    )
  })

  it('pins attrs behavior on lists, code, and malformed declarations', async () => {
    await expect(renderMarkdown('- item {#li .entry target=_blank onclick=evil}\n- second\n{#lst .list onclick=evil}\n\n`code`{#c .kbd target=_blank onclick=evil}\n\nbad {.}\n\nbad {key}\n\nx {.a .b #one #two target=_blank onclick=evil}')).resolves.toBe(
      '<ul id="lst" class="list">\n' +
      '<li id="li" class="entry" target="_blank">item</li>\n' +
      '<li>second</li>\n' +
      '</ul>\n' +
      '<p><code id="c" class="kbd" target="_blank">code</code></p>\n' +
      '<p>bad {.}</p>\n' +
      '<p>bad</p>\n' +
      '<p class="a b" id="one" id="two" target="_blank">x</p>\n'
    )
  })

  it('pins attrs behavior on tables, blockquotes, and horizontal rules', async () => {
    await expect(renderMarkdown('A | B\n--|--\n1 {#cell .hot target=_blank onclick=evil colspan=2} | 2\n\n{#tbl .striped target=_blank onclick=evil border=1}\n\n> quote {#q .quote onclick=evil}\n\n--- {#hr .rule onclick=evil}')).resolves.toBe(
      '<table id="tbl" class="striped" target="_blank">\n' +
      '<thead>\n' +
      '<tr>\n' +
      '<th>A</th>\n' +
      '<th>B</th>\n' +
      '</tr>\n' +
      '</thead>\n' +
      '<tbody>\n' +
      '<tr>\n' +
      '<td id="cell" class="hot" target="_blank">1</td>\n' +
      '<td>2</td>\n' +
      '</tr>\n' +
      '</tbody>\n' +
      '</table>\n' +
      '<blockquote id="q" class="quote">\n' +
      '<p>quote</p>\n' +
      '</blockquote>\n' +
      '<hr id="hr" class="rule">\n'
    )
  })

  it('pins attrs behavior around rejected javascript links and footnotes', async () => {
    await expect(renderMarkdown('[x](javascript:alert(1)){target=_blank onclick=alert(1)}\n\n[x](https://example.test){target=_blank rel=noopener onclick=evil}\n\nRef[^1]{.ref onclick=evil}\n\n[^1]: foot body {.fnbody onclick=evil}', {
      children: [
        { key: 'markdownFootnotes', config: {} }
      ]
    })).resolves.toBe(
      '<p target="_blank">[x](javascript:alert(1))</p>\n' +
      '<p><a href="https://example.test" target="_blank">x</a></p>\n' +
      '<p class="ref">Ref<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup></p>\n' +
      '<hr class="footnotes-sep">\n' +
      '<section class="footnotes">\n' +
      '<ol class="footnotes-list">\n' +
      '<li id="fn1" class="footnote-item"><p>foot body <a href="#fnref1" class="footnote-backref">↩︎</a></p>\n' +
      '</li>\n' +
      '</ol>\n' +
      '</section>\n'
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
