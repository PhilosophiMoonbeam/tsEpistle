import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import {
  confirmDiscard,
  currentConfirmation,
  registerConfirmationHost,
  requestConfirmation,
  settleConfirmation
} from './confirm-dialog.ts'

const unregisters: Array<() => void> = []
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister()
  vi.restoreAllMocks()
  resetBody()
})

const mountHost = () => {
  const unregister = registerConfirmationHost()
  unregisters.push(unregister)
  return unregister
}

describe('shared confirmation dialog', () => {
  test('without a mounted host, falls back to the native dialog so a draft is never dropped silently', async () => {
    const confirm = vi.spyOn(browserWindow, 'confirm').mockReturnValue(false)

    await expect(confirmDiscard('Discard unsaved theme changes?', 'Colors return to the saved palette.')).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith('Discard unsaved theme changes?\n\nColors return to the saved palette.')
    expect(currentConfirmation()).toBeNull()
  })

  test('queues concurrent requests and resolves each with its own answer', async () => {
    const confirm = vi.spyOn(browserWindow, 'confirm')
    mountHost()

    const first = requestConfirmation({ title: 'Leave this access review?' })
    const second = confirmDiscard('Discard unsaved publication changes?')

    const shown = currentConfirmation()
    expect(shown?.title).toBe('Leave this access review?')
    expect(shown?.tone).toBeUndefined()
    settleConfirmation(shown!.id, true)
    await expect(first).resolves.toBe(true)

    const next = currentConfirmation()
    expect(next?.title).toBe('Discard unsaved publication changes?')
    expect(next?.tone).toBe('destructive')
    settleConfirmation(next!.id, false)
    await expect(second).resolves.toBe(false)

    expect(currentConfirmation()).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })

  test('ignores stale answers and keeps the visible request', async () => {
    mountHost()
    const pending = confirmDiscard('Discard the new group draft?')
    const shown = currentConfirmation()!

    settleConfirmation(shown.id + 100, true)
    expect(currentConfirmation()?.id).toBe(shown.id)

    settleConfirmation(shown.id, false)
    settleConfirmation(shown.id, true)
    await expect(pending).resolves.toBe(false)
  })

  test('unmounting the last host cancels pending requests instead of leaving guards waiting', async () => {
    const unregisterFirst = mountHost()
    const unregisterSecond = mountHost()
    const pending = confirmDiscard('Discard unsaved navigation changes?')

    unregisterFirst()
    expect(currentConfirmation()?.title).toBe('Discard unsaved navigation changes?')
    unregisterSecond()
    unregisterSecond()

    await expect(pending).resolves.toBe(false)
    expect(currentConfirmation()).toBeNull()
  })
})
