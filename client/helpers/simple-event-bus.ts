type EventHandler<Args extends unknown[]> = (...args: Args) => void

type EventHandlers<Args extends unknown[]> = Record<string, Array<EventHandler<Args>> | undefined>

export interface SimpleEventBus<Args extends unknown[]> {
  emit(eventName: string, ...args: Args): void
  on(eventName: string, handler?: EventHandler<Args>): void
  off(eventName: string, handler?: EventHandler<Args>): void
}

export function createEventBus<Args extends unknown[]> (): SimpleEventBus<Args> {
  const handlers: EventHandlers<Args> = Object.create(null)

  return {
    emit (eventName: string, ...args: Args): void {
      const listeners = handlers[eventName]
      if (!listeners) {
        return
      }

      listeners.slice().forEach(listener => {
        listener(...args)
      })
    },

    on (eventName: string, handler?: EventHandler<Args>): void {
      if (typeof handler !== 'function') {
        return
      }

      if (!handlers[eventName]) {
        handlers[eventName] = []
      }

      handlers[eventName].push(handler)
    },

    off (eventName: string, handler?: EventHandler<Args>): void {
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
