import type { Logger } from 'winston'

// ------------------------------------
// Logstash
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<Record<string, never>>): void {
    void logger
    void conf
  }
}

export default plugin
