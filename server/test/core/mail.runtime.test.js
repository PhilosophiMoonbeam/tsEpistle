import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import nodemailer from 'nodemailer'
const policy = () => ({ host: 'smtp.example.test', port: 587, secure: false, senderName: 'Wiki team', senderEmail: 'wiki@example.test', user: 'x', pass: 'fixture-password', useDKIM: false })
const message = () => ({ template: 'test', to: 'recipient@example.test', data: {} })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const transport = () => ({ sendMail: vi.fn().mockResolvedValue({ accepted: ['recipient@example.test'], rejected: [], messageId: 'fixture', envelope: { from: 'wiki@example.test', to: ['recipient@example.test'] }, response: 'accepted' }), verify: vi.fn().mockResolvedValue(true), close: vi.fn() })
const userLocaleByEmail = new Map()
const mailKnex = table => {
  if (table !== 'users') throw new Error(`Unexpected mail fixture query: ${table}`)
  const query = {
    email: '',
    select() { return query },
    where(criteria) { query.email = criteria.email; return query },
    async first() { return userLocaleByEmail.get(query.email) ?? null }
  }
  return query
}
let wiki, createMailRuntime
beforeEach(async () => {
  userLocaleByEmail.clear()
  wiki = { SERVERPATH: path.resolve('server'), config: { company: 'Fixture company', host: 'https://wiki.example.test', title: 'Fixture wiki', logoUrl: '/logo.png', lang: { code: 'en' }, mail: policy(), offline: false }, models: { knex: mailKnex }, logger: { warn: vi.fn() }, Error: { MailNotConfigured: class extends Error {}, MailTemplateFailed: class extends Error {} } }
  global.WIKI = wiki
  createMailRuntime = (await vi.importFresh('../../core/mail.ts', import.meta.url)).createMailRuntime
})
const defaultLocalization = {
  async resolveMailLocale(preferred) {
    const locale = typeof preferred === 'string' ? preferred : 'en'
    return { locale, siteLocale: 'en', direction: locale === 'ar' ? 'rtl' : 'ltr' }
  },
  translateMail(context, _key, english, values = {}) {
    const text = context.locale === 'en' ? english : `[${context.locale}] ${english}`
    return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)), text)
  }
}
const runtime = (dependencies = {}) => createMailRuntime(wiki, { localization: defaultLocalization, ...dependencies })

describe('Mail runtime configuration and lifecycle', () => {
  it('uses explicit TLS modes, single-character SMTP accounts and structured sender/reply-to addresses', async () => {
    const smtp = transport(), createTransport = vi.fn(() => smtp)
    wiki.config.mail = { ...policy(), tlsMode: 'starttls', replyTo: 'help@example.test', tlsServerName: 'mail.example.test', senderName: 'The "Wiki", Team' }
    const mail = runtime({ createTransport, resolveLogo: async () => '/logo.png' }).init()
    expect(createTransport.mock.calls[0][0]).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false, auth: { user: 'x', pass: 'fixture-password' }, tls: { rejectUnauthorized: true, servername: 'mail.example.test', minVersion: 'TLSv1.2' } })
    await mail.send(message())
    expect(smtp.sendMail.mock.calls[0][0]).toMatchObject({ from: { name: 'The "Wiki", Team', address: 'wiki@example.test' }, replyTo: 'help@example.test' })
    mail.close(); expect(smtp.close).toHaveBeenCalledTimes(1)
  })
  it('holds an immutable sender and branding snapshot while a retired transport drains', async () => {
    const logo = deferred(), delivery = deferred(), old = transport(), next = transport()
    old.sendMail.mockReturnValue(delivery.promise)
    const createTransport = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next)
    const mail = runtime({ createTransport, resolveLogo: () => logo.promise }).init(), oldKey = mail.runtime().configurationKey
    const pending = mail.send(message())
    wiki.config.mail.senderName = 'New sender'
    wiki.config.mail.host = 'new.example.test'
    wiki.config.title = 'New wiki title'
    mail.init()
    expect(old.close).not.toHaveBeenCalled()
    await expect(mail.verify(oldKey)).rejects.toBeInstanceOf(Error)
    expect(next.verify).not.toHaveBeenCalled()
    logo.resolve('/logo.png')
    await vi.waitFor(() => expect(old.sendMail).toHaveBeenCalledTimes(1))
    expect(old.sendMail.mock.calls[0][0]).toMatchObject({ from: { name: 'Wiki team', address: 'wiki@example.test' } })
    expect(old.sendMail.mock.calls[0][0].html).toContain('Fixture wiki')
    expect(old.sendMail.mock.calls[0][0].html).not.toContain('New wiki title')
    expect(old.close).not.toHaveBeenCalled()
    delivery.resolve({ accepted: ['recipient@example.test'] }); await pending
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(next.close).not.toHaveBeenCalled()
    mail.close(); expect(next.close).toHaveBeenCalledTimes(1)
  })
  it('pauses delivery without clearing credentials and rejects offline work before SMTP effects', async () => {
    const smtp = transport(), createTransport = vi.fn(() => smtp), mail = runtime({ createTransport, resolveLogo: async () => '/logo.png' }).init()
    wiki.config.offline = true
    await expect(mail.send(message())).rejects.toBeInstanceOf(Error)
    await expect(mail.verify()).rejects.toBeInstanceOf(Error)
    expect(smtp.sendMail).not.toHaveBeenCalled(); expect(smtp.verify).not.toHaveBeenCalled()
    wiki.config.offline = false; wiki.config.mail.enabled = false; mail.init()
    expect(mail.runtime()).toMatchObject({ active: false, state: 'disabled' })
    expect(wiki.config.mail.pass).toBe('fixture-password')
    expect(smtp.close).toHaveBeenCalledTimes(1)
    await expect(mail.send(message())).rejects.toBeInstanceOf(wiki.Error.MailNotConfigured)
  })
  it('honors offline mode enabled while message rendering is in progress', async () => {
    const logo = deferred(), smtp = transport()
    const mail = runtime({ createTransport: () => smtp, resolveLogo: () => logo.promise }).init()
    const pending = mail.send(message())
    wiki.config.offline = true
    logo.resolve('/logo.png')
    await expect(pending).rejects.toBeInstanceOf(Error)
    expect(smtp.sendMail).not.toHaveBeenCalled()
    mail.close()
    expect(smtp.close).toHaveBeenCalledTimes(1)
  })
  it('allows a connection check to finish before closing its replaced transport', async () => {
    const check = deferred(), old = transport(), next = transport()
    old.verify.mockReturnValue(check.promise)
    const mail = runtime({ createTransport: vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next) }).init()
    const pending = mail.verify()
    wiki.config.mail.host = 'replacement.example.test'
    mail.init()
    expect(old.close).not.toHaveBeenCalled()
    check.resolve(true)
    await pending
    expect(old.close).toHaveBeenCalledTimes(1)
    mail.close()
    expect(next.close).toHaveBeenCalledTimes(1)
  })
  it('does not silently fall back to unsigned messages with an invalid enabled DKIM key', async () => {
    const createTransport = vi.fn(() => transport())
    wiki.config.mail = { ...policy(), useDKIM: true, dkimDomainName: 'example.test', dkimKeySelector: 'wiki', dkimPrivateKey: 'private fixture invalid key' }
    const mail = runtime({ createTransport }).init()
    expect(mail.runtime()).toMatchObject({ active: false, state: 'invalid' })
    expect(createTransport).not.toHaveBeenCalled()
    expect(JSON.stringify(wiki.logger.warn.mock.calls)).not.toContain('private fixture invalid key')
    await expect(mail.send(message())).rejects.toBeInstanceOf(wiki.Error.MailNotConfigured)
  })
  it('produces actual DKIM-signed MIME using the configured key without a network transport', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
    wiki.config.mail = { ...policy(), useDKIM: true, dkimDomainName: 'example.test', dkimKeySelector: 'wiki', dkimPrivateKey: keys.privateKey }
    const mail = runtime({ createTransport: options => nodemailer.createTransport({ streamTransport: true, buffer: true, dkim: options.dkim }), resolveLogo: async () => '/logo.png' }).init()
    const result = await mail.send(message()), source = result.message.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
    expect(source).toMatch(/DKIM-Signature:.*a=rsa-sha256;.*d=example\.test;.*s=wiki;/)
    expect(source).toMatch(/\bb=[A-Za-z0-9+/= ]+/)
    expect(source).not.toContain(keys.privateKey)
    expect(result.envelope).toEqual({ from: 'wiki@example.test', to: ['recipient@example.test'] })
    mail.close()
  })
  it('renders each recipient in their selected language without sharing language state', async () => {
    userLocaleByEmail.set('fr-reader@example.test', { communicationLocale: 'fr' })
    userLocaleByEmail.set('ar-reader@example.test', { communicationLocale: 'ar' })
    const smtp = transport(),
      resolveMailLocale = vi.fn(async preferred => {
        const locale = ['fr', 'ar'].includes(preferred) ? preferred : 'en'
        return { locale, siteLocale: 'en', direction: locale === 'ar' ? 'rtl' : 'ltr' }
      }),
      translateMail = vi.fn((context, _key, english, values = {}) => {
        const translated = Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)), english)
        return `[${context.locale}] ${translated}`
      }),
      mail = runtime({ createTransport: () => smtp, resolveLogo: async () => '/logo.png', localization: { resolveMailLocale, translateMail } }).init()
    const data = { action: 'updated', actorName: '<Writer>', pageTitle: 'Reference page', url: 'https://wiki.example.test/en/reference' }

    await mail.send({ template: 'page-watch', to: 'fr-reader@example.test', data })
    await mail.send({ template: 'page-watch', to: 'ar-reader@example.test', data })

    const [french, arabic] = smtp.sendMail.mock.calls.map(call => call[0])
    expect(french.subject).toContain('[fr]')
    expect(french.text).toContain('[fr]')
    expect(french.html).toContain('[fr]')
    expect(french.html).toMatch(/<html\b(?=[^>]*lang="fr")(?=[^>]*dir="ltr")[^>]*>/)
    expect(french.html).toContain('&lt;Writer&gt;')
    expect(french.html).not.toContain('lang="ar"')
    expect(arabic.subject).toContain('[ar]')
    expect(arabic.text).toContain('[ar]')
    expect(arabic.html).toContain('[ar]')
    expect(arabic.html).toMatch(/<html\b(?=[^>]*lang="ar")(?=[^>]*dir="rtl")[^>]*>/)
    mail.close()
  })

  it('renders all bundled templates, including account invitations, with escaped dynamic content and no upstream image dependencies', async () => {
    const mail = runtime({ resolveLogo: async () => '/logo.png?one=1&two=2' })
    wiki.config.title = '<img src=x onerror=alert(1)>'
    const data = { buttonLink: 'https://wiki.example.test/login?a=1&b=2', actorName: '<b>Actor</b>', action: 'updated', pageTitle: '<i>Page</i>', url: 'https://wiki.example.test/en/page' }
    for (const template of ['account-verify', 'account-reset-pwd', 'account-welcome', 'page-watch', 'test']) {
      const result = await mail.render({ ...message(), template, data })
      expect(result.html.match(/<html\b/g)).toHaveLength(1)
      expect(result.html).not.toContain('static.requarks.io')
      expect(result.html).not.toContain('<img src=x onerror=alert(1)>')
      expect(result.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(result.html).toContain('one=1&amp;two=2')
      const document = new DOMParser().parseFromString(result.html, 'text/html')
      const logo = document.querySelector('img')
      expect(logo).not.toBeNull()
      expect(logo.getAttribute('src')).toBe('https://wiki.example.test/logo.png?one=1&two=2')
      expect(logo.getAttribute('alt')).toBe('')
      expect(logo.style.maxWidth).toBe('120px')
      expect(logo.style.maxHeight).toBe('36px')
      expect(logo.style.width).toBe('auto')
      expect(logo.style.height).toBe('auto')
      expect(logo.hasAttribute('height')).toBe(false)
      if (['account-verify', 'account-reset-pwd', 'account-welcome'].includes(template)) {
        expect(Array.from(document.querySelectorAll('a'), link => link.getAttribute('href'))).toContain(data.buttonLink)
        expect(result.text).toContain(data.buttonLink)
      }
      if (template === 'page-watch') {
        expect(result.html).not.toContain('<b>Actor</b>')
        expect(result.html).toContain('&lt;b&gt;Actor&lt;/b&gt;')
        expect(result.html).not.toContain('<i>Page</i>')
        expect(result.html).toContain('&lt;i&gt;Page&lt;/i&gt;')
        expect(result.text).toContain('https://wiki.example.test/en/page')
      }
    }
    await expect(mail.loadTemplate('../unknown')).rejects.toBeInstanceOf(wiki.Error.MailTemplateFailed)
  })
})
