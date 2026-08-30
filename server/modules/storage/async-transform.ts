import { Transform } from 'node:stream'

export const asyncObjectTransform = (handler: (value: unknown) => Promise<void>): Transform =>
  new Transform({
    objectMode: true,
    transform(value: unknown, _encoding: BufferEncoding, callback) {
      void Promise.resolve()
        .then(() => handler(value))
        .then(
          () => callback(),
          error => callback(error instanceof Error ? error : new Error(String(error)))
        )
    }
  })
