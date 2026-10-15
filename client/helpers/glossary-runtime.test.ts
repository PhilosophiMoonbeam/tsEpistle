import { afterEach, describe, expect, it } from '../../server/test/bun-test.mts'
import { glossaryHref, glossaryQueryLink, linkGlossaryContent } from './glossary-runtime.ts'

const term = (id: number, name: string, aliases: string[] = [], caseSensitive = false) => ({ id, term: name, aliases, caseSensitive })
afterEach(() => document.body.replaceChildren())

describe('glossary DOM reader links', () => {
  it('selects the longest alias once per term, preserves Unicode boundaries and restores original text nodes', () => {
    const root = document.createElement('article')
    root.innerHTML = '<p>cat concatenate cat caféine cafe\u0301 CAFÉ. New York and York, New York.</p>'
    document.body.append(root)
    const paragraph = root.firstElementChild!,
      original = paragraph.firstChild!,
      source = root.innerHTML
    const cleanup = linkGlossaryContent(root, [term(1, 'cat'), term(2, 'café'), term(3, 'York', ['New York'])], 'https://wiki.test/en/guide?view=read#part')
    const links = [...root.querySelectorAll('a')]
    expect(links.map(link => link.textContent)).toEqual(['cat', 'cafe\u0301', 'New York'])
    expect(links[1]!.getAttribute('href')).toBe('/en/guide?view=read&glossary=caf%C3%A9#part')
    cleanup()
    expect(root.innerHTML).toBe(source)
    expect(paragraph.firstChild).toBe(original)
  })

  it('treats normalized spellings equally and respects word boundaries across inline markup', () => {
    const root = document.createElement('article')
    root.innerHTML = '<p>con<em>cat</em>enate CAFÉ cafe\u0301 <span>cat</span> \u1100\u1161\u11a8 각</p>'
    const cleanup = linkGlossaryContent(root, [term(1, 'cat'), term(2, 'café'), term(3, '각')], 'https://wiki.test/en/guide')
    expect([...root.querySelectorAll('a')].map(link => link.textContent)).toEqual(['CAFÉ', 'cat', '\u1100\u1161\u11a8'])
    expect(root.querySelector('em a')).toBeNull()
    cleanup()
  })

  it('honors case sensitivity and excludes links, headings, controls, diagrams, media and custom elements', () => {
    const root = document.createElement('article')
    root.innerHTML =
      '<h2>API</h2><pre>API</pre><code>API</code><a href="/x">API</a><button>API</button><textarea>API</textarea><div contenteditable="true">API</div><div class="mermaid">API</div><svg><text>API</text></svg><my-widget>API</my-widget><figure>API</figure><p>api API API</p>'
    document.body.append(root)
    const cleanup = linkGlossaryContent(root, [term(1, 'API', [], true)], 'https://wiki.test/en/guide')
    expect(root.querySelectorAll('[data-glossary-owned] a').length).toBe(1)
    expect(root.querySelector('p a')?.textContent).toBe('API')
    expect(root.querySelector('h2 a')).toBeNull()
    expect(root.querySelector('my-widget a')).toBeNull()
    cleanup()
  })

  it('makes explicit tokens usable with an empty automatic catalog and never creates authored HTML', () => {
    const root = document.createElement('article')
    root.textContent = '[[Glossary:Long term|<img onerror=x>]] and [[Glossary:Other]]'
    const original = root.firstChild
    const cleanup = linkGlossaryContent(root, [], 'https://wiki.test/en/guide?other=1#section')
    expect([...root.querySelectorAll('a')].map(link => link.textContent)).toEqual(['<img onerror=x>', 'Other'])
    expect(root.querySelector('img')).toBeNull()
    cleanup()
    expect(root.firstChild).toBe(original)
  })

  it('updates only the glossary query and accepts only current-page query links', () => {
    expect(glossaryHref('https://wiki.test/en/guide?other=a%2Fb&glossary=Old#part', 'New term')).toBe('/en/guide?other=a%2Fb&glossary=New+term#part')
    expect(glossaryHref('https://wiki.test/en/guide?other=1&glossary=Old#part', null)).toBe('/en/guide?other=1#part')
    const link = document.createElement('a')
    link.href = 'https://wiki.test/en/guide?glossary='
    expect(glossaryQueryLink(link, 'https://wiki.test/en/guide')).toBe('')
    link.href = 'https://foreign.test/en/guide?glossary=Private'
    expect(glossaryQueryLink(link, 'https://wiki.test/en/guide')).toBeUndefined()
    link.href = 'https://wiki.test/en/other?glossary=Other'
    expect(glossaryQueryLink(link, 'https://wiki.test/en/guide')).toBeUndefined()
  })
})
