const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

router.get('/strategies', async (req, res, next) => {
  try {
    const strategies = await WIKI.models.authentication.getStrategies()
    const enabledStrategies = _.filter(strategies, 'isEnabled')

    res.json(enabledStrategies.map(stg => {
      const strategyInfo = _.find(WIKI.data.authentication, ['key', stg.strategyKey]) || {}
      return {
        key: stg.key,
        displayName: stg.displayName,
        order: stg.order,
        selfRegistration: stg.selfRegistration,
        strategy: _.pick(strategyInfo, ['key', 'title', 'logo', 'color', 'icon', 'useForm', 'usernameType'])
      }
    }))
  } catch (err) {
    next(err)
  }
})

module.exports = router
