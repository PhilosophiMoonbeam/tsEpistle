import nodemailer from 'nodemailer'
import type { SMTPTransportOptions, Transporter, SendMailOptions, SentMessageInfo } from 'nodemailer'
import type { Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import _ from 'lodash'
import fs from 'fs-extra'
import path from 'node:path'
import { resolveActiveBranding } from '../helpers/site-logo-branding.ts'
import { MAIL_TEMPLATES, type MailTemplateData, type MailTemplateKey } from '../../shared/mail-workspace.ts'
import localization from './localization.ts'
import {
  mailRuntimeConfiguration,
  mailConfigurationKey,
  mailRuntimeIssues,
  mailTransportOptions,
  type MailRuntimeConfiguration
} from '../repositories/mail-configuration.ts'

export interface MailOptions {
  template: MailTemplateKey
  to: string
  messageId?: string
  data?: MailTemplateData
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
  localization?: Pick<typeof localization, 'resolveMailLocale' | 'translateMail'>
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
  loadTemplate(key: MailTemplateKey): Promise<MailTemplate>
  /** Internal identities; administration must project only safe observations. */
  runtime(): { active: boolean; configurationKey: string; generation: string | null; paused: boolean; state: 'disabled' | 'invalid' | 'ready' }
}
export const createMailRuntime = (wiki: WikiContext, deps: Dependencies = {}): MailRuntime => {
  let current: Entry | null = null,
    observedKey = '',
    state: 'disabled' | 'invalid' | 'ready' = 'disabled'
  const templates = new Map<MailTemplateKey, Promise<MailTemplate>>(),
    mailLocalization = deps.localization ?? localization
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
    const input = structuredClone(options),
      brandingConfig = { ...wiki.config },
      definition = MAIL_TEMPLATES.find(template => template.key === input.template)
    if (!definition) throw new wiki.Error.MailTemplateFailed()
    const sourceData = input.data ?? {}
    const recipient: unknown = await wiki.models.knex('users').select('communicationLocale').where({ email: input.to }).first()
    const preferredLocale = typeof recipient === 'object' && recipient !== null
      ? Reflect.get(recipient, 'communicationLocale') ?? null
      : null
    const mailLocale = await mailLocalization.resolveMailLocale(preferredLocale)
    const parameters: Record<string, string> = { siteTitle: brandingConfig.title, siteName: brandingConfig.title }
    const webUrl = (value: unknown): string => {
      if (typeof value !== 'string') throw new wiki.Error.MailTemplateFailed()
      try {
        const parsed = new URL(value)
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported mail URL protocol.')
        return parsed.toString()
      } catch {
        throw new wiki.Error.MailTemplateFailed()
      }
    }
    if (input.template === 'account-verify' || input.template === 'account-reset-pwd' || input.template === 'account-welcome') {
      parameters.link = webUrl(sourceData.buttonLink)
    } else if (input.template === 'page-watch') {
      if (!sourceData.action || !('actions' in definition)) throw new wiki.Error.MailTemplateFailed()
      const action = definition.actions[sourceData.action]
      if (!action || typeof sourceData.actorName !== 'string' || typeof sourceData.pageTitle !== 'string')
        throw new wiki.Error.MailTemplateFailed()
      parameters.actorName = sourceData.actorName
      parameters.pageTitle = sourceData.pageTitle
      parameters.url = webUrl(sourceData.url)
      parameters.link = parameters.url
      parameters.event = mailLocalization.translateMail(mailLocale, action.key, action.english, { ...parameters, actor: parameters.actorName })
    }
    const messages = definition.messages as Record<string, string>,
      messageKeys = ('messageKeys' in definition ? definition.messageKeys : {}) as Record<string, string>,
      copy: Record<string, string> = {}
    for (const [key, english] of Object.entries(messages))
      copy[key] = mailLocalization.translateMail(mailLocale, `${definition.translationKey}.${messageKeys[key] ?? key}`, english, parameters)
    if (copy.expiry) copy.footer = [copy.expiry, copy.footer].filter(Boolean).join(' ')
    const plainText = [
      input.template === 'page-watch' ? parameters.pageTitle : copy.title,
      input.template === 'test' ? copy.introduction : copy.content,
      input.template === 'test' ? copy.confirmation : '',
      parameters.link,
      copy.footer
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n\n')
    const template = await api.loadTemplate(input.template),
      logo = deps.resolveLogo ? await deps.resolveLogo() : (await resolveActiveBranding(wiki.models.knex, brandingConfig.logoUrl)).logoUrl,
      logoUrl = logo ? new URL(logo, brandingConfig.host) : null,
      body = template({
        ...parameters,
        __mail: copy,
        preheadertext: copy.preheader ?? '',
        title: input.template === 'page-watch' ? parameters.pageTitle : copy.title,
        content: copy.content ?? '',
        buttonText: copy.buttonText ?? '',
        buttonLink: parameters.link ?? '',
        copyright: brandingConfig.company || 'Powered by tsEpistle',
        logo: logoUrl && ['https:', 'http:'].includes(logoUrl.protocol) ? logoUrl.toString() : '',
        siteTitle: brandingConfig.title,
        lang: mailLocale.locale,
        direction: mailLocale.direction
      })
    return {
      headers: { 'x-mailer': 'tsEpistle' },
      from: { name: configuration.senderName.trim(), address: configuration.senderEmail.trim() },
      ...(configuration.replyTo ? { replyTo: configuration.replyTo.trim() } : {}),
      to: input.to,
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Email subjects must strip C0 and DEL header controls.
      subject: (copy.subject ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      text: plainText,
      html: body
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
      const definition = MAIL_TEMPLATES.find(template => template.key === key)
      if (!definition) throw new wiki.Error.MailTemplateFailed()
      let template = templates.get(key)
      if (!template) {
        template = Promise.all(['layout', key].map(name => fs.readFile(path.join(wiki.SERVERPATH, `templates/${name}.html`), 'utf8')))
          .then(([layout, body]) => {
            let localizedBody = body!
            for (const [source, message] of Object.entries(definition.htmlText)) {
              if (!localizedBody.includes(source)) throw new Error('Mail template text no longer matches its registry.')
              localizedBody = localizedBody.replace(source, `<%- __mail.${message} %>`)
            }
            const localizedLayout = layout!
              .replace('<html lang="en">', '<html lang="<%- lang %>" dir="<%- direction %>">')
              .replace('</head>', '<style>body{text-align:start}</style>\n</head>')
            if (localizedLayout === layout) throw new Error('Mail layout language markers are unavailable.')
            const shell = _.template(localizedLayout),
              content = _.template(localizedBody)
            return (data: object = {}) => shell({ ...data, body: content(data) })
          })
          .catch(() => {
            templates.delete(key)
            throw new wiki.Error.MailTemplateFailed()
          })
        templates.set(key, template)
      }
      return template
    }
  }
  return api
}
export default createMailRuntime(WIKI as unknown as WikiContext)
