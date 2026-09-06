import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import nodemailer from 'nodemailer'
const policy = () => ({ host: 'smtp.example.test', port: 587, secure: false, senderName: 'Wiki team', senderEmail: 'wiki@example.test', user: 'x', pass: 'fixture-password', useDKIM: false })
const message = () => ({ template: 'test', to: 'recipient@example.test', subject: 'Delivery test', data: { preheadertext: 'Fixture test' } })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const transport = () => ({ sendMail: vi.fn().mockResolvedValue({ accepted: ['recipient@example.test'], rejected: [], messageId: 'fixture', envelope: { from: 'wiki@example.test', to: ['recipient@example.test'] }, response: 'accepted' }), verify: vi.fn().mockResolvedValue(true), close: vi.fn() })
let wiki, createMailRuntime
beforeEach(async () => {
  wiki = { SERVERPATH: path.resolve('server'), config: { company: 'Fixture company', host: 'https://wiki.example.test', title: 'Fixture wiki', logoUrl: '/logo.png', mail: policy(), offline: false }, models: { knex: {} }, logger: { warn: vi.fn() }, Error: { MailNotConfigured: class extends Error {}, MailTemplateFailed: class extends Error {} } }
  global.WIKI = wiki
  createMailRuntime = (await vi.importFresh('../../core/mail.ts', import.meta.url)).createMailRuntime
})
describe('Mail runtime configuration and lifecycle', () => {
  it('uses explicit TLS modes, single-character SMTP accounts and structured sender/reply-to addresses', async () => {
    const smtp = transport(), createTransport = vi.fn(() => smtp)
    wiki.config.mail = { ...policy(), tlsMode: 'starttls', replyTo: 'help@example.test', tlsServerName: 'mail.example.test', senderName: 'The "Wiki", Team' }
    const mail = createMailRuntime(wiki, { createTransport, resolveLogo: async () => '/logo.png' }).init()
    expect(createTransport.mock.calls[0][0]).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false, auth: { user: 'x', pass: 'fixture-password' }, tls: { rejectUnauthorized: true, servername: 'mail.example.test', minVersion: 'TLSv1.2' } })
    await mail.send(message())
    expect(smtp.sendMail.mock.calls[0][0]).toMatchObject({ from: { name: 'The "Wiki", Team', address: 'wiki@example.test' }, replyTo: 'help@example.test' })
    expect(await mail.verify()).toBe(true)
    mail.close(); expect(smtp.close).toHaveBeenCalledTimes(1)
  })
  it('holds an immutable sender and branding snapshot while a retired transport drains', async () => {
    const logo = deferred(), delivery = deferred(), old = transport(), next = transport()
    old.sendMail.mockReturnValue(delivery.promise)
    const createTransport = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next)
    const mail = createMailRuntime(wiki, { createTransport, resolveLogo: () => logo.promise }).init(), oldKey = mail.runtime().configurationKey
    const pending = mail.send(message())
    wiki.config.mail.senderName = 'New sender'
    wiki.config.mail.host = 'new.example.test'
    wiki.config.title = 'New wiki title'
    mail.init()
    expect(old.close).not.toHaveBeenCalled()
    await expect(mail.verify(oldKey)).rejects.toThrow('settings changed')
    logo.resolve('/logo.png')
    await vi.waitFor(() => expect(old.sendMail).toHaveBeenCalledTimes(1))
    expect(old.sendMail.mock.calls[0][0]).toMatchObject({ from: { name: 'Wiki team', address: 'wiki@example.test' }, subject: 'Delivery test - Fixture wiki' })
    expect(old.sendMail.mock.calls[0][0].html).toContain('Fixture wiki')
    expect(old.sendMail.mock.calls[0][0].html).not.toContain('New wiki title')
    expect(old.close).not.toHaveBeenCalled()
    delivery.resolve({ accepted: ['recipient@example.test'] }); await pending
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(next.close).not.toHaveBeenCalled()
    mail.close(); expect(next.close).toHaveBeenCalledTimes(1)
  })
  it('pauses delivery without clearing credentials and rejects offline work before SMTP effects', async () => {
    const smtp = transport(), createTransport = vi.fn(() => smtp), mail = createMailRuntime(wiki, { createTransport, resolveLogo: async () => '/logo.png' }).init()
    wiki.config.offline = true
    await expect(mail.send(message())).rejects.toThrow('offline')
    await expect(mail.verify()).rejects.toThrow('offline')
    expect(smtp.sendMail).not.toHaveBeenCalled(); expect(smtp.verify).not.toHaveBeenCalled()
    wiki.config.offline = false; wiki.config.mail.enabled = false; mail.init()
    expect(mail.runtime()).toMatchObject({ active: false, state: 'disabled' })
    expect(wiki.config.mail.pass).toBe('fixture-password')
    expect(smtp.close).toHaveBeenCalledTimes(1)
    await expect(mail.send(message())).rejects.toThrow()
  })
  it('honors offline mode enabled while message rendering is in progress', async () => {
    const logo = deferred(), smtp = transport()
    const mail = createMailRuntime(wiki, { createTransport: () => smtp, resolveLogo: () => logo.promise }).init()
    const pending = mail.send(message())
    wiki.config.offline = true
    logo.resolve('/logo.png')
    await expect(pending).rejects.toThrow('offline')
    expect(smtp.sendMail).not.toHaveBeenCalled()
    mail.close()
    expect(smtp.close).toHaveBeenCalledTimes(1)
  })
  it('allows a connection check to finish before closing its replaced transport', async () => {
    const check = deferred(), old = transport(), next = transport()
    old.verify.mockReturnValue(check.promise)
    const mail = createMailRuntime(wiki, { createTransport: vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next) }).init()
    const pending = mail.verify()
    wiki.config.mail.host = 'replacement.example.test'
    mail.init()
    expect(old.close).not.toHaveBeenCalled()
    check.resolve(true)
    expect(await pending).toBe(true)
    expect(old.close).toHaveBeenCalledTimes(1)
    mail.close()
    expect(next.close).toHaveBeenCalledTimes(1)
  })
  it('does not silently fall back to unsigned messages with an invalid enabled DKIM key', async () => {
    const createTransport = vi.fn(() => transport())
    wiki.config.mail = { ...policy(), useDKIM: true, dkimDomainName: 'example.test', dkimKeySelector: 'wiki', dkimPrivateKey: 'private fixture invalid key' }
    const mail = createMailRuntime(wiki, { createTransport }).init()
    expect(mail.runtime()).toMatchObject({ active: false, state: 'invalid' })
    expect(createTransport).not.toHaveBeenCalled()
    expect(JSON.stringify(wiki.logger.warn.mock.calls)).not.toContain('private fixture invalid key')
    await expect(mail.send(message())).rejects.toThrow()
  })
  it('produces actual DKIM-signed MIME using the configured key without a network transport', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
    wiki.config.mail = { ...policy(), useDKIM: true, dkimDomainName: 'example.test', dkimKeySelector: 'wiki', dkimPrivateKey: keys.privateKey }
    const mail = createMailRuntime(wiki, { createTransport: options => nodemailer.createTransport({ streamTransport: true, buffer: true, dkim: options.dkim }), resolveLogo: async () => '/logo.png' }).init()
    const result = await mail.send(message()), source = result.message.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
    expect(source).toMatch(/DKIM-Signature:.*a=rsa-sha256;.*d=example\.test;.*s=wiki;/)
    expect(source).toMatch(/\bb=[A-Za-z0-9+/= ]+/)
    expect(source).not.toContain(keys.privateKey)
    expect(result.envelope).toEqual({ from: 'wiki@example.test', to: ['recipient@example.test'] })
    mail.close()
  })
  it('renders all bundled templates, including account invitations, with escaped dynamic content and no upstream image dependencies', async () => {
    const mail = createMailRuntime(wiki, { resolveLogo: async () => '/logo.png?one=1&two=2' })
    wiki.config.title = '<img src=x onerror=alert(1)>'
    const data = { title: '<script>bad</script>', content: 'A < B & C', buttonText: 'Continue <safely>', buttonLink: 'https://wiki.example.test/login?a=1&b=2', actorName: '<b>Actor</b>', action: 'updated', pageTitle: '<i>Page</i>', url: 'https://wiki.example.test/en/page', preheadertext: '<b>hidden</b>' }
    for (const template of ['accountVerify', 'accountResetPwd', 'accountWelcome', 'page-watch', 'test']) {
      const result = await mail.render({ ...message(), template, data })
      expect(result.html.match(/<html\b/g)).toHaveLength(1)
      expect(result.html).not.toContain('static.requarks.io')
      expect(result.html).not.toContain('<script>bad</script>')
      expect(result.html).not.toContain('<img src=x onerror=alert(1)>')
      expect(result.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(result.html).toContain('one=1&amp;two=2')
    }
    await expect(mail.loadTemplate('../unknown')).rejects.toThrow()
  })
})
