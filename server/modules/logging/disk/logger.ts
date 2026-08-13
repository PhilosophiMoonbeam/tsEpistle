import type { Logger } from 'winston'

// ------------------------------------
// Disk
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<Record<string, never>>): void {
    void logger
    void conf
  }
}

export default plugin
