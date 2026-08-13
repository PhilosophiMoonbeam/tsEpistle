import { Model } from 'objection'
import type { QueryContext } from 'objection'
import { DateTime } from 'luxon'
import { nanoid } from 'nanoid'
import User from './users.ts'

interface GenerateTokenOptions {
  userId: number
  kind: string
}

interface ValidateTokenOptions {
  kind: string
  token: string
  skipDelete?: boolean
}

export default class UserKey extends Model {
  declare id: number
  declare kind: string
  declare token: string
  declare userId: number
  declare createdAt: string
  declare validUntil: string
  declare user: User

  static override get tableName () { return 'userKeys' }

  static override get jsonSchema () {
    return {
      type: 'object',
      required: ['kind', 'token', 'validUntil'],
      properties: {
        id: { type: 'integer' },
        kind: { type: 'string' },
        token: { type: 'string' },
        createdAt: { type: 'string' },
        validUntil: { type: 'string' }
      }
    }
  }

  static override get relationMappings () {
    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: { from: 'userKeys.userId', to: 'users.id' }
      }
    }
  }

  override async $beforeInsert (context: QueryContext): Promise<void> {
    await super.$beforeInsert(context)
    this.createdAt = DateTime.utc().toISO()
  }

  static async generateToken ({ userId, kind }: GenerateTokenOptions, _context?: unknown): Promise<string> {
    void _context
    const token = nanoid()
    await wiki.models.userKeys.query().insert({
      kind,
      token,
      validUntil: DateTime.utc().plus({ days: 1 }).toISO(),
      userId
    })
    return token
  }

  static async validateToken ({ kind, token, skipDelete }: ValidateTokenOptions, _context?: unknown): Promise<User> {
    void _context
    const result = await wiki.models.userKeys.query().findOne({ kind, token }).withGraphJoined('user')
    if (!result) {
      throw new wiki.Error.AuthValidationTokenInvalid()
    }
    if (skipDelete !== true) {
      await wiki.models.userKeys.query().deleteById(result.id)
    }
    if (DateTime.utc() > DateTime.fromISO(result.validUntil)) {
      throw new wiki.Error.AuthValidationTokenInvalid()
    }
    return result.user
  }

  static async destroyToken ({ token }: { token: string }): Promise<number> {
    return wiki.models.userKeys.query().findOne({ token }).delete()
  }
}

const wiki = WIKI as unknown as {
  Error: { AuthValidationTokenInvalid: new () => Error }
  models: { userKeys: typeof UserKey }
}
