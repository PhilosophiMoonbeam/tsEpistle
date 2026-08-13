import { Model } from 'objection'
import User from './users.ts'

/**
 * Groups model
 */
export default class Group extends Model { declare id: number
declare name: string
declare isSystem: boolean
declare redirectOnLogin: string
declare createdAt: string
declare updatedAt: string
declare permissions: string[]
declare pageRules: Record<string, unknown>[]
static override get tableName() { return 'groups' } static override get jsonSchema() { return {
  type: 'object',
  required: ['name'],

  properties: {
    id: {type: 'integer'},
    name: {type: 'string'},
    isSystem: {type: 'boolean'},
    redirectOnLogin: {type: 'string'},
    createdAt: {type: 'string'},
    updatedAt: {type: 'string'}
  }
} } static override get jsonAttributes() { return ['permissions', 'pageRules'] } static override get relationMappings() { return {
  users: {
    relation: Model.ManyToManyRelation,
    modelClass: User,
    join: {
      from: 'groups.id',
      through: {
        from: 'userGroups.groupId',
        to: 'userGroups.userId'
      },
      to: 'users.id'
    }
  }
} } override $beforeUpdate() { this.updatedAt = new Date().toISOString() } override $beforeInsert() { this.createdAt = new Date().toISOString()
this.updatedAt = new Date().toISOString() }  }
