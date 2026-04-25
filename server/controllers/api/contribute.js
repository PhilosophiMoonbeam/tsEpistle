const express = require('express')
const request = require('request-promise')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const CONTRIBUTORS_QUERY = '{\n  sponsors {\n    list(kind: BACKER) {\n      id\n      source\n      name\n      joined\n      website\n      twitter\n      avatar\n    }\n  }\n}\n'

const optionalString = value => typeof value === 'undefined' ? null : value

const serializeContributor = contributor => ({
  id: contributor.id,
  source: contributor.source,
  name: contributor.name,
  joined: contributor.joined,
  website: optionalString(contributor.website),
  twitter: optionalString(contributor.twitter),
  avatar: optionalString(contributor.avatar)
})

router.get('/contributors', async (req, res) => {
  try {
    const resp = await request({
      method: 'POST',
      uri: 'https://graph.requarks.io',
      json: true,
      body: {
        query: CONTRIBUTORS_QUERY,
        variables: {}
      }
    })
    const contributors = _.get(resp, 'data.sponsors.list', [])
    res.json(contributors.map(serializeContributor))
  } catch (err) {
    if (typeof WIKI !== 'undefined' && WIKI.logger && typeof WIKI.logger.warn === 'function') {
      WIKI.logger.warn(err)
    }
    res.json([])
  }
})

module.exports = router
