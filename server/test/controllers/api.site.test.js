import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
const legacySecurity = vi.fn(), legacyGeneral = vi.fn(), patchFeatures = vi.fn(), editorAvailability = vi.fn()
const router = { get: vi.fn(), put: vi.fn(), post: vi.fn() }
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/security-administration.ts', import.meta.url, () => ({ legacySecurityKeys: ['securityTrustProxy', 'authAutoLogin'], patchLegacySecurityConfiguration: legacySecurity, getSecurityAdministrationStore: vi.fn() }))
vi.mockModule('../../operations/general-administration.ts', import.meta.url, () => ({ patchLegacyGeneralConfiguration: legacyGeneral, getGeneralAdministrationStore: vi.fn() }))
vi.mockModule('../../operations/discussion-settings.ts', import.meta.url, () => ({ patchSiteFeatures: patchFeatures }))
vi.mockModule('../../operations/editors.ts', import.meta.url, () => ({ updateEditorAvailability: editorAvailability }))
const response = () => { const res = { status: vi.fn(), json: vi.fn(), set: vi.fn() }; res.status.mockReturnValue(res); return res }
const load = async (verb, path = '/config') => { await vi.importFresh('../../controllers/api/site.ts', import.meta.url); return router[verb].mock.calls.find(([route]) => route === path)[1] }
beforeEach(() => {
  vi.resetModules()
  for (const method of [...Object.values(router), legacySecurity, legacyGeneral, patchFeatures, editorAvailability]) method.mockReset()
  legacySecurity.mockResolvedValue(undefined); legacyGeneral.mockResolvedValue(undefined); patchFeatures.mockResolvedValue(undefined); editorAvailability.mockResolvedValue(undefined)
  globalThis.WIKI = {
    auth: { checkAccess: vi.fn(() => true) },
    config: { host: 'https://wiki.example.com', title: 'Original', company: '', contentLicense: '', footerOverride: '', logoUrl: '/logo.svg', banner: { isEnabled: false, title: '', content: '' }, pageExtensions: ['md'], editors: { available: ['markdown'] }, seo: { description: 'Description', robots: ['index'], analyticsId: 'retained' }, features: { featurePageComments: true }, editShortcuts: { editFab: true }, auth: { audience: 'urn:wiki.js', tokenExpiration: '30m', tokenRenewal: '14d' }, security: { securityTrustProxy: false }, uploads: { maxFileSize: 5242880, maxFiles: 10 } }
  }
})
describe('site configuration transport ownership', () => {
  it('preserves flattened reads for existing REST and GraphQL consumers', async () => {
    const handler = await load('get'), res = response(); await handler({ user: {} }, res)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ title: 'Original', pageExtensions: 'md', description: 'Description', analyticsId: 'retained', editFab: true, authJwtAudience: 'urn:wiki.js', uploadMaxFileSize: 5242880 }))
  })
  it('requires system permission before reads and writes', async () => {
    const get = await load('get'), put = router.put.mock.calls.find(([path]) => path === '/config')[1]; globalThis.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const handler of [get, put]) { const res = response(); await handler({ user: {}, body: {} }, res); expect(res.status).toHaveBeenCalledWith(403) }
    expect(legacyGeneral).not.toHaveBeenCalled(); expect(legacySecurity).not.toHaveBeenCalled()
  })
  it('delegates General and Security writes with the exact authenticated actor and leaves runtime untouched', async () => {
    const handler = await load('put'), actor = { id: 1, authVersion: 3 }, general = { title: 'New name' }, security = { securityTrustProxy: true }
    await handler({ user: actor, body: general }, response()); await handler({ user: actor, body: security }, response())
    expect(legacyGeneral).toHaveBeenCalledWith(actor, general); expect(legacySecurity).toHaveBeenCalledWith(actor, security); expect(globalThis.WIKI.config.title).toBe('Original'); expect(globalThis.WIKI.config.security.securityTrustProxy).toBe(false)
  })
  it('rejects mixed feature/editor writes before changing another workspace', async () => {
    const handler = await load('put')
    for (const body of [{ availableEditors: ['markdown'], title: 'Other' }, { featurePageComments: false, title: 'Other' }, { featurePageComments: 'false' }, { availableEditors: ['unsupported'] }]) {
      const res = response(); await handler({ user: {}, body }, res); expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(editorAvailability).not.toHaveBeenCalled(); expect(patchFeatures).not.toHaveBeenCalled(); expect(legacyGeneral).not.toHaveBeenCalled()
  })
  it('retains explicit editor and discussion compatibility entry points', async () => {
    const handler = await load('put'); await handler({ user: {}, body: { availableEditors: ['markdown'] } }, response()); await handler({ user: {}, body: { featurePageComments: false } }, response())
    expect(editorAvailability).toHaveBeenCalledWith(['markdown']); expect(patchFeatures).toHaveBeenCalledWith({ featurePageComments: false })
  })
  it('rejects malformed payloads and preserves reviewed conflicts without exposing internal failures', async () => {
    const handler = await load('put')
    for (const body of [null, [], 'invalid']) { const res = response(); await handler({ user: {}, body }, res); expect(res.status).toHaveBeenCalledWith(400) }
    legacyGeneral.mockRejectedValue(Object.assign(new Error('Reload General settings'), { status: 409 })); let res = response(); await handler({ user: {}, body: { title: 'Next' } }, res); expect(res.status).toHaveBeenCalledWith(409); expect(res.json).toHaveBeenCalledWith({ error: 'Reload General settings' })
    legacyGeneral.mockRejectedValue(new Error('private database credentials')); res = response(); await handler({ user: {}, body: { title: 'Next' } }, res); expect(res.status).toHaveBeenCalledWith(500); expect(res.json).toHaveBeenCalledWith({ error: 'Site configuration update failed' })
  })
})
