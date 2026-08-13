declare module 'bcryptjs-then' {
  interface Bcrypt {
    hash(password: string, salt?: number | string): Promise<string>
    compare(expected: string, hash: string): Promise<boolean>
  }

  const bcrypt: Bcrypt
  export default bcrypt
}

declare module 'node-2fa' {
  interface SecretOptions {
    name?: string
    account?: string
  }

  interface Secret {
    secret: string
    uri: string
    qr: string
  }

  interface Token {
    token: string
  }

  interface Verification {
    delta: number
  }

  interface TwoFactor {
    generateSecret(options?: SecretOptions): Secret
    generateToken(secret: string | null | undefined): Token | null
    verifyToken(secret: string | null | undefined, token: string | null | undefined, window?: number): Verification | null
  }

  const twoFactor: TwoFactor
  export default twoFactor
}

declare module 'qr-image' {
  interface SvgOptions {
    type: 'svg'
    ec_level?: 'L' | 'M' | 'Q' | 'H'
    size?: number
    margin?: number
    parse_url?: boolean
  }

  interface QrImage {
    imageSync(text: string, options: SvgOptions): string
  }

  const qrImage: QrImage
  export default qrImage
}

declare module 'js-binary' {
  type BinaryScalarType =
    | 'uint'
    | 'int'
    | 'float'
    | 'string'
    | 'Buffer'
    | 'boolean'
    | 'json'
    | 'oid'
    | 'regex'
    | 'date'

  type BinaryFormat = BinaryScalarType | readonly [BinaryFormat] | { readonly [field: string]: BinaryFormat }

  export class Type<Value> {
    constructor(format: BinaryFormat)
    encode(value: Value): Buffer
    decode(buffer: Buffer): Value
    getHash(): Buffer
  }
}

declare module 'he' {
  interface DecodeOptions {
    isAttributeValue?: boolean
    strict?: boolean
  }

  interface He {
    decode(value: string, options?: DecodeOptions): string
  }

  const he: He
  export default he
}

declare module 'turndown' {
  interface TurndownOptions {
    bulletListMarker?: '-' | '+' | '*'
    codeBlockStyle?: 'indented' | 'fenced'
    emDelimiter?: '_' | '*'
    fence?: string
    headingStyle?: 'setext' | 'atx'
    hr?: string
    linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut'
    linkStyle?: 'inlined' | 'referenced'
    preformattedCode?: boolean
    strongDelimiter?: '__' | '**'
  }

  interface TurndownClassList {
    contains(token: string): boolean
  }

  interface TurndownNode {
    readonly nodeName: string
    readonly classList: TurndownClassList
    getAttribute(name: string): string | null
  }

  type FilterFunction = (node: TurndownNode, options: TurndownOptions) => boolean
  type Filter = string | readonly string[] | FilterFunction
  type ReplacementFunction = (content: string, node: TurndownNode, options: TurndownOptions) => string

  interface Rule {
    filter: Filter
    replacement: ReplacementFunction
  }

  type Plugin = (service: TurndownService) => void

  export default class TurndownService {
    constructor(options?: TurndownOptions)
    use(plugin: Plugin | readonly Plugin[]): this
    keep(filter: Filter): this
    addRule(key: string, rule: Rule): this
    turndown(input: string): string
  }
}

declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  type TurndownPlugin = (service: TurndownService) => void

  export const gfm: TurndownPlugin
  export const highlightedCodeBlock: TurndownPlugin
  export const strikethrough: TurndownPlugin
  export const tables: TurndownPlugin
  export const taskListItems: TurndownPlugin
}
