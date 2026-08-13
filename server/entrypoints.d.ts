declare module 'ms' {
  function milliseconds(value: string): number
  export default milliseconds
}

declare module 'pem-jwk' {
  interface PemJwkModule {
    pem2jwk(pem: string): JsonWebKey
  }

  const pemJwk: PemJwkModule
  export default pemJwk
}

declare module 'passport-jwt' {
  import type { Request } from 'express'

  interface StrategyOptions {
    algorithms?: string[]
    audience?: string | string[]
    issuer?: string
    jwtFromRequest(request: Request): string | null
    secretOrKey: string | Buffer
  }

  type Verified = (error: Error | null, user?: unknown, info?: unknown) => void
  type Verify = (payload: unknown, done: Verified) => void
  type JwtExtractor = (request: Request) => string | null

  class Strategy {
    constructor(options: StrategyOptions, verify: Verify)
    authenticate(request: Request, options?: unknown): void
  }

  const ExtractJwt: {
    fromAuthHeaderAsBearerToken(): JwtExtractor
    fromExtractors(extractors: JwtExtractor[]): JwtExtractor
  }

  const passportJwt: {
    ExtractJwt: typeof ExtractJwt
    Strategy: typeof Strategy
  }

  export { ExtractJwt, Strategy }
  export default passportJwt
}
