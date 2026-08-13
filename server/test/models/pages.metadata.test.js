import { EventEmitter } from 'node:events'

const originalWIKI = global.WIKI

describe('models/pages.parseMetadata', () => {
  let Page

  beforeEach(async () => {
    vi.resetModules()
    global.WIKI = {
      ROOTPATH: '/test',
      Error: {
        PageDeleteForbidden: Error,
        PageDuplicateCreate: Error,
        PageEmptyContent: Error,
        PageIllegalPath: Error,
        PageMoveForbidden: Error,
        PageNotFound: Error,
        PagePathCollision: Error,
        PageUpdateForbidden: Error
      },
      auth: {
        checkAccess: vi.fn()
      },
      config: {
        dataPath: '/test/data',
        db: {
          type: 'sqlite'
        },
        lang: {
          code: 'en'
        }
      },
      data: {
        editors: [],
        reservedPaths: [],
        searchEngine: {
          created: vi.fn(),
          updated: vi.fn(),
          deleted: vi.fn(),
          renamed: vi.fn()
        }
      },
      events: {
        inbound: new EventEmitter(),
        outbound: new EventEmitter()
      },
      logger: {
        error: vi.fn(),
        warn: vi.fn()
      },
      models: {
        comments: {},
        knex: vi.fn(),
        pageHistory: {
          addVersion: vi.fn()
        },
        pages: {},
        storage: {
          pageEvent: vi.fn()
        },
        tags: {}
      },
      scheduler: {
        registerJob: vi.fn()
      }
    }
    Page = (await import('../../models/pages.ts')).default
  })

  afterEach(() => {
    if (originalWIKI === undefined) {
      delete global.WIKI
    } else {
      global.WIKI = originalWIKI
    }
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
