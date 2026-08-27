declare module 'chromium-pickle-js' {
  interface PickleIterator {
    readString(): string
    readUInt32(): number
  }

  interface Pickle {
    createIterator(): PickleIterator
  }

  interface ChromiumPickle {
    createFromBuffer(buffer: Buffer): Pickle
  }

  const pickle: ChromiumPickle
  export default pickle
}

declare module 'cuint' {
  export interface UInt64 {
    readonly remainder: UInt64 | null
  }

  export function UINT64(value: number | string, radix?: number): UInt64
}

declare module 'js-yaml' {
  export type Schema = object

  export interface LoadOptions {
    readonly json?: boolean
    readonly schema?: Schema
    readonly maxDepth?: number
    readonly maxMergeSeqLength?: number
  }
  export interface DumpOptions {
    readonly schema?: Schema
    readonly noRefs?: boolean
    readonly lineWidth?: number
    readonly sortKeys?: boolean | ((left: unknown, right: unknown) => number)
  }

  export const JSON_SCHEMA: Schema
  export function load(input: string, options?: LoadOptions): unknown
  export function dump(input: unknown, options?: DumpOptions): string

  interface JsYaml {
    load(input: string, options?: LoadOptions): unknown
    dump(input: unknown, options?: DumpOptions): string
  }

  const yaml: JsYaml
  export default yaml
}

declare module '@root/keypairs' {
  export interface RootJwk {
    kty: 'EC' | 'RSA'
    alg?: string
    crv?: string
    d?: string
    e?: string
    ext?: boolean
    key_ops?: string[]
    kid?: string
    n?: string
    use?: string
    x?: string
    y?: string
  }

  export interface RootKeypair {
    private: RootJwk
    public: RootJwk
  }

  interface GenerateOptions {
    format?: 'jwk'
    kty?: RootJwk['kty']
  }

  interface ExportOptions {
    format?: 'pkcs8' | 'pkcs1' | 'sec1' | 'spki'
    jwk: RootJwk
  }

  interface KeypairsApi {
    export(options: ExportOptions): Promise<string>
    generate(options?: GenerateOptions): Promise<RootKeypair>
    import(options: { pem: string }): Promise<RootJwk>
  }

  const keypairs: KeypairsApi
  export default keypairs
}

declare module '@root/csr' {
  import type { RootJwk } from '@root/keypairs'

  interface CsrApi {
    csr(options: { domains: string[]; encoding: 'der'; jwk: RootJwk }): Promise<Uint8Array>
  }

  const csr: CsrApi
  export default csr
}

declare module '@root/pem' {
  interface PemApi {
    packBlock(options: { bytes: Uint8Array; type: string }): string
  }

  const pem: PemApi
  export default pem
}

declare module 'acme' {
  import type { RootJwk } from '@root/keypairs'

  export interface AcmeAccount {
    contact?: string[]
    key?: { kid?: string }
    status?: string
  }

  export interface AcmeCertificate {
    cert: string
    chain: string
    expires: string
    identifiers: Array<{ type: string; value: string }>
  }

  export interface AcmeChallenge {
    altname: string
    hostname: string
    keyAuthorization?: string
    status?: string
    token: string
    type: string
    url: string
  }

  export interface AcmeChallengeRequest {
    challenge: AcmeChallenge
  }

  interface AcmeChallengeHandler {
    get?(request: AcmeChallengeRequest): AcmeChallenge | null | undefined | Promise<AcmeChallenge | null | undefined>
    init?(): void | Promise<void>
    remove(request: AcmeChallengeRequest): Promise<null>
    set(request: AcmeChallengeRequest): null | Promise<null>
  }

  export interface AcmeClient {
    accounts: {
      create(options: { accountKey: RootJwk; agreeToTerms: true; subscriberEmail: string }): Promise<AcmeAccount>
    }
    certificates: {
      create(options: {
        account: AcmeAccount
        accountKey: RootJwk
        challenges: { 'http-01': AcmeChallengeHandler }
        csr: string
        domains: string[]
      }): Promise<AcmeCertificate>
    }
    init(directoryUrl: string): Promise<object>
  }

  interface AcmeApi {
    create(options: {
      maintainerEmail: string
      notify(event: string, message: unknown): void
      packageAgent: string
    }): AcmeClient
  }

  const acme: AcmeApi
  export default acme
}

declare module 'nodemailer' {
  export interface Address {
    address: string
    name: string
  }

  type AddressLike = string | Address

  export interface SMTPTransportOptions {
    auth?: {
      pass?: string
      user: string
    }
    host: string
    name: string
    port: number
    secure: boolean
    tls: {
      rejectUnauthorized: boolean
    }
  }

  export interface SendMailOptions {
    from: AddressLike
    headers?: Record<string, string>
    html?: string
    messageId?: string
    subject: string
    text?: string
    to: AddressLike | AddressLike[]
  }

  export interface SentMessageInfo {
    accepted: Array<string | Address>
    envelope: {
      from: string
      to: string[]
    }
    messageId: string
    rejected: Array<string | Address>
    response: string
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>
  }

  interface NodemailerApi {
    createTransport(options: SMTPTransportOptions): Transporter
  }

  const nodemailer: NodemailerApi
  export default nodemailer
}
