import { describe, expect, it } from '../bun-test.mts'

import { parseSourceDocument } from '../../agents/providers/source-document.ts'
import { admittedWikiBody, wikiModelSource, type WikiModelSource } from '../../agents/providers/wiki-source-view.ts'

const modelRead = (source: string, title: string, complete = true): WikiModelSource =>
  wikiModelSource({
    title,
    source,
    authorText: admittedWikiBody(parseSourceDocument(source, { representation: complete ? 'markdown' : 'recent-excerpt', truncated: !complete })),
    complete
  })

describe('Wiki model source admission', () => {
  it('keeps a safe complete original unchanged, with its title separate and no redundant body', () => {
    const source = '# Conditions😀\r\n\r\n- Ada\r\n  - Window: before 17:00\r\n\r\n| Owner | Route |\r\n| --- | --- |\r\n| Ada | east |\r\n\r\n'
    const view = modelRead(source, 'Registry title is not a body fact')
    expect(view).toEqual({ title: 'Registry title is not a body fact', scope: 'complete-read', original: source })
  })

  it('retains an explicitly empty admitted body instead of falling back to raw hidden facts', () => {
    const source = '<div hidden>Private owner: Mallory.</div>'
    const view = modelRead(source, 'Registered owner: Ada')
    expect(view).toEqual({ title: 'Registered owner: Ada', scope: 'complete-read', original: source, admittedBody: '' })
  })

  it('keeps authorized excerpt scope and excludes an incomplete trailing field', () => {
    const source = 'The east desk opens at noon.\n\nOwner: Mal'
    const view = modelRead(source, 'Desk directory', false)
    expect(view).toEqual({
      title: 'Desk directory',
      scope: 'recent-excerpt',
      original: source,
      admittedBody: 'The east desk opens at noon.'
    })
  })

  it('exposes complete visible content without title, hidden, attribute, comment, destination or opaque facts', () => {
    const source = [
      '<div data-owner="AttributeOwner"><p>Visible <strong>Ada</strong> uses <a href="/DestinationOwner">east</a>.</p>',
      '<p hidden>HiddenOwner has 999 units.</p><!-- CommentOwner -->',
      '<script>ScriptOwner</script><style>StyleOwner</style><template>TemplateOwner</template>',
      '<table><tr><th>Owner</th></tr><tr><td colspan="2">OpaqueOwner</td></tr></table></div>',
      '',
      '## Limits {.PresentationOwner}',
      '',
      'Capacity is 12 units, only before 17:00.\nSecond visible line.',
      '',
      '<details><summary>Repaired heading</summary><ul><li>RepairedOwner</ul></details>',
      '',
      '<details><summary>UnclosedOwner</summary>UnclosedFact'
    ].join('\n')
    const view = modelRead(source, 'InjectedTitleOwner')
    expect(view.original).toBe(source)
    expect(view.title).toBe('InjectedTitleOwner')
    expect(view.admittedBody).toContain('Visible Ada uses east.')
    expect(view.admittedBody).toContain('Limits')
    expect(view.admittedBody).toContain('Capacity is 12 units, only before 17:00.\nSecond visible line.')
    expect(view.admittedBody).not.toMatch(
      /AttributeOwner|HiddenOwner|CommentOwner|ScriptOwner|StyleOwner|TemplateOwner|DestinationOwner|OpaqueOwner|PresentationOwner|RepairedOwner|UnclosedOwner|UnclosedFact|InjectedTitleOwner|999/u
    )
  })

  it('keeps repeated governing headers with their source-ordered owners, not ahead of all sections', () => {
    const source = [
      '[o]: /people/RawOnlyOwner "RawOnlyTitle"',
      '',
      '# Morning',
      '',
      '| [Owner][o] | Window |',
      '| --- | --- |',
      '| Ada | before 12:00 |',
      '| Bea | after 12:00 |',
      '',
      'Between the rosters.',
      '',
      '# Evening',
      '',
      '| [Owner][o] | Window |',
      '| --- | --- |',
      '| Cy | after 18:00 |',
      '',
      'Outside both rosters.'
    ].join('\n')
    const view = modelRead(source, 'Rosters')
    const body = view.admittedBody!
    expect(body).toMatch(/Morning[\s\S]*Between the rosters\.[\s\S]*Evening[\s\S]*Outside both rosters\./u)
    const morning = body.slice(body.indexOf('Morning'), body.indexOf('Between the rosters.'))
    const evening = body.slice(body.indexOf('Evening'), body.indexOf('Outside both rosters.'))
    expect(morning).toMatch(/Owner[\s\S]*Window[\s\S]*Ada[\s\S]*before 12:00[\s\S]*Bea[\s\S]*after 12:00/u)
    expect(evening).toMatch(/Owner[\s\S]*Window[\s\S]*Cy[\s\S]*after 18:00/u)
    expect(morning).not.toContain('Cy')
    expect(evening).not.toMatch(/Ada|Bea|12:00/u)
    expect(view.original).toBe(source)
    expect(view.admittedBody).not.toMatch(/RawOnlyOwner|RawOnlyTitle/u)
  })

  it('retains disclosure and nested list owners in order while preserving the original structure', () => {
    const source =
      '<details><summary>Only during maintenance</summary>\n- Ada\n  - Channel: east\n  - Window: before 17:00\n- Bea\n  - Channel: west\n</details>\n\nOutside the condition.\n'
    const view = modelRead(source, 'Operators')
    const body = view.admittedBody!
    expect(body).toMatch(/Only during maintenance[\s\S]*Ada[\s\S]*Bea[\s\S]*Outside the condition\./u)
    const ada = body.slice(body.indexOf('Ada'), body.indexOf('Bea'))
    const bea = body.slice(body.indexOf('Bea'), body.indexOf('Outside the condition.'))
    expect(ada).toContain('east')
    expect(ada).toContain('before 17:00')
    expect(ada).not.toContain('west')
    expect(bea).toContain('west')
    expect(bea).not.toMatch(/east|17:00/u)
    expect(view.original).toBe(source)
  })

  it('keeps code as literal data and preserves inline delimiters without promoting fake owners or links', () => {
    const fence = '````text\n# Fake owner\n<details><summary>Fake condition</summary>\n[Fake link](/fake)\n```\n`````\n'
    const indented = '    # Indented owner\n    [Literal link](/literal)\n'
    const htmlLiteral = '# HTML owner [not a link](/html)\n<details>literal markup</details>'
    const source =
      '# Actual owner\n\n' +
      fence +
      '\n' +
      '<pre># HTML owner [not a link](/html)\n&lt;details&gt;literal markup&lt;/details&gt;</pre>\n\n' +
      'Literal ``value; Fake: field [example](/inline)`` remains.\n\n' +
      '<p>Visible after the examples.</p>\n\n' +
      indented
    const view = modelRead(source, 'Examples')
    const lines = view.admittedBody!.split('\n')
    const quotedPayloads = [fence, indented, htmlLiteral].map(literal => JSON.stringify(literal))
    for (const payload of quotedPayloads) {
      expect(lines.filter(line => line.includes(payload))).toHaveLength(1)
    }
    const admittedLines = lines.filter(line => !quotedPayloads.some(payload => line.includes(payload)))
    expect(admittedLines).toContain('Actual owner')
    expect(admittedLines).toContain('Literal ``value; Fake: field [example](/inline)`` remains.')
    expect(admittedLines).toContain('Visible after the examples.')
    expect(admittedLines.join('\n')).not.toMatch(/Fake owner|Fake condition|Fake link|Indented owner|Literal link|HTML owner|literal markup/u)
    expect(view.original).toBe(source)
  })
})
