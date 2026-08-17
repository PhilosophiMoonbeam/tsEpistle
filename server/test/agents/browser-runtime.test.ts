import { describe, expect, it } from 'vitest'

import { IsolatedBrowserWorker } from '../../agents/browser/runtime.ts'

describe('isolated browser worker capacity', () => {
  it.each([0, 65, Number.POSITIVE_INFINITY, 1.5])('rejects an unsafe context capacity: %s', maximumContexts => {
    expect(() => new IsolatedBrowserWorker({ maximumContexts })).toThrow(expect.objectContaining({ code: 'INVALID_BROWSER_CAPACITY' }))
  })

  it('accepts the configured safe range without launching Chromium', () => {
    expect(() => new IsolatedBrowserWorker({ maximumContexts: 1 })).not.toThrow()
    expect(() => new IsolatedBrowserWorker({ maximumContexts: 64 })).not.toThrow()
  })
})
