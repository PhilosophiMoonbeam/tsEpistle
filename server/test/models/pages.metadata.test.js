describe('models/pages.parseMetadata', () => {
  let Page

  beforeEach(() => {
    jest.resetModules()
    global.WIKI = {
      logger: {
        warn: jest.fn()
      }
    }
    Page = require('../../models/pages')
  })

  it('parses markdown frontmatter into metadata and content', () => {
    const raw = `---
title: Example Page
description: Example Description
tags:
  - docs
  - test
---

Hello world`

    expect(Page.parseMetadata(raw, 'markdown')).toEqual({
      title: 'Example Page',
      description: 'Example Description',
      tags: ['docs', 'test'],
      content: 'Hello world'
    })
  })

  it('parses html comment frontmatter into metadata and content', () => {
    const raw = `<!--
title: Example HTML
description: HTML Description
published: true
-->

<section>Rendered</section>`

    expect(Page.parseMetadata(raw, 'html')).toEqual({
      title: 'Example HTML',
      description: 'HTML Description',
      published: true,
      content: '<section>Rendered</section>'
    })
  })

  it('falls back to raw content and logs a warning for invalid markdown frontmatter', () => {
    const raw = `---
title: [unterminated
---

Broken body`

    expect(Page.parseMetadata(raw, 'markdown')).toEqual({
      content: raw
    })
    expect(global.WIKI.logger.warn).toHaveBeenCalledWith('Failed to parse page metadata. Invalid syntax.')
  })
})
