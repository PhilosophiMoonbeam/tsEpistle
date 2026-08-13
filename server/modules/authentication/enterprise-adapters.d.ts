
declare module '@exlinc/keycloak-passport' {
  class KeycloakStrategy {
    constructor(options: KeycloakStrategy.Options, verify: KeycloakStrategy.Verify)
  }
  namespace KeycloakStrategy {
    interface Request { params: { strategy: string }; session: { keycloak_id_token?: string } }
    interface Options { authorizationURL: string; userInfoURL: string; tokenURL: string; host: string; realm: string; clientID: string; clientSecret: string; callbackURL: string; passReqToCallback: true }
    interface TokenResults extends Record<string, unknown> { id_token: string }
    interface Profile extends Record<string, unknown> { keycloakId: string; fullName?: string; username: string; email: string }
    type Done = (error: Error | null, user?: Record<string, unknown> | false) => void
    type Verify = (request: Request, accessToken: string, refreshToken: string, results: TokenResults, profile: Profile, done: Done) => void
  }
  export = KeycloakStrategy
}

declare module 'passport-local' {
  namespace LocalStrategy {
    interface Options { usernameField: string; passwordField: string }
    type Done = (error: Error | null, user?: Record<string, unknown> | false) => void
    type Verify = (username: string, password: string, done: Done) => void
  }
  const passportLocal: {
    Strategy: new (options: LocalStrategy.Options, verify: LocalStrategy.Verify) => object
  }
  export = passportLocal
}

declare module 'passport-oauth2' {
  import type { IncomingMessage } from 'node:http'
  class OAuth2Strategy {
    constructor(options: OAuth2Strategy.Options, verify: OAuth2Strategy.Verify)
    _oauth2: OAuth2Strategy.Client
    userProfile(accessToken: string, done: OAuth2Strategy.ProfileDone): void
  }
  namespace OAuth2Strategy {
    interface Request { params: { strategy: string } }
    interface Options { authorizationURL: string; tokenURL: string; clientID: string; clientSecret: string; userInfoURL?: string; callbackURL: string; passReqToCallback: true; scope?: string[]; state?: boolean }
    interface Client { _useAuthorizationHeaderForGET: boolean; get(url: string, accessToken: string, callback: (error: unknown, body: string, response?: IncomingMessage) => void): void }
    type Done = (error: Error | null, user?: Record<string, unknown> | false) => void
    type ProfileDone = (error: Error | null, profile?: Record<string, unknown>) => void
    type Verify = (request: Request, accessToken: string, refreshToken: string, profile: Record<string, unknown>, done: Done) => void
    const Strategy: typeof OAuth2Strategy
  }
  export = OAuth2Strategy
}

declare module 'passport-openidconnect' {
  class OpenIDConnectStrategy {
    constructor(options: OpenIDConnectStrategy.Options, verify: OpenIDConnectStrategy.Verify)
  }
  namespace OpenIDConnectStrategy {
    interface Request { params: { strategy: string } }
    interface Options { authorizationURL: string; tokenURL: string; clientID: string; clientSecret: string; issuer: string; userInfoURL: string; callbackURL: string; passReqToCallback: true; skipUserProfile: boolean; acrValues: string }
    type Profile = Record<string, unknown>
    type Done = (error: Error | null, user?: Record<string, unknown> | false) => void
    type Verify = (request: Request, issuer: string, userInfoProfile: Profile, idTokenProfile: Profile, context: Record<string, unknown>, idToken: string, accessToken: string, refreshToken: string, parameters: Record<string, unknown>, done: Done) => void
    const Strategy: typeof OpenIDConnectStrategy
  }
  export = OpenIDConnectStrategy
}

