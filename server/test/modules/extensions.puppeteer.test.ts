import { describe, expect, it } from '../bun-test.mts'
import extension from '../../modules/extensions/puppeteer/ext.ts'

describe('legacy Puppeteer extension boundary', () => {
  it('does not mistake another executable for an application-process browser renderer', async () => {
    await expect(extension.observe()).resolves.toEqual({
      state: 'not-provided',
      compatibility: 'not-applicable',
      evidence: 'No Puppeteer package or browser executable is inspected from the application process.'
    })
    expect(extension.installation.boundary).toBe('separate-image')
  })
})
