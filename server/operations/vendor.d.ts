declare module 'getos' {
  interface OperatingSystemInfo {
    os: string
    dist?: string
    codename?: string
    release?: string
  }

  type Callback = (error: Error | null, info: OperatingSystemInfo) => void

  export default function getos(callback: Callback): void
}

declare module 'clean-css' {
  interface Options {
    format?: string
    inline?: boolean
  }

  interface Output {
    styles: string
  }

  export default class CleanCSS {
    constructor(options?: Options)
    minify(source: string): Output
  }
}

declare module 'mongodb' {
  interface MongoClientOptions {
    appName?: string
  }

  interface MongoCursor<TDocument extends object> {
    hasNext(): Promise<boolean>
    next(): Promise<TDocument | null>
  }

  interface MongoCollection<TDocument extends object> {
    find(filter?: object): MongoCursor<TDocument>
  }

  interface MongoDatabase {
    collection<TDocument extends object = Record<string, unknown>>(name: string): MongoCollection<TDocument>
  }

  export class MongoClient {
    static connect(url: string, options?: MongoClientOptions): Promise<MongoClient>
    db(name?: string): MongoDatabase
    close(force?: boolean): Promise<void>
  }
}
