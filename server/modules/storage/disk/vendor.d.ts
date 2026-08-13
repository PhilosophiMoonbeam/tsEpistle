declare module 'mime-types' {
  interface MimeTypes {
    lookup(filePath: string): string | false
  }

  const mimeTypes: MimeTypes
  export default mimeTypes
}

declare module 'tar-fs' {
  import type { Readable } from 'node:stream'

  interface PackOptions {
    ignore?: (filePath: string) => boolean
  }

  interface TarFs {
    pack(directory: string, options?: PackOptions): Readable
  }

  const tar: TarFs
  export default tar
}
