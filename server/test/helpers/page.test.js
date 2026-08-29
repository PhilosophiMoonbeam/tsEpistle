const originalWIKI = global.WIKI

let generateHash
let injectPageMetadata

beforeEach(async () => {
  vi.resetModules()
  global.WIKI = {
    config: {
      lang: {
        code: 'en'
      }
    },
    data: {
      reservedPaths: []
    }
  }
  ;({ generateHash, injectPageMetadata } = (await vi.importFresh('../../helpers/page.ts', import.meta.url)).default)
})

afterEach(() => {
  if (originalWIKI === undefined) {
    delete global.WIKI
  } else {
    global.WIKI = originalWIKI
  }
})

describe('helpers/page/generateHash', () => {
  it('isolates public and owner-scoped private cache identities', () => {
    const publicHash = generateHash({ locale: 'en', path: 'same/path', visibility: 'public', ownerId: null })
    const ownerHash = generateHash({ locale: 'en', path: 'same/path', visibility: 'private', ownerId: 7 })
    const otherOwnerHash = generateHash({ locale: 'en', path: 'same/path', visibility: 'private', ownerId: 8 })

    expect(ownerHash).not.toBe(publicHash)
    expect(otherOwnerHash).not.toBe(publicHash)
    expect(otherOwnerHash).not.toBe(ownerHash)
    expect(publicHash).toBe('198d623850ff30a22fc765860bec70b60093183b')
  })
})

describe('helpers/page/injectPageMetadata', () => {
  const page = {
    title: 'PAGE TITLE',
    description: 'A PAGE',
    isPublished: true,
    updatedAt: new Date(),
    content: 'TEST CONTENT',
    createdAt: new Date('2019-01-01')
  }

  it('returns the page content by default when content type is unknown', () => {
    const expected = 'TEST CONTENT'
    const result = injectPageMetadata(page)
    expect(result).toEqual(expected)
  })

  it('injects metadata for markdown contents', () => {
    const markdownPage = {
      ...page,
      contentType: 'markdown',
      editorKey: 'markdown'
    }

    const expected = `---
title: ${markdownPage.title}
description: ${markdownPage.description}
published: ${markdownPage.isPublished.toString()}
date: ${markdownPage.updatedAt}
tags:\x20
editor: ${markdownPage.editorKey}
dateCreated: ${markdownPage.createdAt}\n---

TEST CONTENT`

    const result = injectPageMetadata(markdownPage)
    expect(result).toEqual(expected)
  })

  it('injects metadata for html contents', () => {
    const htmlPage = {
      ...page,
      contentType: 'html',
      editorKey: 'html'
    }

    const expected = `<!--
title: ${htmlPage.title}
description: ${htmlPage.description}
published: ${htmlPage.isPublished.toString()}
date: ${htmlPage.updatedAt}
tags:\x20
editor: ${htmlPage.editorKey}
dateCreated: ${htmlPage.createdAt}\n-->

TEST CONTENT`

    const result = injectPageMetadata(htmlPage)
    expect(result).toEqual(expected)
  })
})
