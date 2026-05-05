type RootStore = {
  commit: (type: string, payload?: any) => void
  getters?: {
    isLoading?: any
  }
  state?: {
    notification?: any
  }
}

export function loadingStart (store: RootStore, stackName: any): void {
  store.commit('loadingStart', stackName)
}

export function loadingStop (store: RootStore, stackName: any): void {
  store.commit('loadingStop', stackName)
}

export function setLoading (store: RootStore, stackName: any, isLoading: any): void {
  store.commit(isLoading ? 'loadingStart' : 'loadingStop', stackName)
}

export function showNotification (store: RootStore, opts: any): void {
  store.commit('showNotification', opts)
}

export function updateNotificationState (store: RootStore, isActive: any): void {
  store.commit('updateNotificationState', isActive)
}

export function pushGraphError (store: RootStore, err: any): void {
  store.commit('pushGraphError', err)
}

export function isLoading (store: RootStore): boolean {
  return Boolean(store.getters && store.getters.isLoading)
}

export function getNotification (store: RootStore): any {
  return store.state && store.state.notification
}
