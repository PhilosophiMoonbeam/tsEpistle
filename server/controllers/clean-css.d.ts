declare module 'clean-css' {
  interface CleanCssOptions {
    format?: string
    inline?: false | string | string[]
  }

  interface MinifyOutput {
    styles: string
  }

  export default class CleanCSS {
    constructor(options?: CleanCssOptions)
    minify(source: string): MinifyOutput
  }
}
