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
