type ReadyCallback = {
  event: string
  callback: () => void
  once: boolean
  called: boolean
}

const readyStates: string[] = []
const callbacks: ReadyCallback[] = []

const boot = {
  readyStates,
  callbacks,
  isReady (event: string): boolean {
    return readyStates.includes(event)
  },
  register (event: string, callback: () => void, once = false): void {
    if (this.isReady(event)) {
      callback()
      return
    }
    callbacks.push({ event, callback, once, called: false })
  },
  registerOnce (event: string, callback: () => void): void {
    this.register(event, callback, true)
  },
  notify (event: string): void {
    readyStates.push(event)
    for (const entry of callbacks) {
      if (entry.event !== event || (entry.once && entry.called)) continue
      entry.called = true
      entry.callback()
    }
  },
  onDOMReady (callback: () => void): void {
    if (document.readyState === 'interactive' || document.readyState === 'complete') callback()
    else document.addEventListener('DOMContentLoaded', callback, { once: true })
  }
}

export default boot
