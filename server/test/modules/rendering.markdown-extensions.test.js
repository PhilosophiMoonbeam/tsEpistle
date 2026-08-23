import MarkdownIt from 'markdown-it'
import deflist from '../../modules/rendering/markdown-deflist/renderer.ts'
import mark from '../../modules/rendering/markdown-mark/renderer.ts'

describe('markdown highlight and definition-list rendering', () => {
  it('renders the same authored syntax used by the source editor preview', () => {
    const markdown = new MarkdownIt()
    mark.init(markdown, {})
    deflist.init(markdown, {})

    const html = markdown.render('==Important==\n\nTerm\n: Definition')

    expect(html).toContain('<mark>Important</mark>')
    expect(html).toContain('<dl>')
    expect(html).toContain('<dt>Term</dt>')
    expect(html).toContain('<dd>Definition</dd>')
  })
})
