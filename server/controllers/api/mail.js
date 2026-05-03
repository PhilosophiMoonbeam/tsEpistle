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

const mailConfigFields = [
  'senderName',
  'senderEmail',
  'host',
  'port',
  'name',
  'secure',
  'verifySSL',
  'user',
  'pass',
  'useDKIM',
  'dkimDomainName',
  'dkimKeySelector',
  'dkimPrivateKey'
]

const validateMailConfigPayload = payload => {
  return payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    ['senderName', 'senderEmail', 'host', 'name', 'user', 'pass', 'dkimDomainName', 'dkimKeySelector', 'dkimPrivateKey'].every(field => typeof payload[field] === 'string') &&
    Number.isInteger(payload.port) &&
    ['secure', 'verifySSL', 'useDKIM'].every(field => typeof payload[field] === 'boolean')
}

const serializeMailConfig = () => {
  const mailConfig = _.pick(WIKI.config.mail || {}, mailConfigFields)
  return {
    ...mailConfig,
    pass: _.get(WIKI, 'config.mail.pass', '').length > 0 ? '********' : ''
  }
}

router.get('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  res.json(serializeMailConfig())
})

router.post('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  if (!validateMailConfigPayload(req.body)) {
    res.status(400).json({ error: 'Invalid mail config payload' })
    return
  }

  try {
    WIKI.config.mail = {
      senderName: req.body.senderName,
      senderEmail: req.body.senderEmail,
      host: req.body.host,
      port: req.body.port,
      name: req.body.name,
      secure: req.body.secure,
      verifySSL: req.body.verifySSL,
      user: req.body.user,
      pass: req.body.pass === '********' ? WIKI.config.mail.pass : req.body.pass,
      useDKIM: req.body.useDKIM,
      dkimDomainName: req.body.dkimDomainName,
      dkimKeySelector: req.body.dkimKeySelector,
      dkimPrivateKey: req.body.dkimPrivateKey
    }
    await WIKI.configSvc.saveToDb(['mail'])
    WIKI.mail.init()

    res.json({ message: 'Mail configuration updated successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Mail configuration update failed' })
  }
})

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
