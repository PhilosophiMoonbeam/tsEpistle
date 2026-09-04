import nodemailer from 'nodemailer'
import type { SMTPTransportOptions, Transporter } from 'nodemailer'
import type { Knex } from 'knex'
import _ from 'lodash'
import fs from 'fs-extra'
import path from 'node:path'
import { resolveActiveBranding } from '../helpers/site-logo-branding.ts'

interface MailOptions {
  template: string
  to: string
  subject: string
  text?: string
  messageId?: string
  data?: Record<string, unknown>
}
interface MailConfig {
  host: string
  port: number
  name: string
  secure: boolean
  verifySSL?: boolean
  user?: string
  pass?: string
  senderName: string
  senderEmail: string
  dkimDomainName?: string
  dkimKeySelector?: string
  dkimPrivateKey?: string
}
interface WikiContext {
  SERVERPATH: string
  Error: { MailNotConfigured: new () => Error; MailTemplateFailed: new () => Error }
  config: { company: string; host: string; logoUrl: string; title: string; mail: MailConfig }
  models: { knex: Knex }
  logger: { warn(message: unknown): void }
}
const wiki = WIKI as unknown as WikiContext

const mail = {
  transport: null as Transporter | null,
  templates: {} as Record<string, _.TemplateExecutor>,
  init() {
    if (_.get(wiki.config, 'mail.host', '').length > 2) {
      const { mail: mailConfig } = wiki.config
      const conf: SMTPTransportOptions = {
        host: mailConfig.host,
        port: mailConfig.port,
        name: mailConfig.name,
        secure: mailConfig.secure,
        tls: { rejectUnauthorized: mailConfig.verifySSL !== false },
        ...(mailConfig.user && mailConfig.user.length > 1
          ? { auth: { user: mailConfig.user, ...(mailConfig.pass === undefined ? {} : { pass: mailConfig.pass }) } }
          : {})
      }
      this.transport = nodemailer.createTransport(conf)
    } else {
      wiki.logger.warn('Mail is not setup! Please set the configuration in the administration area!')
      this.transport = null
    }
    return this
  },
  async send(opts: MailOptions) {
    const transport = this.transport
    if (!transport) {
      wiki.logger.warn('Cannot send email because mail is not setup in the administration area!')
      throw new wiki.Error.MailNotConfigured()
    }
    const template = await this.loadTemplate(opts.template)
    const branding = await resolveActiveBranding(wiki.models.knex, wiki.config.logoUrl)
    const logo = (branding.logoUrl.startsWith('http') ? '' : wiki.config.host) + branding.logoUrl
    return transport.sendMail({
      headers: { 'x-mailer': 'tsEpistle' },
      from: `"${wiki.config.mail.senderName}" <${wiki.config.mail.senderEmail}>`,
      to: opts.to,
      subject: `${opts.subject} - ${wiki.config.title}`,
      ...(opts.messageId === undefined ? {} : { messageId: opts.messageId }),
      ...(opts.text === undefined ? {} : { text: opts.text }),
      html: template({
        copyright: wiki.config.company.length > 0 ? wiki.config.company : 'Powered by tsEpistle',
        ...opts.data,
        logo,
        siteTitle: wiki.config.title
      })
    })
  },
  async loadTemplate(key: string): Promise<_.TemplateExecutor> {
    const cachedTemplate = this.templates[key]
    if (cachedTemplate) return cachedTemplate
    try {
      const raw = await fs.readFile(path.join(wiki.SERVERPATH, `templates/${_.kebabCase(key)}.html`), 'utf8')
      const template = _.template(raw)
      this.templates[key] = template
      return template
    } catch (error) {
      wiki.logger.warn(error)
      throw new wiki.Error.MailTemplateFailed()
    }
  }
}

export default mail
