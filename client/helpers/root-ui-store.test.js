const rootUiStore = require('./root-ui-store')

describe('root UI store facade', () => {
  const createStore = (overrides = {}) => ({
    commit: jest.fn(),
    getters: {},
    state: {},
    ...overrides
  })

  test('loadingStart commits the existing root mutation', () => {
    const store = createStore()

    rootUiStore.loadingStart(store, 'example')

    expect(store.commit).toHaveBeenCalledWith('loadingStart', 'example')
  })

  test('loadingStop commits the existing root mutation', () => {
    const store = createStore()

    rootUiStore.loadingStop(store, 'example')

    expect(store.commit).toHaveBeenCalledWith('loadingStop', 'example')
  })

  test('setLoading routes true to loadingStart and false to loadingStop', () => {
    const store = createStore()

    rootUiStore.setLoading(store, 'watcher', true)
    rootUiStore.setLoading(store, 'watcher', false)

    expect(store.commit).toHaveBeenNthCalledWith(1, 'loadingStart', 'watcher')
    expect(store.commit).toHaveBeenNthCalledWith(2, 'loadingStop', 'watcher')
  })

  test('showNotification passes the payload through unchanged', () => {
    const store = createStore()
    const payload = { style: 'red', message: 'Failed', icon: 'alert' }

    rootUiStore.showNotification(store, payload)

    expect(store.commit).toHaveBeenCalledWith('showNotification', payload)
  })

  test('updateNotificationState commits active state', () => {
    const store = createStore()

    rootUiStore.updateNotificationState(store, false)
    rootUiStore.updateNotificationState(store, true)

    expect(store.commit).toHaveBeenNthCalledWith(1, 'updateNotificationState', false)
    expect(store.commit).toHaveBeenNthCalledWith(2, 'updateNotificationState', true)
  })

  test('pushGraphError delegates existing mutation behavior', () => {
    const store = createStore()
    const err = new Error('Broken')

    rootUiStore.pushGraphError(store, err)

    expect(store.commit).toHaveBeenCalledWith('pushGraphError', err)
  })

  test('isLoading reads the root getter safely', () => {
    expect(rootUiStore.isLoading(createStore({ getters: { isLoading: true } }))).toBe(true)
    expect(rootUiStore.isLoading(createStore({ getters: { isLoading: false } }))).toBe(false)
    expect(rootUiStore.isLoading(createStore({ getters: {} }))).toBe(false)
    expect(rootUiStore.isLoading(createStore({ getters: null }))).toBe(false)
  })

  test('getNotification returns current notification state', () => {
    const notification = { message: 'Hi', style: 'primary', icon: 'cached', isActive: true }
    const store = createStore({ state: { notification } })

    expect(rootUiStore.getNotification(store)).toBe(notification)
  })
})
