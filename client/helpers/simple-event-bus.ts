type EventHandler = (...args: unknown[]) => void

type EventHandlers = Record<string, EventHandler[] | undefined>

export interface SimpleEventBus {
  emit(eventName: string, ...args: unknown[]): void
  on(eventName: string, handler?: EventHandler): void
  off(eventName: string, handler?: EventHandler): void
}

export function createEventBus (): SimpleEventBus {
  const handlers: EventHandlers = Object.create(null)

  return {
    emit (eventName: string, ...args: unknown[]): void {
      const listeners = handlers[eventName]
      if (!listeners) {
        return
      }

      listeners.slice().forEach(listener => {
        listener(...args)
      })
    },

    on (eventName: string, handler?: EventHandler): void {
      if (typeof handler !== 'function') {
        return
      }

      if (!handlers[eventName]) {
        handlers[eventName] = []
      }

      handlers[eventName].push(handler)
    },

    off (eventName: string, handler?: EventHandler): void {
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
