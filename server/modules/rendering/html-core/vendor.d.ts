declare module 'uslug' {
  interface UslugOptions {
    allowedChars?: string
    lower?: boolean
  }

  function uslug (value: string, options?: UslugOptions): string

  export default uslug
}
