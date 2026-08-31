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
          type: 'postgres'
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
    Page = (await vi.importFresh('../../models/pages.ts', import.meta.url)).default
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

  it('marks only an own human metadata update as replacement and preserves CAS inputs', async () => {
    const requester = { id: 7, permissions: ['manage:system'] }
    const updatePage = vi.fn(input => input)
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.pages = {
      getPageFromDb: vi.fn().mockResolvedValue({
        id: 17,
        localeCode: 'en',
        ownerId: null,
        path: 'concept',
        visibility: 'public'
      }),
      updatePage
    }
    const operations = (await vi.importFresh('../../operations/pages.ts', import.meta.url)).default
    const expectedUpdatedAt = '2026-08-31T12:00:00.000Z'
    const expectedSourceRevision = '41'

    await operations.update({
      requester,
      input: {
        id: 17,
        okfMetadata: { type: 'Reference', title: 'Replacement' },
        replaceOkfMetadata: false,
        expectedUpdatedAt,
        expectedSourceRevision
      }
    })
    expect(updatePage).toHaveBeenLastCalledWith({
      id: 17,
      okfMetadata: { type: 'Reference', title: 'Replacement' },
      replaceOkfMetadata: true,
      expectedUpdatedAt,
      expectedSourceRevision,
      user: requester
    })

    await operations.update({
      requester,
      input: {
        id: 17,
        title: 'Ordinary update',
        replaceOkfMetadata: true,
        expectedUpdatedAt,
        expectedSourceRevision
      }
    })
    expect(updatePage).toHaveBeenLastCalledWith({
      id: 17,
      title: 'Ordinary update',
      expectedUpdatedAt,
      expectedSourceRevision,
      user: requester
    })

    const inheritedMetadata = Object.assign(Object.create({ okfMetadata: { type: 'Metric' } }), { id: 17, title: 'Inherited metadata ignored' })
    await operations.update({ requester, input: inheritedMetadata })
    expect(updatePage).toHaveBeenLastCalledWith({
      id: 17,
      title: 'Inherited metadata ignored',
      user: requester
    })
  })
})
