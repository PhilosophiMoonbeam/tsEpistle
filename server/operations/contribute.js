const request = require('request-promise')
const _ = require('lodash')

/* global WIKI */

const contributorsQuery = '{\n  sponsors {\n    list(kind: BACKER) {\n      id\n      source\n      name\n      joined\n      website\n      twitter\n      avatar\n    }\n  }\n}\n'

const listContributors = async () => {
  try {
    const response = await request({
      method: 'POST',
      uri: 'https://graph.requarks.io',
      json: true,
      body: { query: contributorsQuery, variables: {} }
    })
    return _.get(response, 'data.sponsors.list', [])
  } catch (err) {
    WIKI.logger.warn(err)
    return []
  }
}

module.exports = { listContributors }
