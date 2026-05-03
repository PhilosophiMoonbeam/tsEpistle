function createEventBus () {
  const handlers = Object.create(null)

  return {
    emit (eventName, ...args) {
      const listeners = handlers[eventName]
      if (!listeners) {
        return
      }

      listeners.slice().forEach(listener => {
        listener(...args)
      })
    },

    on (eventName, handler) {
      if (typeof handler !== 'function') {
        return
      }

      if (!handlers[eventName]) {
        handlers[eventName] = []
      }

      handlers[eventName].push(handler)
    },

    off (eventName, handler) {
      if (!handler) {
        return
      }

      const listeners = handlers[eventName]
      if (!listeners) {
        return
      }

      const idx = listeners.indexOf(handler)
      if (idx === -1) {
        return
      }

      listeners.splice(idx, 1)

      if (listeners.length < 1) {
        delete handlers[eventName]
      }
    }
  }
}

module.exports = {
  createEventBus
}
