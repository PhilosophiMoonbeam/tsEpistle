const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }

  return true
}

router.post('/test', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const recipientEmail = _.get(req, 'body.recipientEmail', '')
  if (_.isEmpty(recipientEmail) || recipientEmail.length < 6) {
    res.status(400).json({ error: 'Invalid mail recipient' })
    return
  }

  try {
    await WIKI.mail.send({
      template: 'test',
      to: recipientEmail,
      subject: 'A test email from your wiki',
      text: 'This is a test email sent from your wiki.',
      data: {
        preheadertext: 'This is a test email sent from your wiki.'
      }
    })

    res.json({ message: 'Test email sent successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Test email failed' })
  }
})

module.exports = router
