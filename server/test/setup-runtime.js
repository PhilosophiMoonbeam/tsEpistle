import { vi } from 'vitest'

vi.mock('../controllers/_types.ts', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    getTransportRuntime: () => globalThis.WIKI,
    getWikiAuth: () => globalThis.WIKI.auth
  }
})
