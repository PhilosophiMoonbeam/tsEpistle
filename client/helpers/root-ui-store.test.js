import { describe, expect, test, vi } from 'vitest'

import * as rootUiStore from './root-ui-store.ts'

describe('root UI store facade', () => {
  const createStore = (overrides = {}) => ({
    startLoading: vi.fn(),
    stopLoading: vi.fn(),
    showNotification: vi.fn(),
    setNotificationActive: vi.fn(),
    showError: vi.fn(),
    isLoading: false,
    notification: null,
    ...overrides
  })

  test('loadingStart delegates to the root store action', () => {
    const store = createStore()

    rootUiStore.loadingStart(store, 'example')

    expect(store.startLoading).toHaveBeenCalledWith('example')
  })

  test('loadingStop delegates to the root store action', () => {
    const store = createStore()

    rootUiStore.loadingStop(store, 'example')

    expect(store.stopLoading).toHaveBeenCalledWith('example')
  })

  test('setLoading routes true to startLoading and false to stopLoading', () => {
    const store = createStore()

    rootUiStore.setLoading(store, 'watcher', true)
    rootUiStore.setLoading(store, 'watcher', false)

    expect(store.startLoading).toHaveBeenCalledWith('watcher')
    expect(store.stopLoading).toHaveBeenCalledWith('watcher')
  })

  test('showNotification passes the payload through unchanged', () => {
    const store = createStore()
    const payload = { style: 'red', message: 'Failed', icon: 'alert' }

    rootUiStore.showNotification(store, payload)

    expect(store.showNotification).toHaveBeenCalledWith(payload)
  })

  test('updateNotificationState delegates active state to the root store', () => {
    const store = createStore()

    rootUiStore.updateNotificationState(store, false)
    rootUiStore.updateNotificationState(store, true)

    expect(store.setNotificationActive).toHaveBeenNthCalledWith(1, false)
    expect(store.setNotificationActive).toHaveBeenNthCalledWith(2, true)
  })

  test('pushGraphError delegates existing root store behavior', () => {
    const store = createStore()
    const err = new Error('Broken')

    rootUiStore.pushGraphError(store, err)

    expect(store.showError).toHaveBeenCalledWith(err)
  })

  test('isLoading reads the root store getter', () => {
    expect(rootUiStore.isLoading(createStore({ isLoading: true }))).toBe(true)
    expect(rootUiStore.isLoading(createStore({ isLoading: false }))).toBe(false)
  })

  test('getNotification returns current notification state', () => {
    const notification = { message: 'Hi', style: 'primary', icon: 'cached', isActive: true }
    const store = createStore({ notification })

    expect(rootUiStore.getNotification(store)).toBe(notification)
  })
})
