const _ = require('lodash')

const { ApplicationError } = require('./errors')

/* global WIKI */

const configFields = [
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

const isValidConfig = input => input && _.isPlainObject(input) &&
  ['senderName', 'senderEmail', 'host', 'name', 'user', 'pass', 'dkimDomainName', 'dkimKeySelector', 'dkimPrivateKey'].every(field => _.isString(input[field])) &&
  Number.isInteger(input.port) &&
  ['secure', 'verifySSL', 'useDKIM'].every(field => _.isBoolean(input[field]))

const getConfig = () => ({
  ..._.pick(WIKI.config.mail || {}, configFields),
  pass: _.get(WIKI, 'config.mail.pass', '').length > 0 ? '********' : ''
})

const updateConfig = async input => {
  if (!isValidConfig(input)) {
    throw new ApplicationError('Invalid mail config payload', { code: 'INVALID_MAIL_CONFIGURATION' })
  }
  WIKI.config.mail = {
    ..._.pick(input, configFields),
    pass: input.pass === '********' ? WIKI.config.mail.pass : input.pass
  }
  await WIKI.configSvc.saveToDb(['mail'])
  WIKI.mail.init()
}

const sendTest = async recipientEmail => {
  if (!_.isString(recipientEmail) || recipientEmail.length < 6) {
    throw new ApplicationError('Invalid mail recipient', { code: 'INVALID_MAIL_RECIPIENT' })
  }
  await WIKI.mail.send({
    template: 'test',
    to: recipientEmail,
    subject: 'A test email from your wiki',
    text: 'This is a test email sent from your wiki.',
    data: {
      preheadertext: 'This is a test email sent from your wiki.'
    }
  })
}

module.exports = { getConfig, sendTest, updateConfig }
