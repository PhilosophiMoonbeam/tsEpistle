const originalWIKI = global.WIKI

const makePageQuery = rows => {
  const scopedWhere = vi.fn()
  const scopedOrWhere = vi.fn()
  const filter = {
    where: scopedWhere,
    orWhere: scopedOrWhere
  }
  const query = {
    column: vi.fn().mockReturnThis(),
    where: vi.fn(argument => {
      if (typeof argument === 'function') argument(filter)
      return query
    }),
    then: resolve => Promise.resolve(rows).then(resolve)
  }
  return { query, scopedWhere, scopedOrWhere }
}

describe('HTML renderer private-link isolation', () => {
  afterEach(() => {
    vi.resetModules()
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  const render = async ({ visibility, ownerId }) => {
    const pageQuery = makePageQuery([{ id: 9, localeCode: 'en', path: 'secret' }])
    const insert = vi.fn().mockResolvedValue(undefined)
    global.WIKI = {
      auth: { checkAccess: vi.fn().mockReturnValue(false) },
      config: {
        db: { type: 'postgres' },
        host: 'http://wiki.example.test',
        lang: { code: 'en', namespacing: true }
      },
      logger: { warn: vi.fn() },
      models: {
        pages: { query: vi.fn().mockReturnValue(pageQuery.query) },
        pageLinks: { query: vi.fn().mockReturnValue({ insert }) }
      }
    }
    const plugin = (await import('../modules/rendering/html-core/renderer.ts')).default
    const html = await plugin.render.call({
      children: [],
      config: { absoluteLinks: false, openExternalLinkNewTab: false, relAttributeExternalLink: '' },
      input: '<a href="/en/secret">Secret</a>',
      page: {
        id: 1,
        localeCode: 'en',
        path: 'home',
        visibility,
        ownerId,
        $relatedQuery: vi.fn().mockResolvedValue([])
      }
    })
    return { html, ...pageQuery }
  }

  it('resolves links from public pages against public destinations only', async () => {
    const result = await render({ visibility: 'public', ownerId: null })

    expect(result.scopedWhere).toHaveBeenCalledWith('visibility', 'public')
    expect(result.scopedOrWhere).not.toHaveBeenCalled()
    expect(result.html).toContain('is-valid-page')
  })

  it('allows private pages to resolve only public and same-owner private destinations', async () => {
    const result = await render({ visibility: 'private', ownerId: 7 })

    expect(result.scopedWhere).toHaveBeenCalledWith('visibility', 'public')
    expect(result.scopedOrWhere).toHaveBeenCalledWith({ visibility: 'private', ownerId: 7 })
  })
})
