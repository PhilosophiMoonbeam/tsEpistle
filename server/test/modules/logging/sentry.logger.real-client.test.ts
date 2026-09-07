import { describe, expect, it } from '../../bun-test.mts'
import { SentryLogger } from '../../../modules/logging/sentry/logger.ts'

describe('SentryLogger Node client', () => {
  it('constructs and disposes a configured Node client', async () => {
    const transport = new SentryLogger({ key: 'https://public@example.test/1' })

    await expect(transport.dispose()).resolves.toBeUndefined()
  })
})
