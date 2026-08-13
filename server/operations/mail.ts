import _ from 'lodash'

import errors from './errors.ts'

const { ApplicationError } = errors

interface MailConfig extends Record<string, unknown> {
  senderName: string
  senderEmail: string
  host: string
  port: number
  name: string
  secure: boolean
  verifySSL: boolean
  user: string
  pass: string
  useDKIM: boolean
  dkimDomainName: string
  dkimKeySelector: string
  dkimPrivateKey: string
}

const configFields = [
  'senderName', 'senderEmail', 'host', 'port', 'name', 'secure', 'verifySSL', 'user', 'pass',
  'useDKIM', 'dkimDomainName', 'dkimKeySelector', 'dkimPrivateKey'
]

const isValidConfig = (input: unknown): input is MailConfig => Boolean(
  input && _.isPlainObject(input) &&
  ['senderName', 'senderEmail', 'host', 'name', 'user', 'pass', 'dkimDomainName', 'dkimKeySelector', 'dkimPrivateKey'].every(field => _.isString(Reflect.get(input as object, field))) &&
  Number.isInteger(Reflect.get(input as object, 'port')) &&
  ['secure', 'verifySSL', 'useDKIM'].every(field => _.isBoolean(Reflect.get(input as object, field)))
)

const config = WIKI.config as { mail: MailConfig }
const configService = WIKI.configSvc as { saveToDb(keys: string[]): Promise<unknown> }
const mail = WIKI.mail as { init(): void, send(message: Record<string, unknown>): Promise<unknown> }

const getConfig = (): Record<string, unknown> => ({
  ..._.pick(config.mail || {}, configFields),
  pass: _.get(config, 'mail.pass', '').length > 0 ? '********' : ''
})

const updateConfig = async (input: unknown): Promise<void> => {
  if (!isValidConfig(input)) {
    throw new ApplicationError('Invalid mail config payload', { code: 'INVALID_MAIL_CONFIGURATION' })
  }
  config.mail = {
    ...input,
    pass: input.pass === '********' ? config.mail.pass : input.pass
  }
  await configService.saveToDb(['mail'])
  mail.init()
}

const sendTest = async (recipientEmail: unknown): Promise<void> => {
  if (!_.isString(recipientEmail) || recipientEmail.length < 6) {
    throw new ApplicationError('Invalid mail recipient', { code: 'INVALID_MAIL_RECIPIENT' })
  }
  await mail.send({
    template: 'test',
    to: recipientEmail,
    subject: 'A test email from your wiki',
    text: 'This is a test email sent from your wiki.',
    data: { preheadertext: 'This is a test email sent from your wiki.' }
  })
}

export default { getConfig, sendTest, updateConfig }
