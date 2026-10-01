import { describe, expect, it } from '../bun-test.mts'

import { IsolatedBrowserWorker, type BrowserWorkerRequest } from '../../agents/browser/runtime.ts'

describe('isolated browser worker capacity', () => {
  it.each([0, 65, Number.POSITIVE_INFINITY, 1.5])('rejects an unsafe context capacity: %s', maximumContexts => {
    expect(() => new IsolatedBrowserWorker({ maximumContexts })).toThrow(expect.objectContaining({ code: 'INVALID_BROWSER_CAPACITY' }))
  })

  it.each([1, 64])('handles a missing context at safe capacity %s without launching Chromium', async maximumContexts => {
    const worker = new IsolatedBrowserWorker({ maximumContexts })
    const request: BrowserWorkerRequest = {
      contextId: 'browser-context-0001',
      actionCallId: 'browser-action-0001',
      sequence: 1,
      action: { kind: 'observe' },
      limits: {
        contextTtlMilliseconds: 60_000,
        maximumActions: 10,
        maximumNavigations: 2,
        maximumResponseBytes: 1_000_000
      }
    }
    await expect(worker.execute(request)).rejects.toMatchObject({ code: 'CONTEXT_LOST', status: 404 })
  })
})
