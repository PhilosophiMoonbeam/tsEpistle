const express = require('express')

const router = express.Router()

router.use('/system', require('./system'))
router.use('/analytics', require('./analytics'))
router.use('/locales', require('./locales'))
router.use('/groups', require('./groups'))
router.use('/users', require('./users'))
router.use('/pages', require('./pages'))
router.use('/auth', require('./auth'))

router.use((req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

router.use((err, req, res, next) => {
  const status = err.status || 500
  const message = status >= 500 ? 'Internal Server Error' : (err.message || 'Request Failed')
  res.status(status).json({ error: message })
})

module.exports = router
