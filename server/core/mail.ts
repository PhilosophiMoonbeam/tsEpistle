import nodemailer from 'nodemailer'
import type { SMTPTransportOptions, Transporter, SendMailOptions, SentMessageInfo } from 'nodemailer'
import type { Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import _ from 'lodash'
import fs from 'fs-extra'
import path from 'node:path'
import { resolveActiveBranding } from '../helpers/site-logo-branding.ts'
import { MAIL_TEMPLATES } from '../../shared/mail-workspace.ts'
import {
  mailRuntimeConfiguration,
  mailConfigurationKey,
  mailRuntimeIssues,
  mailTransportOptions,
  type MailRuntimeConfiguration
} from '../repositories/mail-configuration.ts'

export interface MailOptions {
  template: string
  to: string
  subject: string
  text?: string
  messageId?: string
  data?: Record<string, unknown>
}
interface WikiContext {
  SERVERPATH: string
  Error: { MailNotConfigured: new () => Error; MailTemplateFailed: new () => Error }
  config: { company: string; host: string; logoUrl: string; title: string; mail: unknown; offline?: boolean }
  models: { knex: Knex }
  logger: { warn(message: unknown): void }
}
interface Dependencies {
  createTransport?(options: SMTPTransportOptions): Transporter
  resolveLogo?(): Promise<string>
}
interface Entry {
  transport: Transporter
  configuration: MailRuntimeConfiguration
  key: string
  generation: string
  users: number
  retired: boolean
  closed: boolean
}
type MailTemplate = (data?: object) => string
export interface MailRuntime {
  readonly transport: Transporter | null
  init(): MailRuntime
  close(): void
  send(options: MailOptions, expectedConfiguration?: string): Promise<SentMessageInfo>
  verify(expectedConfiguration?: string): Promise<true>
  render(options: MailOptions): Promise<SendMailOptions>
  loadTemplate(key: string): Promise<MailTemplate>
  /** Internal identities; administration must project only safe observations. */
  runtime(): { active: boolean; configurationKey: string; generation: string | null; paused: boolean; state: 'disabled' | 'invalid' | 'ready' }
}
export const createMailRuntime = (wiki: WikiContext, deps: Dependencies = {}): MailRuntime => {
  let current: Entry | null = null,
    observedKey = '',
    state: 'disabled' | 'invalid' | 'ready' = 'disabled'
  const templates = new Map<string, Promise<MailTemplate>>()
  const closeIfIdle = (entry: Entry) => {
    if (entry.retired && !entry.users && !entry.closed) {
      entry.closed = true
      try {
        entry.transport.close()
      } catch {
        wiki.logger.warn('A retired mail transport could not be closed.')
      }
    }
  }
  const acquire = (expectedConfiguration?: string): Entry => {
    if (wiki.config.offline) throw new Error('Mail delivery is paused while offline mode is enabled.')
    const entry = current
    if (!entry) throw new wiki.Error.MailNotConfigured()
    if (expectedConfiguration !== undefined && expectedConfiguration !== entry.key)
      throw new Error('Mail settings changed. Review the current configuration before continuing.')
    entry.users++
    return entry
  }
  const release = (entry: Entry) => {
    entry.users--
    closeIfIdle(entry)
  }
  const render = async (options: MailOptions, configuration: MailRuntimeConfiguration): Promise<SendMailOptions> => {
    const input = { ...options, data: structuredClone(options.data ?? {}) },
      brandingConfig = { ...wiki.config }
    const template = await api.loadTemplate(input.template)
    const logo = deps.resolveLogo ? await deps.resolveLogo() : (await resolveActiveBranding(wiki.models.knex, brandingConfig.logoUrl)).logoUrl
    const url = logo ? new URL(logo, brandingConfig.host) : null
    const html = template({
      ...input.data,
      preheadertext: input.data.preheadertext ?? '',
      copyright: brandingConfig.company || 'Powered by tsEpistle',
      logo: url && ['https:', 'http:'].includes(url.protocol) ? url.toString() : '',
      siteTitle: brandingConfig.title
    })
    return {
      headers: { 'x-mailer': 'tsEpistle' },
      from: { name: configuration.senderName.trim(), address: configuration.senderEmail.trim() },
      ...(configuration.replyTo ? { replyTo: configuration.replyTo.trim() } : {}),
      to: input.to,
      subject: `${input.subject} - ${brandingConfig.title}`,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.text === undefined ? {} : { text: input.text }),
      html
    }
  }
  const api: MailRuntime = {
    get transport() {
      return current?.transport ?? null
    },
    init() {
      const configuration = mailRuntimeConfiguration(wiki.config.mail),
        key = mailConfigurationKey(configuration)
      if (current?.key === key) return api
      let next: Entry | null = null
      state = configuration.enabled ? 'invalid' : 'disabled'
      if (configuration.enabled && !mailRuntimeIssues(configuration).length) {
        try {
          next = {
            transport: (deps.createTransport ?? nodemailer.createTransport)(mailTransportOptions(configuration)),
            configuration,
            key,
            generation: randomUUID(),
            users: 0,
            retired: false,
            closed: false
          }
          state = 'ready'
        } catch {
          wiki.logger.warn('Mail transport initialization failed. Review the saved settings.')
        }
      } else if (configuration.enabled) wiki.logger.warn('Mail settings require review before delivery can start.')
      const previous = current
      current = next
      observedKey = key
      if (previous) {
        previous.retired = true
        closeIfIdle(previous)
      }
      return api
    },
    close() {
      const previous = current
      current = null
      state = 'disabled'
      if (previous) {
        previous.retired = true
        closeIfIdle(previous)
      }
    },
    runtime() {
      return { active: Boolean(current), configurationKey: observedKey, generation: current?.generation ?? null, paused: wiki.config.offline === true, state }
    },
    async send(options, expectedConfiguration) {
      const entry = acquire(expectedConfiguration)
      try {
        const message = await render(options, entry.configuration)
        if (wiki.config.offline) throw new Error('Mail delivery is paused while offline mode is enabled.')
        return await entry.transport.sendMail(message)
      } finally {
        release(entry)
      }
    },
    async verify(expectedConfiguration) {
      const entry = acquire(expectedConfiguration)
      try {
        return await entry.transport.verify()
      } finally {
        release(entry)
      }
    },
    render(options) {
      return render(options, mailRuntimeConfiguration(wiki.config.mail))
    },
    async loadTemplate(key) {
      const canonical = _.kebabCase(key)
      if (!MAIL_TEMPLATES.some(template => template.key === canonical)) throw new wiki.Error.MailTemplateFailed()
      let template = templates.get(canonical)
      if (!template) {
        template = Promise.all(['layout', canonical].map(name => fs.readFile(path.join(wiki.SERVERPATH, `templates/${name}.html`), 'utf8')))
          .then(([layout, body]) => {
            const shell = _.template(layout!),
              content = _.template(body!)
            return (data: object = {}) => shell({ ...data, body: content(data) })
          })
          .catch(() => {
            templates.delete(canonical)
            throw new wiki.Error.MailTemplateFailed()
          })
        templates.set(canonical, template)
      }
      return template
    }
  }
  return api
}
export default createMailRuntime(WIKI as unknown as WikiContext)
