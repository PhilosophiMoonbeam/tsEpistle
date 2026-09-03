import passportOauth2Module from 'passport-oauth2'
import type { Profile } from 'passport'
import type { Request } from 'express'
import { z } from 'zod'

const OAuth2Strategy = passportOauth2Module.Strategy

const authorizationURL = 'https://www.dropbox.com/oauth2/authorize'
const tokenURL = 'https://api.dropboxapi.com/oauth2/token'
const profileURL = 'https://api.dropboxapi.com/2/users/get_current_account'
const maximumResponseBytes = 1024 * 1024
const profileRequestTimeoutMilliseconds = 10_000

type DropboxRequest = Request & {
  params: { strategy: string }
}

type VerifyDone = (error: Error | null, user?: Express.User | false | null, info?: unknown) => void
type DropboxVerify = (request: DropboxRequest, accessToken: string, refreshToken: string, profile: DropboxProfile, done: VerifyDone) => void | Promise<void>

type DropboxStrategyOptions = {
  clientID: string
  clientSecret: string
  callbackURL: string
  passReqToCallback: true
}

const DropboxAccountSchema = z
  .object({
    account_id: z.string().min(1),
    name: z
      .object({
        display_name: z.string().min(1),
        given_name: z.string().optional(),
        surname: z.string().optional()
      })
      .passthrough(),
    email: z.email(),
    email_verified: z.literal(true),
    profile_photo_url: z.string().nullable().optional()
  })
  .passthrough()

type DropboxAccount = z.infer<typeof DropboxAccountSchema>

type DropboxProfile = Profile &
  Record<string, unknown> & {
    readonly _raw: string
    readonly _json: DropboxAccount
  }

const parseAccount = (body: string): DropboxAccount => {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error: unknown) {
    throw new Error(`Dropbox profile response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return DropboxAccountSchema.parse(value)
}

class DropboxStrategy extends OAuth2Strategy {
  override readonly name = 'dropbox-oauth2'

  constructor(options: DropboxStrategyOptions, verify: DropboxVerify) {
    super(
      {
        ...options,
        authorizationURL,
        tokenURL,
        state: true
      },
      verify as never
    )
  }

  override userProfile(accessToken: string, done: (error: Error | null, profile?: DropboxProfile) => void): void {
    void this.fetchProfile(accessToken)
      .then(profile => done(null, profile))
      .catch(error => done(error instanceof Error ? error : new Error(String(error))))
  }

  private async fetchProfile(accessToken: string): Promise<DropboxProfile> {
    const response = await fetch(profileURL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json'
      },
      body: 'null',
      redirect: 'error',
      signal: AbortSignal.timeout(profileRequestTimeoutMilliseconds)
    })
    if (!response.ok) throw new Error(`Dropbox profile request failed with HTTP ${response.status}.`)

    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
      throw new Error('Dropbox profile response is too large.')
    }

    const body = await this.readResponse(response)
    const account = parseAccount(body)
    return {
      provider: 'dropbox',
      id: account.account_id,
      displayName: account.name.display_name,
      name: {
        familyName: account.name.surname ?? '',
        givenName: account.name.given_name ?? '',
        middleName: ''
      },
      emails: [{ value: account.email }],
      _raw: body,
      _json: account
    }
  }

  private async readResponse(response: Response): Promise<string> {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const chunks: string[] = []
    let bytesRead = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maximumResponseBytes) {
        await reader.cancel()
        throw new Error('Dropbox profile response is too large.')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  }
}

export { DropboxStrategy, type DropboxAccount, type DropboxProfile, type DropboxRequest, type DropboxStrategyOptions, type DropboxVerify, type VerifyDone }
