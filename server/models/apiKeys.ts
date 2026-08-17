import jwt from 'jsonwebtoken'
import moment from 'moment'
import ms from 'ms'
import { Model } from 'objection'
import type { ModelOptions, QueryContext } from 'objection'
import { canonicalMcpResource } from '../agents/origins.ts'

interface CreateKeyOptions {
  name: string
  expiration: string
  fullAccess: boolean
  group: number
}

export default class ApiKey extends Model {
  declare id: number
  declare name: string
  declare key: string
  declare expiration: string
  declare isRevoked: boolean
  declare createdAt: string
  declare updatedAt: string
  declare validUntil: string

  static override get tableName() { return 'apiKeys' }

  static override get jsonSchema () {
    return {
      type: 'object',
      required: ['name', 'key'],
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        key: { type: 'string' },
        expiration: { type: 'string' },
        isRevoked: { type: 'boolean' },
        createdAt: { type: 'string' },
        validUntil: { type: 'string' }
      }
    }
  }

  override async $beforeUpdate (opt: ModelOptions, context: QueryContext): Promise<void> {
    await super.$beforeUpdate(opt, context)
    this.updatedAt = moment.utc().toISOString()
  }

  override async $beforeInsert (context: QueryContext): Promise<void> {
    await super.$beforeInsert(context)
    this.createdAt = moment.utc().toISOString()
    this.updatedAt = moment.utc().toISOString()
  }

  static async createNewKey ({ name, expiration, fullAccess, group }: CreateKeyOptions): Promise<string> {
    const entry = await wiki.models.apiKeys.query().insert({
      name,
      key: 'pending',
      expiration: moment.utc().add(ms(expiration), 'ms').toISOString(),
      isRevoked: true
    })
    const configuredMcpResource = wiki.config.agents?.mcp?.enabled ? canonicalMcpResource(wiki.config.host).href : undefined
    const key = jwt.sign({
      api: entry.id,
      grp: fullAccess ? 1 : group,
      ...(configuredMcpResource
        ? { mcpResource: configuredMcpResource, mcpResourceVersion: 1 }
        : {})
    }, {
      key: wiki.config.certs.private,
      passphrase: wiki.config.sessionSecret
    }, {
      algorithm: 'RS256',
      expiresIn: expiration,
      audience: wiki.config.auth.audience,
      issuer: 'urn:wiki.js'
    })
    await wiki.models.apiKeys.query().findById(entry.id).patch({ key, isRevoked: false })
    return key
  }
}

const wiki = WIKI as unknown as {
  config: {
    agents?: { mcp?: { enabled?: boolean } }
    auth: { audience: string }
    certs: { private: string | Buffer }
    host: string
    sessionSecret: string
  }
  models: { apiKeys: typeof ApiKey }
}
