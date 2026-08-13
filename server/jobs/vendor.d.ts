declare module 'jsdom' {
  import type { WindowLike } from 'dompurify'

  export class JSDOM {
    constructor(html?: string)
    readonly window: WindowLike
  }

  const jsdom: { JSDOM: typeof JSDOM }
  export default jsdom
}
