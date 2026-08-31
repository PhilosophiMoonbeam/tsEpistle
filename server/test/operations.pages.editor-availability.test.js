describe('page creation editor availability', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const arrange = async available => {
    const createPage = vi.fn(input => input)
    global.WIKI = {
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      config: {
        db: { type: 'postgres' },
        editors: { available },
        lang: { code: 'en' }
      },
      data: {},
      Error: {},
      models: {
        knex: {},
        pages: { createPage },
        tags: {},
        pageHistory: {}
      }
    }
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    return { operations, createPage }
  }

  it('rejects a configurable editor hidden by an administrator', async () => {
    const { operations, createPage } = await arrange(['markdown'])

    expect(() => operations.create({
      requester: { id: 7 },
      input: { editor: 'code', path: 'restricted', locale: 'en' }
    })).toThrow('The selected editor is not available for new pages.')
    expect(createPage).not.toHaveBeenCalled()
  })

  it('creates pages with an available editor', async () => {
    const { operations, createPage } = await arrange(['markdown'])
    const requester = { id: 7 }

    expect(operations.create({
      requester,
      input: { editor: 'markdown', path: 'allowed', locale: 'en' }
    })).toEqual(expect.objectContaining({
      editor: 'markdown',
      visibility: 'public',
      user: requester
    }))
    expect(createPage).toHaveBeenCalledOnce()
  })
  it.each(['ckeditor', 'asciidoc', 'code'])('creates pages when %s is explicitly enabled', async editor => {
    const { operations, createPage } = await arrange([editor])

    expect(operations.create({
      requester: { id: 7 },
      input: { editor, path: `${editor}-page`, locale: 'en' }
    })).toEqual(expect.objectContaining({
      editor,
      visibility: 'public'
    }))
    expect(createPage).toHaveBeenCalledOnce()
  })


  it('does not apply chooser restrictions to internal editor types', async () => {
    const { operations, createPage } = await arrange(['markdown'])

    expect(operations.create({
      requester: { id: 7 },
      input: { editor: 'api', path: 'api-reference', locale: 'en' }
    })).toEqual(expect.objectContaining({ editor: 'api' }))
    expect(createPage).toHaveBeenCalledOnce()
  })
})
