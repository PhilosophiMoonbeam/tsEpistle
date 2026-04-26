function loadingStart (store, stackName) {
  store.commit('loadingStart', stackName)
}

function loadingStop (store, stackName) {
  store.commit('loadingStop', stackName)
}

function setLoading (store, stackName, isLoading) {
  store.commit(isLoading ? 'loadingStart' : 'loadingStop', stackName)
}

function showNotification (store, opts) {
  store.commit('showNotification', opts)
}

function updateNotificationState (store, isActive) {
  store.commit('updateNotificationState', isActive)
}

function pushGraphError (store, err) {
  store.commit('pushGraphError', err)
}

function isLoading (store) {
  return Boolean(store.getters && store.getters.isLoading)
}

function getNotification (store) {
  return store.state && store.state.notification
}

module.exports = {
  loadingStart,
  loadingStop,
  setLoading,
  showNotification,
  updateNotificationState,
  pushGraphError,
  isLoading,
  getNotification
}
