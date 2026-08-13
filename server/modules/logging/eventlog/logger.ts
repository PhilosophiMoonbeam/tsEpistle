import type { Logger } from 'winston'

// ------------------------------------
// Windows Event Log
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<Record<string, never>>): void {
    void logger
    void conf
  }
}

export default plugin
