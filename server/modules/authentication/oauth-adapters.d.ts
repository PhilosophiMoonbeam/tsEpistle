declare namespace OAuthAdapterContracts {
  type Request = import('express').Request
  type BaseProfile = import('passport').Profile
  type VerifyDone = (error: Error | null, user?: Express.User | false | null) => void

  interface RequestOptions {
    clientID: string
    clientSecret: string
    callbackURL: string
    passReqToCallback: true
  }

  type RequestVerify<Profile extends BaseProfile> = (request: Request, accessToken: string, refreshToken: string, profile: Profile, done: VerifyDone) => void
}

declare module 'passport-auth0' {
  interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    domain: string
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly _json: Record<string, unknown>
    readonly _raw: string
    readonly picture?: string
    readonly user_id: string
  }

  type Verify = (
    request: OAuthAdapterContracts.Request,
    accessToken: string,
    refreshToken: string,
    extraParams: Record<string, unknown>,
    profile: Profile,
    done: OAuthAdapterContracts.VerifyDone
  ) => void

  export class Strategy {
    constructor(options: StrategyOptions, verify: Verify)
  }

  interface Auth0Module {
    Strategy: typeof Strategy
  }

  const auth0: Auth0Module
  export default auth0
}

declare module 'passport-azure-ad' {
  interface CookieEncryptionKey {
    key: string
    iv: string
  }

  interface OIDCStrategyOptions {
    identityMetadata: string
    clientID: string
    redirectUrl: string
    responseType: 'id_token'
    responseMode: 'form_post'
    scope: string[]
    allowHttpForRedirectUrl: boolean
    passReqToCallback: true
    cookieSameSite: boolean
    useCookieInsteadOfSession: boolean
    cookieEncryptionKeys: CookieEncryptionKey[]
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly oid: string
    readonly sub: string
    readonly upn?: string
    readonly _json: {
      readonly email?: string
      readonly preferred_username?: string
      readonly groups?: string[]
      readonly [claim: string]: unknown
    }
    readonly _raw: string
  }

  type Verify = (request: OAuthAdapterContracts.Request, issuer: string, subject: string, profile: Profile, done: OAuthAdapterContracts.VerifyDone) => void

  export class OIDCStrategy {
    constructor(options: OIDCStrategyOptions, verify: Verify)
  }

  interface AzureAdModule {
    OIDCStrategy: typeof OIDCStrategy
  }

  const azureAd: AzureAdModule
  export default azureAd
}

declare module 'discord-strategy' {
  export enum DiscordScope {
    Email = 'email',
    Guilds = 'guilds',
    Identify = 'identify'
  }

  export interface DiscordProfile extends Record<string, unknown> {
    readonly avatar?: string | null
    readonly guilds?: ReadonlyArray<{ readonly id: string; readonly name?: string }>
    readonly id: string
    readonly username: string
  }

  export interface ConsumableAPI {
    guilds(): Promise<void>
  }

  interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    authorizationURL: string
    scope: DiscordScope[]
  }

  type Verify = (
    request: OAuthAdapterContracts.Request,
    accessToken: string,
    refreshToken: string,
    results: Record<string, unknown>,
    profile: DiscordProfile,
    done: OAuthAdapterContracts.VerifyDone,
    consume: ConsumableAPI
  ) => void

  export class Strategy {
    constructor(options: StrategyOptions, verify: Verify)
  }
}

declare module 'passport-facebook' {
  interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    profileFields: string[]
    authType: 'reauthenticate' | 'rerequest'
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly _json: Record<string, unknown>
    readonly _raw: string
  }

  export class Strategy {
    constructor(options: StrategyOptions, verify: OAuthAdapterContracts.RequestVerify<Profile>)
  }

  interface FacebookModule {
    Strategy: typeof Strategy
  }

  const facebook: FacebookModule
  export default facebook
}

declare module 'passport-github2' {
  export interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    scope: string[]
    authorizationURL?: string
    tokenURL?: string
    userProfileURL?: string
    userEmailURL?: string
  }

  interface StrategyOptionsWithoutRequest {
    clientID: string
    clientSecret: string
    callbackURL: string
    scope: string[]
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly _json: Record<string, unknown>
    readonly _raw: string
  }

  type Verify = OAuthAdapterContracts.RequestVerify<Profile>
  type VerifyWithoutRequest = (accessToken: string, refreshToken: string, profile: Profile, done: OAuthAdapterContracts.VerifyDone) => void

  export class Strategy {
    constructor(options: StrategyOptions, verify: Verify)
    constructor(options: StrategyOptionsWithoutRequest, verify: VerifyWithoutRequest)
  }

  interface GitHubModule {
    Strategy: typeof Strategy
  }

  const github: GitHubModule
  export default github
}

declare module 'passport-gitlab2' {
  interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    baseURL: string
    authorizationURL: string
    tokenURL: string
    scope: string[]
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly avatarUrl?: string
    readonly profileUrl?: string
    readonly _json: Record<string, unknown>
    readonly _raw: string
  }

  export class Strategy {
    constructor(options: StrategyOptions, verify: OAuthAdapterContracts.RequestVerify<Profile>)
  }

  interface GitLabModule {
    Strategy: typeof Strategy
  }

  const gitlab: GitLabModule
  export default gitlab
}

declare module 'passport-google-oauth20' {
  type StrategyOptions = OAuthAdapterContracts.RequestOptions

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly _json: {
      readonly hd?: string
      readonly [claim: string]: unknown
    }
    readonly _raw: string
  }

  export class Strategy {
    constructor(options: StrategyOptions, verify: OAuthAdapterContracts.RequestVerify<Profile>)
    authorizationParams(options: Record<string, unknown>): Record<string, string>
  }

  interface GoogleModule {
    Strategy: typeof Strategy
  }

  const google: GoogleModule
  export default google
}

declare module 'passport-microsoft' {
  interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    scope: string[]
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly _json: Record<string, unknown>
    readonly _raw: string
  }

  export class Strategy {
    constructor(options: StrategyOptions, verify: OAuthAdapterContracts.RequestVerify<Profile>)
  }

  interface MicrosoftModule {
    Strategy: typeof Strategy
  }

  const microsoft: MicrosoftModule
  export default microsoft
}

declare module 'passport-okta-oauth' {
  interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    audience: string
    idp: string
    response_type: 'code'
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly _json: {
      readonly profile?: string
      readonly [claim: string]: unknown
    }
    readonly _raw: string
  }

  export class Strategy {
    constructor(options: StrategyOptions, verify: OAuthAdapterContracts.RequestVerify<Profile>)
  }

  interface OktaModule {
    Strategy: typeof Strategy
  }

  const okta: OktaModule
  export default okta
}

declare module 'passport-slack-oauth2' {
  interface StrategyOptions extends OAuthAdapterContracts.RequestOptions {
    team: string
    scope: string[]
  }

  interface SlackUser {
    readonly id: string
    readonly name: string
    readonly image_48?: string
    readonly [field: string]: unknown
  }

  type Profile = OAuthAdapterContracts.BaseProfile & {
    readonly user: SlackUser
  }

  export class Strategy {
    constructor(options: StrategyOptions, verify: OAuthAdapterContracts.RequestVerify<Profile>)
  }

  interface SlackModule {
    Strategy: typeof Strategy
  }

  const slack: SlackModule
  export default slack
}
