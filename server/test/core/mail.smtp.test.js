import net from 'node:net'
import nodemailer from 'nodemailer'
import { mailRuntimeConfiguration, mailTransportOptions } from '../../repositories/mail-configuration.ts'
const fixture = async (advertiseTLS = false) => {
  const commands = [], sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setEncoding('utf8')
    socket.write('220 fixture.test ESMTP\r\n')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const end = buffer.indexOf('\r\n'); if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const command = line.split(' ')[0].toUpperCase(); commands.push(command)
        if (command === 'EHLO') socket.write('250-fixture.test\r\n' + (advertiseTLS ? '250-STARTTLS\r\n' : '') + '250 AUTH PLAIN\r\n')
        else if (command === 'AUTH') {
          const fields = Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8').split('\0')
          socket.write(fields[1] === 'x' && fields[2] === 'fixture-password' ? '235 Authentication accepted\r\n' : '535 Authentication rejected\r\n')
        } else if (command === 'STARTTLS') socket.write('454 TLS unavailable\r\n')
        else if (command === 'QUIT') socket.end('221 Goodbye\r\n')
        else socket.write('500 This fixture does not accept messages\r\n')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, commands, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
const config = (port, tlsMode) => mailRuntimeConfiguration({ enabled: true, host: '127.0.0.1', port, tlsMode, verifySSL: true, senderName: 'Fixture', senderEmail: 'wiki@example.test', user: 'x', pass: 'fixture-password' })
describe('Mail SMTP transport protocol', () => {
  it('verifies connection and authentication without an envelope or message transaction', async () => {
    const server = await fixture(), transport = nodemailer.createTransport(mailTransportOptions(config(server.port, 'opportunistic')))
    try {
      expect(await transport.verify()).toBe(true)
      expect(server.commands).toEqual(expect.arrayContaining(['EHLO', 'AUTH']))
      expect(server.commands).not.toContain('MAIL'); expect(server.commands).not.toContain('RCPT'); expect(server.commands).not.toContain('DATA')
    } finally { transport.close(); await server.close() }
  })
  it('refuses a required STARTTLS connection when the server cannot upgrade it', async () => {
    const server = await fixture(), transport = nodemailer.createTransport(mailTransportOptions(config(server.port, 'starttls')))
    try {
      await expect(transport.verify()).rejects.toMatchObject({ code: 'ETLS' })
      expect(server.commands).toContain('STARTTLS')
      expect(server.commands).not.toContain('AUTH'); expect(server.commands).not.toContain('MAIL')
    } finally { transport.close(); await server.close() }
  })
  it('does not downgrade after an advertised STARTTLS upgrade fails', async () => {
    const server = await fixture(true), transport = nodemailer.createTransport(mailTransportOptions(config(server.port, 'opportunistic')))
    try {
      await expect(transport.verify()).rejects.toMatchObject({ code: 'ETLS' })
      expect(server.commands).toContain('STARTTLS')
      expect(server.commands).not.toContain('AUTH')
      expect(server.commands).not.toContain('MAIL')
    } finally { transport.close(); await server.close() }
  })
  it('uses explicitly plain transport only when selected, even if STARTTLS is advertised', async () => {
    const server = await fixture(true), transport = nodemailer.createTransport(mailTransportOptions(config(server.port, 'plain')))
    try {
      expect(await transport.verify()).toBe(true)
      expect(server.commands).not.toContain('STARTTLS')
      expect(server.commands).toContain('AUTH'); expect(server.commands).not.toContain('MAIL')
    } finally { transport.close(); await server.close() }
  })
  it('reports rejected authentication without progressing to a message transaction', async () => {
    const server = await fixture(), value = config(server.port, 'opportunistic'); value.pass = 'wrong-fixture-password'
    const transport = nodemailer.createTransport(mailTransportOptions(value))
    try {
      await expect(transport.verify()).rejects.toMatchObject({ code: 'EAUTH' })
      expect(server.commands).toContain('AUTH'); expect(server.commands).not.toContain('MAIL')
    } finally { transport.close(); await server.close() }
  })
})
