declare module 'klaw' {
  import type { Stats } from 'node:fs'
  import type { Readable } from 'node:stream'

  export interface Item {
    path: string
    stats: Stats
  }

  export interface Options {
    filter?: (filePath: string) => boolean
    preserveSymlinks?: boolean
  }

  export default function klaw(root: string, options?: Options): Readable
}
