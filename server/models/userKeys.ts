import { Model } from 'objection'
import type { QueryContext } from 'objection'
import type { Knex } from 'knex'
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

  static override get tableName() {
    return 'userKeys'
  }

  static override get jsonSchema() {
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

  static override get relationMappings() {
    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: { from: 'userKeys.userId', to: 'users.id' }
      }
    }
  }

  override async $beforeInsert(context: QueryContext): Promise<void> {
    await super.$beforeInsert(context)
    this.createdAt = DateTime.utc().toISO()
  }

  static async generateToken({ userId, kind }: GenerateTokenOptions, transaction?: Knex.Transaction): Promise<string> {
    const token = nanoid()
    await wiki.models.userKeys.query(transaction).insert({
      kind,
      token,
      validUntil: DateTime.utc().plus({ days: 1 }).toISO(),
      userId
    })
    return token
  }

  static async validateToken({ kind, token, skipDelete }: ValidateTokenOptions, transaction?: Knex.Transaction): Promise<User> {
    if (skipDelete === true) {
      const result = await wiki.models.userKeys.query(transaction).findOne({ kind, token }).withGraphJoined('user')
      if (!result || DateTime.utc() > DateTime.fromISO(result.validUntil)) {
        throw new wiki.Error.AuthValidationTokenInvalid()
      }
      return result.user
    }

    const validate = async (trx: Knex.Transaction): Promise<User> => {
      const result = await wiki.models.userKeys.query(trx).findOne({ kind, token }).forUpdate()
      if (!result || DateTime.utc() > DateTime.fromISO(result.validUntil)) {
        throw new wiki.Error.AuthValidationTokenInvalid()
      }
      const user = await wiki.models.users.query(trx).findById(result.userId)
      if (!user) {
        throw new wiki.Error.AuthValidationTokenInvalid()
      }
      const deleted = await wiki.models.userKeys.query(trx).deleteById(result.id)
      if (deleted !== 1) {
        throw new wiki.Error.AuthValidationTokenInvalid()
      }
      return user
    }

    return transaction ? validate(transaction) : wiki.models.knex.transaction(validate)
  }

  static async destroyToken({ token }: { token: string }): Promise<number> {
    return wiki.models.userKeys.query().findOne({ token }).delete()
  }
}

const wiki = WIKI as unknown as {
  Error: { AuthValidationTokenInvalid: new () => Error }
  models: { knex: Knex; userKeys: typeof UserKey; users: typeof User }
}
