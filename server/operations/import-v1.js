const crypto = require('crypto')
const _ = require('lodash')
const { MongoClient } = require('mongodb')
const nanoid = require('nanoid/non-secure').customAlphabet('1234567890abcdef', 10)

const { ApplicationError } = require('./errors')

/* global WIKI */

const buildPageRules = rights => rights.map(rule => ({
  id: nanoid(),
  roles: rule.role === 'write' ?
    ['read:pages', 'read:assets', 'read:comments', 'write:comments', 'write:pages', 'manage:pages', 'read:source', 'read:history', 'write:assets', 'manage:assets'] :
    ['read:pages', 'read:assets', 'read:comments', 'write:comments'],
  match: rule.exact ? 'EXACT' : 'START',
  deny: rule.deny,
  path: rule.path.indexOf('/') === 0 ? rule.path.substring(1) : rule.path,
  locales: []
}))

const importUsers = async ({ mongoDbConnString, groupMode }) => {
  if (!mongoDbConnString || mongoDbConnString.length <= 10) {
    throw new ApplicationError('MongoDB Connection String is missing or invalid.', { code: 'INVALID_MONGODB_CONNECTION' })
  }
  const client = await MongoClient.connect(mongoDbConnString, { appname: `Wiki.js ${WIKI.version} Migration Tool` })
  try {
    const cursor = client.db().collection('users').find({ email: { '$ne': 'guest' } })
    const timestamp = new Date().toISOString()
    const failed = []
    let usersCount = 0
    let groupsCount = 0
    const assignableGroups = []
    const reusableGroups = []

    if (groupMode === 'SINGLE') {
      const group = await WIKI.models.groups.query().insert({
        name: `Import_${timestamp}`,
        permissions: JSON.stringify(WIKI.data.groups.defaultPermissions),
        pageRules: JSON.stringify(WIKI.data.groups.defaultPageRules)
      })
      groupsCount++
      assignableGroups.push(group.id)
    }

    while (await cursor.hasNext()) {
      const user = await cursor.next()
      const userGroups = []
      if (groupMode === 'MULTI') {
        if (_.some(user.rights, ['role', 'admin'])) {
          userGroups.push(1)
        } else {
          const rights = _.sortBy(_.map(user.rights, rule => _.pick(rule, ['role', 'path', 'exact', 'deny'])), ['role', 'path', 'exact', 'deny'])
          const hash = crypto.createHash('sha1').update(JSON.stringify(rights)).digest('base64')
          const existing = _.find(reusableGroups, ['hash', hash])
          if (existing) {
            userGroups.push(existing.groupId)
          } else {
            const pageRules = buildPageRules(user.rights)
            const permissions = _.chain(pageRules).reject('deny').map('roles').union().flatten().value()
            const group = await WIKI.models.groups.query().insert({
              name: `Import_${timestamp}_${groupsCount + 1}`,
              permissions: JSON.stringify(permissions),
              pageRules: JSON.stringify(pageRules)
            })
            reusableGroups.push({ groupId: group.id, hash })
            groupsCount++
            userGroups.push(group.id)
          }
        }
      }
      try {
        await WIKI.models.users.createNewUser({
          providerKey: user.provider,
          email: user.email,
          name: user.name,
          passwordRaw: user.password,
          groups: userGroups.length > 0 ? userGroups : assignableGroups,
          mustChangePassword: false,
          sendWelcomeEmail: false
        })
        usersCount++
      } catch (err) {
        failed.push({ provider: user.provider, email: user.email, error: err.message })
        WIKI.logger.warn(`${user.email}: ${err}`)
      }
    }
    if (groupMode !== 'NONE') {
      await WIKI.auth.reloadGroups()
      WIKI.events.outbound.emit('reloadGroups')
    }
    return { usersCount, groupsCount, failed }
  } finally {
    await client.close()
  }
}

module.exports = { importUsers }
