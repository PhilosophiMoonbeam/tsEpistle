/* global WIKI */

import bcrypt from 'bcryptjs-then'
import _ from 'lodash'
import tfa from 'node-2fa'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { Model, type ModelOptions, type QueryContext } from 'objection'
import type { Knex } from 'knex'
import validate from 'validate.js'
import qr from 'qr-image'
import Group from './groups.ts'
import Authentication from './authentication.ts'
import Editor from './editors.ts'
import Locale from './locales.ts'
import type Asset from './assets.ts'
import type Comment from './comments.ts'
import type PageHistory from './pageHistory.ts'
import type Page from './pages.ts'
import type UserKey from './userKeys.ts'

interface AuthenticationInfo {
  key: string
  useForm: boolean
  scopes?: string | string[]
}

interface AuthenticationStrategy {
  key: string
  strategyKey: string
  stategyKey?: string
  isEnabled: boolean
  selfRegistration: boolean
  domainWhitelist: string[]
  autoEnrollGroups: number[]
  config: Record<string, unknown>
  info?: AuthenticationInfo
  logout?: (config: Record<string, unknown>, context: AuthenticationContext) => string | Promise<string>
}

interface AuthenticationProfile extends Record<string, unknown> {
  id: unknown
  emails?: unknown
  email?: unknown
  mail?: unknown
  displayName?: unknown
  name?: unknown
  picture?: unknown
  user?: unknown
}

interface AuthenticationContext {
  req: {
    body: Record<string, unknown>
    params: Record<string, string>
    user?: { id: number }
    login(user: User, options: { session: false }, callback: (error?: unknown) => void): void
    logIn(user: User, options: { session: false }, callback: (error?: unknown) => void): void
  }
  res: unknown
}

interface PassportService {
  authenticate(
    strategy: string,
    options: { session: boolean, scope: string | string[] | null },
    callback: (error: unknown, user: User | false | null, info: unknown) => void
  ): (request: AuthenticationContext['req'], response: unknown, next: () => void) => void
}

interface MailMessage {
  template: string
  to: string
  subject: string
  data: {
    preheadertext: string
    title: string
    content: string
    buttonLink: string
    buttonText: string
  }
  text: string
}

interface UsersWikiContext extends Record<string, unknown> {
  Error: {
    AuthAccountAlreadyExists: new () => Error
    AuthAccountBanned: new () => Error
    AuthGenericError: new () => Error
    AuthLoginFailed: new () => Error
    AuthProviderInvalid: new () => Error
    AuthRegistrationDisabled: new () => Error
    AuthRegistrationDomainUnauthorized: new () => Error
    AuthTFAFailed: new () => Error
    AuthTFAInvalid: new () => Error
    InputInvalid: new (message?: string) => Error
    UserNotFound: new () => Error
  }
  auth: {
    passport: PassportService
    strategies: Record<string, AuthenticationStrategy>
  }
  config: {
    title: string
    host: string
    sessionSecret: string
    lang: { code: string }
    certs: { private: string | Buffer }
    auth: {
      enforce2FA: boolean
      tokenExpiration: NonNullable<SignOptions['expiresIn']>
      audience: NonNullable<SignOptions['audience']>
    }
  }
  data: { authentication: AuthenticationInfo[] }
  logger: {
    debug(message: string): void
    error(message: string): void
    warn(value: unknown): void
  }
  mail: { send(message: MailMessage): Promise<void> }
  models: {
    assets: typeof Asset
    authentication: typeof Authentication
    comments: typeof Comment
    knex: Knex
    pageHistory: typeof PageHistory
    pages: typeof Page
    userKeys: typeof UserKey
    users: typeof User
  }
}

interface ProcessProfileOptions {
  profile: AuthenticationProfile
  providerKey: string
}

interface LoginOptions {
  strategy: string
  username?: string
  password?: string
}

interface LoginTfaOptions {
  securityCode: string
  continuationToken: string
  setup: boolean
}

interface ChangePasswordOptions {
  continuationToken: string
  newPassword: string
}

interface ForgotPasswordOptions {
  email: string
}

interface RegisterOptions {
  email: string
  password: string
  name: string
  verify?: boolean
  bypassChecks?: boolean
}

type AfterLoginResult =
  | { mustProvideTFA: true, continuationToken: string, redirect: string }
  | { mustSetupTFA: true, continuationToken: string, tfaQRImage: string, redirect: string }
  | { mustChangePwd: true, continuationToken: string, redirect: string }
  | { jwt: string, redirect: string }

interface LoginChecks {
  skipTFA?: boolean
  skipChangePwd?: boolean
}

interface CreateUserOptions {
  providerKey: string
  email: string
  passwordRaw?: string
  name: string
  groups: number[]
  mustChangePassword?: boolean
  sendWelcomeEmail?: boolean
}

interface UpdateUserOptions {
  id: number
  email?: string
  name?: string
  newPassword?: string
  groups?: number[]
  location?: string
  jobTitle?: string
  timezone?: string
  dateFormat?: string
  appearance?: string
}

interface UserPatch {
  email?: string
  name?: string
  password?: string
  location?: string
  jobTitle?: string
  timezone?: string
  dateFormat?: string
  appearance?: string
}

interface AvatarRow {
  id: number
  data: Buffer
}

const wiki = WIKI as UsersWikiContext


const errorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : String(value)

const bcryptRegexp = /^\$2[ayb]\$[0-9]{2}\$[A-Za-z0-9./]{53}$/

/**
 * Users model
 */
export default class User extends Model { declare id: number
declare email: string
declare name: string
declare providerId: string | null
declare providerKey: string
declare provider: Authentication | string
declare password: string
declare tfaIsActive: boolean
declare tfaSecret: string | null
declare jobTitle: string
declare location: string
declare pictureUrl: string
declare timezone: string
declare dateFormat: string
declare appearance: string
declare isSystem: boolean
declare isActive: boolean
declare isVerified: boolean
declare mustChangePwd: boolean
declare createdAt: string
declare updatedAt: string
declare lastLoginAt: string | null
declare localeCode: string
declare locale: Locale | string
declare defaultEditor: Editor | string
declare groups: Group[]
declare permissions: string[]
static override get tableName() { return 'users' } static override get jsonSchema() { return {
  type: 'object',
  required: ['email'],

  properties: {
    id: {type: 'integer'},
    email: {type: 'string', format: 'email'},
    name: {type: 'string', minLength: 1, maxLength: 255},
    providerId: {type: 'string'},
    password: {type: 'string'},
    tfaIsActive: {type: 'boolean', default: false},
    tfaSecret: {type: ['string', 'null']},
    jobTitle: {type: 'string'},
    location: {type: 'string'},
    pictureUrl: {type: 'string'},
    timezone: {type: 'string'},
    dateFormat: {type: 'string'},
    appearance: {type: 'string'},
    isSystem: {type: 'boolean'},
    isActive: {type: 'boolean'},
    isVerified: {type: 'boolean'},
    mustChangePwd: {type: 'boolean'},
    lastLoginAt: {type: ['string', 'null']},
    providerKey: {type: 'string'},
    localeCode: {type: 'string'},
    defaultEditor: {type: 'string'},
    createdAt: {type: 'string'},
    updatedAt: {type: 'string'}
  }
} } static override get relationMappings() { return {
  groups: {
    relation: Model.ManyToManyRelation,
    modelClass: Group,
    join: {
      from: 'users.id',
      through: {
        from: 'userGroups.userId',
        to: 'userGroups.groupId'
      },
      to: 'groups.id'
    }
  },
  provider: {
    relation: Model.BelongsToOneRelation,
    modelClass: Authentication,
    join: {
      from: 'users.providerKey',
      to: 'authentication.key'
    }
  },
  defaultEditor: {
    relation: Model.BelongsToOneRelation,
    modelClass: Editor,
    join: {
      from: 'users.editorKey',
      to: 'editors.key'
    }
  },
  locale: {
    relation: Model.BelongsToOneRelation,
    modelClass: Locale,
    join: {
      from: 'users.localeCode',
      to: 'locales.code'
    }
  }
} } override async $beforeUpdate(opt: ModelOptions, context: QueryContext): Promise<void> { await super.$beforeUpdate(opt, context)

this.updatedAt = new Date().toISOString()

if (!(opt.patch && this.password === undefined)) {
  await this.generateHash()
} } override async $beforeInsert(context: QueryContext): Promise<void> { await super.$beforeInsert(context)

this.createdAt = new Date().toISOString()
this.updatedAt = new Date().toISOString()

await this.generateHash() } // ------------------------------------------------
// Instance Methods
// ------------------------------------------------

async generateHash(): Promise<void> {
  if (this.password) {
    if (bcryptRegexp.test(this.password)) { return }
    this.password = await bcrypt.hash(this.password, 12)
  }
}

async verifyPassword(pwd: string): Promise<true> {
  if (await bcrypt.compare(pwd, this.password) === true) {
    return true
  } else {
    throw new wiki.Error.AuthLoginFailed()
  }
}

async generateTFA(): Promise<string> {
  const tfaInfo = tfa.generateSecret({
    name: wiki.config.title,
    account: this.email
  })
  await wiki.models.users.query().findById(this.id).patch({
    tfaIsActive: false,
    tfaSecret: tfaInfo.secret
  })
  const safeTitle = wiki.config.title.replace(/[\s-.,=!@#$%?&*()+[\]{}/\\;<>]/g, '')
  return qr.imageSync(`otpauth://totp/${safeTitle}:${this.email}?secret=${tfaInfo.secret}`, { type: 'svg' })
}

async enableTFA(): Promise<number> {
  return wiki.models.users.query().findById(this.id).patch({
    tfaIsActive: true
  })
}

async disableTFA(): Promise<number> {
  return await this.$query().patch({
    tfaIsActive: false,
    tfaSecret: ''
  })
}

verifyTFA(code: string): boolean | null {
  const result = tfa.verifyToken(this.tfaSecret, code)
  return (result && _.has(result, 'delta') && result.delta === 0)
}

getGlobalPermissions(): string[] {
  return _.uniq(this.groups.flatMap(group => group.permissions))
}

getGroups(): number[] {
  return _.uniq(this.groups.map(group => group.id))
}

// ------------------------------------------------
// Model Methods
// ------------------------------------------------

static async processProfile({ profile, providerKey }: ProcessProfileOptions): Promise<User> {
  const provider = wiki.auth.strategies[providerKey]
  if (!provider) {
    throw new Error('You are not authorized to login.')
  }

  const providerInfo = _.find(wiki.data.authentication, ['key', provider.stategyKey])
  if (providerInfo) {
    provider.info = providerInfo
  }
  let user = await wiki.models.users.query().findOne({
    providerId: _.toString(profile.id),
    providerKey
  })

  // Parse email
  let primaryEmail: string
  if (Array.isArray(profile.emails)) {
    const preferred = profile.emails.find(entry =>
      typeof entry === 'object' && entry !== null && Reflect.get(entry, 'primary') === true
    ) ?? profile.emails[0]
    const value = typeof preferred === 'object' && preferred !== null
      ? Reflect.get(preferred, 'value')
      : undefined
    if (typeof value !== 'string') {
      throw new Error('Missing or invalid email address from profile.')
    }
    primaryEmail = value
  } else if (Array.isArray(profile.email)) {
    const value: unknown = _.first(_.flattenDeep(profile.email))
    if (typeof value !== 'string') {
      throw new Error('Missing or invalid email address from profile.')
    }
    primaryEmail = value
  } else if (typeof profile.email === 'string' && profile.email.length > 5) {
    primaryEmail = profile.email
  } else if (typeof profile.mail === 'string' && profile.mail.length > 5) {
    primaryEmail = profile.mail
  } else if (typeof profile.user === 'object' && profile.user !== null &&
    typeof Reflect.get(profile.user, 'email') === 'string' &&
    Reflect.get(profile.user, 'email').length > 5) {
    primaryEmail = Reflect.get(profile.user, 'email')
  } else {
    throw new Error('Missing or invalid email address from profile.')
  }
  primaryEmail = _.toLower(primaryEmail)

  // Find pending social user
  if (!user) {
    user = await wiki.models.users.query().findOne({
      email: primaryEmail,
      providerId: null,
      providerKey
    })
    if (user) {
      user = await user.$query().patchAndFetch({
        providerId: _.toString(profile.id)
      })
    }
  }

  // Parse display name
  let displayName: string
  if (_.isString(profile.displayName) && profile.displayName.length > 0) {
    displayName = profile.displayName
  } else if (_.isString(profile.name) && profile.name.length > 0) {
    displayName = profile.name
  } else {
    displayName = primaryEmail.split('@')[0] ?? ''
  }

  // Parse picture URL / Data
  const pictureData = Buffer.isBuffer(profile.picture) ? profile.picture : undefined
  const pictureUrl = pictureData
    ? 'internal'
    : _.truncate(_.toString(_.get(profile, 'picture', _.get(user, 'pictureUrl', null))), {
        length: 255,
        omission: ''
      })

  // Update existing user
  if (user) {
    if (!user.isActive) {
      throw new wiki.Error.AuthAccountBanned()
    }
    if (user.isSystem) {
      throw new Error('This is a system reserved account and cannot be used.')
    }

    user = await user.$query().patchAndFetch({
      email: primaryEmail,
      name: displayName,
      pictureUrl: pictureUrl
    })

    if (pictureData) {
      await wiki.models.users.updateUserAvatarData(user.id, pictureData)
    }

    return user
  }

  // Self-registration
  if (provider.selfRegistration) {
    // Check if email domain is whitelisted
    if (_.get(provider, 'domainWhitelist', []).length > 0) {
      const emailDomain = _.last(primaryEmail.split('@'))
      if (!_.includes(provider.domainWhitelist, emailDomain)) {
        throw new wiki.Error.AuthRegistrationDomainUnauthorized()
      }
    }

    // Create account
    user = await wiki.models.users.query().insertAndFetch({
      providerKey: providerKey,
      providerId: _.toString(profile.id),
      email: primaryEmail,
      name: displayName,
      pictureUrl: pictureUrl,
      localeCode: wiki.config.lang.code,
      defaultEditor: 'markdown',
      tfaIsActive: false,
      isSystem: false,
      isActive: true,
      isVerified: true
    })

    // Assign to group(s)
    if (provider.autoEnrollGroups.length > 0) {
      await user.$relatedQuery<Group>('groups').relate(provider.autoEnrollGroups)
    }

    if (pictureData) {
      await wiki.models.users.updateUserAvatarData(user.id, pictureData)
    }

    return user
  }

  throw new Error('You are not authorized to login.')
}

/**
 * Login a user
 */
static async login (opts: LoginOptions, context: AuthenticationContext): Promise<AfterLoginResult> {
  if (_.has(wiki.auth.strategies, opts.strategy)) {
    const selStrategy = wiki.auth.strategies[opts.strategy]
    if (!selStrategy || !selStrategy.isEnabled) {
      throw new wiki.Error.AuthProviderInvalid()
    }

    const strInfo = _.find(wiki.data.authentication, ['key', selStrategy.strategyKey])
    if (!strInfo) {
      throw new wiki.Error.AuthProviderInvalid()
    }

    // Inject form user/pass
    if (strInfo.useForm) {
      _.set(context.req, 'body.email', opts.username)
      _.set(context.req, 'body.password', opts.password)
      _.set(context.req.params, 'strategy', opts.strategy)
    }

    // Authenticate
    return new Promise<AfterLoginResult>((resolve, reject) => {
      wiki.auth.passport.authenticate(selStrategy.key, {
        session: !strInfo.useForm,
        scope: strInfo.scopes ? strInfo.scopes : null
      }, async (err, user, _info) => {
        void _info
        if (err) { return reject(err) }
        if (!user) { return reject(new wiki.Error.AuthLoginFailed()) }

        try {
          const resp = await wiki.models.users.afterLoginChecks(user, context, {
            skipTFA: !strInfo.useForm,
            skipChangePwd: !strInfo.useForm
          })
          resolve(resp)
        } catch (err) {
          reject(err)
        }
      })(context.req, context.res, () => {})
    })
  } else {
    throw new wiki.Error.AuthProviderInvalid()
  }
}

/**
 * Perform post-login checks
 */
static async afterLoginChecks (user: User, context: AuthenticationContext, { skipTFA = false, skipChangePwd = false }: LoginChecks = {}): Promise<AfterLoginResult> {
  // Get redirect target
  user.groups = await user.$relatedQuery<Group>('groups').select('groups.id', 'permissions', 'redirectOnLogin')
  let redirect = '/'
  if (user.groups && user.groups.length > 0) {
    for (const grp of user.groups) {
      if (!_.isEmpty(grp.redirectOnLogin) && grp.redirectOnLogin !== '/') {
        redirect = grp.redirectOnLogin
        break
      }
    }
  }

  // Is 2FA required?
  if (!skipTFA) {
    if (user.tfaIsActive && user.tfaSecret) {
      try {
        const tfaToken = await wiki.models.userKeys.generateToken({
          kind: 'tfa',
          userId: user.id
        })
        return {
          mustProvideTFA: true,
          continuationToken: tfaToken,
          redirect
        }
      } catch (errc) {
        wiki.logger.warn(errc)
        throw new wiki.Error.AuthGenericError()
      }
    } else if (wiki.config.auth.enforce2FA || (user.tfaIsActive && !user.tfaSecret)) {
      try {
        const tfaQRImage = await user.generateTFA()
        const tfaToken = await wiki.models.userKeys.generateToken({
          kind: 'tfaSetup',
          userId: user.id
        })
        return {
          mustSetupTFA: true,
          continuationToken: tfaToken,
          tfaQRImage,
          redirect
        }
      } catch (errc) {
        wiki.logger.warn(errc)
        throw new wiki.Error.AuthGenericError()
      }
    }
  }

  // Must Change Password?
  if (!skipChangePwd && user.mustChangePwd) {
    try {
      const pwdChangeToken = await wiki.models.userKeys.generateToken({
        kind: 'changePwd',
        userId: user.id
      })

      return {
        mustChangePwd: true,
        continuationToken: pwdChangeToken,
        redirect
      }
    } catch (errc) {
      wiki.logger.warn(errc)
      throw new wiki.Error.AuthGenericError()
    }
  }

  return new Promise<AfterLoginResult>((resolve, reject) => {
    context.req.login(user, { session: false }, async errc => {
      if (errc) { return reject(errc) }
      const jwtToken = await wiki.models.users.refreshToken(user)
      resolve({ jwt: jwtToken.token, redirect })
    })
  })
}

/**
 * Generate a new token for a user
 */
static async refreshToken(user: number | User): Promise<{ token: string, user: User }> {
  let currentUser: User
  if (typeof user === 'number') {
    if (!Number.isSafeInteger(user)) {
      throw new wiki.Error.AuthGenericError()
    }
    const userId = user
    const foundUser = await wiki.models.users.query().findById(userId).withGraphFetched('groups').modifyGraph('groups', builder => {
      builder.select('groups.id', 'permissions')
    })
    if (!foundUser) {
      wiki.logger.warn(`Failed to refresh token for user ${userId}: Not found.`)
      throw new wiki.Error.AuthGenericError()
    }
    if (!foundUser.isActive) {
      wiki.logger.warn(`Failed to refresh token for user ${userId}: Inactive.`)
      throw new wiki.Error.AuthAccountBanned()
    }
    currentUser = foundUser
  } else {
    currentUser = user
    if (_.isNil(currentUser.groups)) {
      currentUser.groups = await currentUser.$relatedQuery<Group>('groups').select('groups.id', 'permissions')
    }
  }

  // Update Last Login Date
  // -> Bypass Objection.js to avoid updating the updatedAt field
  await wiki.models.knex('users').where('id', currentUser.id).update({ lastLoginAt: new Date().toISOString() })

  return {
    token: jwt.sign({
      id: currentUser.id,
      email: currentUser.email,
      name: currentUser.name,
      av: currentUser.pictureUrl,
      tz: currentUser.timezone,
      lc: currentUser.localeCode,
      df: currentUser.dateFormat,
      ap: currentUser.appearance,
      // defaultEditor: currentUser.defaultEditor,
      permissions: currentUser.getGlobalPermissions(),
      groups: currentUser.getGroups()
    }, {
      key: wiki.config.certs.private,
      passphrase: wiki.config.sessionSecret
    }, {
      algorithm: 'RS256',
      expiresIn: wiki.config.auth.tokenExpiration,
      audience: wiki.config.auth.audience,
      issuer: 'urn:wiki.js'
    }),
    user: currentUser
  }
}

/**
 * Verify a TFA login
 */
static async loginTFA ({ securityCode, continuationToken, setup }: LoginTfaOptions, context: AuthenticationContext): Promise<AfterLoginResult> {
  if (securityCode.length === 6 && continuationToken.length > 1) {
    const user = await wiki.models.userKeys.validateToken({
      kind: setup ? 'tfaSetup' : 'tfa',
      token: continuationToken,
      skipDelete: setup
    })
    if (user) {
      if (user.verifyTFA(securityCode)) {
        if (setup) {
          await user.enableTFA()
        }
        return wiki.models.users.afterLoginChecks(user, context, { skipTFA: true })
      } else {
        throw new wiki.Error.AuthTFAFailed()
      }
    }
  }
  throw new wiki.Error.AuthTFAInvalid()
}

/**
 * Change Password from a Mandatory Password Change after Login
 */
static async loginChangePassword ({ continuationToken, newPassword }: ChangePasswordOptions, context: AuthenticationContext): Promise<{ jwt: string }> {
  if (!newPassword || newPassword.length < 6) {
    throw new wiki.Error.InputInvalid('Password must be at least 6 characters!')
  }
  const usr = await wiki.models.userKeys.validateToken({
    kind: 'changePwd',
    token: continuationToken
  })

  if (usr) {
    if (!usr.isActive) {
      throw new wiki.Error.AuthAccountBanned()
    }

    await wiki.models.users.query().patch({
      password: newPassword,
      mustChangePwd: false
    }).findById(usr.id)

    return new Promise<{ jwt: string }>((resolve, reject) => {
      context.req.logIn(usr, { session: false }, async err => {
        if (err) { return reject(err) }
        const jwtToken = await wiki.models.users.refreshToken(usr)
        resolve({ jwt: jwtToken.token })
      })
    })
  } else {
    throw new wiki.Error.UserNotFound()
  }
}

/**
 * Send a password reset request
 */
static async loginForgotPassword ({ email }: ForgotPasswordOptions, _context: AuthenticationContext): Promise<void> {
  void _context
  const usr = await wiki.models.users.query().where({
    email,
    providerKey: 'local'
  }).first()
  if (!usr) {
    wiki.logger.debug(`Password reset attempt on nonexistant local account ${email}: [DISCARDED]`)
    return
  } else if (!usr.isActive) {
    wiki.logger.debug(`Password reset attempt on disabled local account ${email}: [DISCARDED]`)
    return
  }
  const resetToken = await wiki.models.userKeys.generateToken({
    userId: usr.id,
    kind: 'resetPwd'
  })

  await wiki.mail.send({
    template: 'accountResetPwd',
    to: email,
    subject: `Password Reset Request`,
    data: {
      preheadertext: `A password reset was requested for ${wiki.config.title}`,
      title: `A password reset was requested for ${wiki.config.title}`,
      content: `Click the button below to reset your password. If you didn't request this password reset, simply discard this email.`,
      buttonLink: `${wiki.config.host}/login-reset/${resetToken}`,
      buttonText: 'Reset Password'
    },
    text: `A password reset was requested for wiki ${wiki.config.title}. Open the following link to proceed: ${wiki.config.host}/login-reset/${resetToken}`
  })
}

/**
 * Create a new user
 *
 * @param {Object} param0 User Fields
 */
static async createNewUser ({ providerKey, email, passwordRaw, name, groups, mustChangePassword, sendWelcomeEmail }: CreateUserOptions): Promise<void> {
  // Input sanitization
  email = _.toLower(email)

  // Input validation
  let validation: unknown
  if (providerKey === 'local') {
    validation = validate({
      email,
      passwordRaw,
      name
    }, {
      email: {
        email: true,
        length: {
          maximum: 255
        }
      },
      passwordRaw: {
        presence: {
          allowEmpty: false
        },
        length: {
          minimum: 6
        }
      },
      name: {
        presence: {
          allowEmpty: false
        },
        length: {
          minimum: 2,
          maximum: 255
        }
      }
    }, { format: 'flat' })
  } else {
    validation = validate({
      email,
      name
    }, {
      email: {
        email: true,
        length: {
          maximum: 255
        }
      },
      name: {
        presence: {
          allowEmpty: false
        },
        length: {
          minimum: 2,
          maximum: 255
        }
      }
    }, { format: 'flat' })
  }

  const validationError = Array.isArray(validation) && typeof validation[0] === 'string'
    ? validation[0]
    : undefined
  if (validationError) {
    throw new wiki.Error.InputInvalid(validationError)
  }

  // Check if email already exists
  const usr = await wiki.models.users.query().findOne({ email, providerKey })
  if (!usr) {
    // Create the account
    const newUsrData = {
      providerKey,
      email,
      name,
      locale: 'en',
      defaultEditor: 'markdown',
      tfaIsActive: false,
      isSystem: false,
      isActive: true,
      isVerified: true,
      mustChangePwd: providerKey === 'local' && mustChangePassword === true,
      ...(providerKey === 'local' && passwordRaw !== undefined ? { password: passwordRaw } : {})
    }

    const newUsr = await wiki.models.users.query().insert(newUsrData)

    // Assign to group(s)
    if (groups.length > 0) {
      await newUsr.$relatedQuery<Group>('groups').relate(groups)
    }

    if (sendWelcomeEmail) {
      // Send welcome email
      await wiki.mail.send({
        template: 'accountWelcome',
        to: email,
        subject: `Welcome to the wiki ${wiki.config.title}`,
        data: {
          preheadertext: `You've been invited to the wiki ${wiki.config.title}`,
          title: `You've been invited to the wiki ${wiki.config.title}`,
          content: `Click the button below to access the wiki.`,
          buttonLink: `${wiki.config.host}/login`,
          buttonText: 'Login'
        },
        text: `You've been invited to the wiki ${wiki.config.title}: ${wiki.config.host}/login`
      })
    }
  } else {
    throw new wiki.Error.AuthAccountAlreadyExists()
  }
}

/**
 * Update an existing user
 *
 * @param {Object} param0 User ID and fields to update
 */
static async updateUser ({ id, email, name, newPassword, groups, location, jobTitle, timezone, dateFormat, appearance }: UpdateUserOptions): Promise<void> {
  const usr = await wiki.models.users.query().findById(id)
  if (usr) {
    const usrData: UserPatch = {}
    if (typeof email === 'string' && !_.isEmpty(email) && email !== usr.email) {
      const dupUsr = await wiki.models.users.query().select('id').where({
        email,
        providerKey: usr.providerKey
      }).first()
      if (dupUsr) {
        throw new wiki.Error.AuthAccountAlreadyExists()
      }
      usrData.email = _.toLower(email)
    }
    if (typeof name === 'string' && !_.isEmpty(name) && name !== usr.name) {
      usrData.name = _.trim(name)
    }
    if (typeof newPassword === 'string' && !_.isEmpty(newPassword)) {
      if (newPassword.length < 6) {
        throw new wiki.Error.InputInvalid('Password must be at least 6 characters!')
      }
      usrData.password = newPassword
    }
    if (_.isArray(groups)) {
      const usrGroupsRaw = await usr.$relatedQuery<Group>('groups')
      const usrGroups = _.map(usrGroupsRaw, 'id')
      // Relate added groups
      const addUsrGroups = _.difference(groups, usrGroups)
      for (const grp of addUsrGroups) {
        await usr.$relatedQuery<Group>('groups').relate(grp)
      }
      // Unrelate removed groups
      const remUsrGroups = _.difference(usrGroups, groups)
      for (const grp of remUsrGroups) {
        await usr.$relatedQuery<Group>('groups').unrelate().where('groupId', grp)
      }
    }
    if (typeof location === 'string' && !_.isEmpty(location) && location !== usr.location) {
      usrData.location = _.trim(location)
    }
    if (typeof jobTitle === 'string' && !_.isEmpty(jobTitle) && jobTitle !== usr.jobTitle) {
      usrData.jobTitle = _.trim(jobTitle)
    }
    if (typeof timezone === 'string' && !_.isEmpty(timezone) && timezone !== usr.timezone) {
      usrData.timezone = timezone
    }
    if (dateFormat !== undefined && dateFormat !== usr.dateFormat) {
      usrData.dateFormat = dateFormat
    }
    if (appearance !== undefined && appearance !== usr.appearance) {
      usrData.appearance = appearance
    }
    await wiki.models.users.query().patch(usrData).findById(id)
  } else {
    throw new wiki.Error.UserNotFound()
  }
}

/**
 * Delete a User
 *
 * @param {*} id User ID
 */
static async deleteUser (id: number, replaceId: number): Promise<void> {
  const usr = await wiki.models.users.query().findById(id)
  if (usr) {
    await wiki.models.assets.query().patch({ authorId: replaceId }).where('authorId', id)
    await wiki.models.comments.query().patch({ authorId: replaceId }).where('authorId', id)
    await wiki.models.pageHistory.query().patch({ authorId: replaceId }).where('authorId', id)
    await wiki.models.pages.query().patch({ authorId: replaceId }).where('authorId', id)
    await wiki.models.pages.query().patch({ creatorId: replaceId }).where('creatorId', id)

    await wiki.models.userKeys.query().delete().where('userId', id)
    await wiki.models.users.query().deleteById(id)
  } else {
    throw new wiki.Error.UserNotFound()
  }
}

/**
 * Register a new user (client-side registration)
 *
 * @param {Object} param0 User fields
 * @param {Object} context GraphQL Context
 */
static async register ({ email, password, name, verify = false, bypassChecks = false }: RegisterOptions, _context: AuthenticationContext): Promise<true> {
  void _context
  const localStrg = await wiki.models.authentication.getStrategy('local')
  if (!localStrg) {
    throw new wiki.Error.AuthRegistrationDisabled()
  }
  // Check if self-registration is enabled
  if (localStrg.selfRegistration || bypassChecks) {
    // Input sanitization
    email = _.toLower(email)

    // Input validation
    const validation: unknown = validate({
      email,
      password,
      name
    }, {
      email: {
        email: true,
        length: {
          maximum: 255
        }
      },
      password: {
        presence: {
          allowEmpty: false
        },
        length: {
          minimum: 6
        }
      },
      name: {
        presence: {
          allowEmpty: false
        },
        length: {
          minimum: 2,
          maximum: 255
        }
      }
    }, { format: 'flat' })
    const validationError = Array.isArray(validation) && typeof validation[0] === 'string'
      ? validation[0]
      : undefined
    if (validationError) {
      throw new wiki.Error.InputInvalid(validationError)
    }

    // Check if email domain is whitelisted
    const domainWhitelist = Array.isArray(localStrg.domainWhitelist)
      ? []
      : localStrg.domainWhitelist.v ?? []
    if (domainWhitelist.length > 0 && !bypassChecks) {
      const emailDomain = _.last(email.split('@'))
      if (!_.includes(domainWhitelist, emailDomain)) {
        throw new wiki.Error.AuthRegistrationDomainUnauthorized()
      }
    }
    // Check if email already exists
    const usr = await wiki.models.users.query().findOne({ email, providerKey: 'local' })
    if (!usr) {
      // Create the account
      const newUsr = await wiki.models.users.query().insert({
        provider: 'local',
        email,
        name,
        password,
        locale: 'en',
        defaultEditor: 'markdown',
        tfaIsActive: false,
        isSystem: false,
        isActive: true,
        isVerified: false
      })

      // Assign to group(s)
      const autoEnrollGroups = Array.isArray(localStrg.autoEnrollGroups)
        ? []
        : localStrg.autoEnrollGroups.v ?? []
      if (autoEnrollGroups.length > 0) {
        await newUsr.$relatedQuery<Group>('groups').relate(autoEnrollGroups)
      }

      if (verify) {
        // Create verification token
        const verificationToken = await wiki.models.userKeys.generateToken({
          kind: 'verify',
          userId: newUsr.id
        })

        // Send verification email
        await wiki.mail.send({
          template: 'accountVerify',
          to: email,
          subject: 'Verify your account',
          data: {
            preheadertext: 'Verify your account in order to gain access to the wiki.',
            title: 'Verify your account',
            content: 'Click the button below in order to verify your account and gain access to the wiki.',
            buttonLink: `${wiki.config.host}/verify/${verificationToken}`,
            buttonText: 'Verify'
          },
          text: `You must open the following link in your browser to verify your account and gain access to the wiki: ${wiki.config.host}/verify/${verificationToken}`
        })
      }
      return true
    } else {
      throw new wiki.Error.AuthAccountAlreadyExists()
    }
  } else {
    throw new wiki.Error.AuthRegistrationDisabled()
  }
}

/**
 * Logout the current user
 */
static async logout (context: AuthenticationContext): Promise<string> {
  if (!context.req.user || context.req.user.id === 2) {
    return '/'
  }
  const usr = await wiki.models.users.query().findById(context.req.user.id).select('providerKey')
  if (!usr) {
    throw new wiki.Error.UserNotFound()
  }
  const provider = _.find(wiki.auth.strategies, ['key', usr.providerKey])
  if (!provider) {
    throw new wiki.Error.AuthProviderInvalid()
  }
  return provider.logout ? provider.logout(provider.config, context) : '/'
}

static async getGuestUser (): Promise<User> {
  const user = await wiki.models.users.query().findById(2).withGraphJoined('groups').modifyGraph('groups', builder => {
    builder.select('groups.id', 'permissions')
  })
  if (!user) {
    wiki.logger.error('CRITICAL ERROR: Guest user is missing!')
    process.exit(1)
  }
  user.permissions = user.getGlobalPermissions()
  return user
}

static async getRootUser (): Promise<User> {
  const user = await wiki.models.users.query().findById(1)
  if (!user) {
    wiki.logger.error('CRITICAL ERROR: Root Administrator user is missing!')
    process.exit(1)
  }
  user.permissions = ['manage:system']
  return user
}

/**
 * Add / Update User Avatar Data
 */
static async updateUserAvatarData (userId: number, data: Buffer): Promise<void> {
  try {
    wiki.logger.debug(`Updating user ${userId} avatar data...`)
    if (data.length > 1024 * 1024) {
      throw new Error('Avatar image filesize is too large. 1MB max.')
    }
    const existing = await wiki.models.knex<AvatarRow>('userAvatars').select('id').where('id', userId).first()
    if (existing) {
      await wiki.models.knex<AvatarRow>('userAvatars').where({
        id: userId
      }).update({
        data
      })
    } else {
      await wiki.models.knex<AvatarRow>('userAvatars').insert({
        id: userId,
        data
      })
    }
  } catch (err: unknown) {
    wiki.logger.warn(`Failed to process binary thumbnail data for user ${userId}: ${errorMessage(err)}`)
  }
}

static async getUserAvatarData (userId: number): Promise<Buffer | null | undefined> {
  try {
    const usrData = await wiki.models.knex<AvatarRow>('userAvatars').where('id', userId).first()
    if (usrData) {
      return usrData.data
    } else {
      return null
    }
  } catch {
    wiki.logger.warn(`Failed to process binary thumbnail data for user ${userId}`)
  }
} }
