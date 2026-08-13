const express = require('express')

const contributeOperations = require('../../operations/contribute')

const router = express.Router()

const optionalString = value => typeof value === 'undefined' ? null : value

router.get('/contributors', async (req, res) => {
  const contributors = await contributeOperations.listContributors()
  res.json(contributors.map(contributor => ({
    id: contributor.id,
    source: contributor.source,
    name: contributor.name,
    joined: contributor.joined,
    website: optionalString(contributor.website),
    twitter: optionalString(contributor.twitter),
    avatar: optionalString(contributor.avatar)
  })))
})

module.exports = router
