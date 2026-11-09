import { createServer, type Socket } from 'node:net'
import { BerReader, BerWriter, BindRequest, FilterParser, SearchRequest } from 'ldapts'
import { describe, expect, it } from '../bun-test.mts'
import { LdapStrategy, type LdapRequest, type LdapServerOptions } from '../../modules/authentication/ldap/ldap-strategy.ts'

const userDn = 'uid=alice,ou=users,dc=example,dc=com'
const readerDn = 'cn=reader,dc=example,dc=com'
const userBase = 'ou=users,dc=example,dc=com'
const groupBase = 'ou=groups,dc=example,dc=com'
type WireEvent = { connection: number; operation: 'bind' | 'search' | 'unbind'; identity: string; base?: string; filter?: string }
type DirectoryPolicy = { anonymous?: boolean; readerPassword?: string; users?: number; denyGroups?: boolean }

// A local BER-speaking directory boundary, not a replacement for the installed LDAP client.
// Its ACL distinguishes the search connection from the independently bound user connection.
const directory = async (policy: DirectoryPolicy = {}) => {
  const events: WireEvent[] = []
  const errors: Error[] = []
  const connections: { socket: Socket; closed: Promise<void> }[] = []
  const server = createServer(socket => {
    const connection = connections.length
    const closed = Promise.withResolvers<void>()
    connections.push({ socket, closed: closed.promise })
    socket.on('close', () => closed.resolve())
    socket.on('error', error => errors.push(error))
    let pending: Buffer = Buffer.alloc(0)
    let identity = ''
    const sendResult = (messageId: number, operation: number, status: number) => {
      const writer = new BerWriter()
      writer.startSequence()
      writer.writeInt(messageId)
      writer.startSequence(operation)
      writer.writeEnumeration(status)
      writer.writeString('')
      writer.writeString(status === 0 ? '' : 'Directory policy denied the request')
      writer.endSequence()
      writer.endSequence()
      socket.write(writer.buffer)
    }
    const sendEntry = (messageId: number, dn: string, attributes: Record<string, string>) => {
      const writer = new BerWriter()
      writer.startSequence()
      writer.writeInt(messageId)
      writer.startSequence(0x64)
      writer.writeString(dn)
      writer.startSequence()
      for (const [name, value] of Object.entries(attributes)) {
        writer.startSequence()
        writer.writeString(name)
        writer.startSequence(0x31)
        writer.writeString(value)
        writer.endSequence()
        writer.endSequence()
      }
      writer.endSequence()
      writer.endSequence()
      writer.endSequence()
      socket.write(writer.buffer)
    }
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      try {
        while (pending.length) {
          const reader = new BerReader(pending)
          if (reader.readSequence(0x30) === null || reader.remain < reader.length) return
          const frameEnd = reader.offset + reader.length
          const messageId = reader.readInt()
          if (messageId === null) throw new Error('Missing LDAP message identifier')
          const operation = reader.readSequence()
          if (operation === 0x60) {
            const bind = new BindRequest({ messageId })
            bind.parse(reader, [])
            events.push({ connection, operation: 'bind', identity: bind.dn })
            const valid = (bind.dn === readerDn && bind.password === (policy.readerPassword ?? 'reader-secret')) ||
              (bind.dn === userDn && bind.password === 'user-secret')
            identity = valid ? bind.dn : ''
            sendResult(messageId, 0x61, valid ? 0 : 49)
          } else if (operation === 0x63) {
            const search = new SearchRequest({ messageId, filter: FilterParser.parseString('(objectClass=*)') })
            search.parse(reader, [])
            events.push({ connection, operation: 'search', identity, base: search.baseDN, filter: search.filter.toString() })
            const canSearch = identity === readerDn || (identity === '' && policy.anonymous !== false)
            if (!canSearch || (search.baseDN === groupBase && policy.denyGroups)) {
              sendResult(messageId, 0x65, 50)
            } else {
              if (search.baseDN === userBase) {
                for (let index = 0; index < (policy.users ?? 1); index++) {
                  sendEntry(messageId, index === 0 ? userDn : 'uid=other,ou=users,dc=example,dc=com', { uid: 'alice' })
                }
              } else if (search.baseDN === groupBase) {
                sendEntry(messageId, 'cn=editors,ou=groups,dc=example,dc=com', { cn: 'editors' })
              } else throw new Error('Unexpected LDAP search base')
              sendResult(messageId, 0x65, 0)
            }
          } else if (operation === 0x42) {
            events.push({ connection, operation: 'unbind', identity })
            socket.end()
          } else throw new Error(`Unexpected LDAP operation: ${operation}`)
          pending = pending.subarray(frameEnd)
        }
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      }
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Directory fixture has no TCP address')
  return {
    url: `ldap://127.0.0.1:${address.port}`,
    events,
    async settled() {
      await Promise.all(connections.map(connection => connection.closed))
      expect(errors).toEqual([])
    },
    async close() {
      for (const connection of connections) connection.socket.destroy()
      const stopped = Promise.withResolvers<void>()
      server.close(error => error ? stopped.reject(error) : stopped.resolve())
      await stopped.promise
    }
  }
}

const authenticate = (url: string, searchBind: Partial<LdapServerOptions> = {}, password = 'user-secret') => {
  const result = Promise.withResolvers<{ profile?: Record<string, unknown>; failure?: unknown; error?: Error }>()
  const strategy = new LdapStrategy({
    server: {
      url,
      timeout: 2_000,
      connectTimeout: 2_000,
      searchBase: userBase,
      searchFilter: '(uid={{username}})',
      groupSearchBase: groupBase,
      groupSearchFilter: '(member={{dn}})',
      groupSearchAttributes: ['cn'],
      ...searchBind
    },
    usernameField: 'email',
    passwordField: 'password',
    passReqToCallback: true
  }, (_request, profile, done) => done(null, profile))
  Object.assign(strategy, {
    success: (profile: Record<string, unknown>) => result.resolve({ profile }),
    fail: (failure: unknown) => result.resolve({ failure }),
    error: (error: Error) => result.resolve({ error })
  })
  strategy.authenticate({ body: { email: 'alice*)(uid=*)', password }, query: {}, params: { strategy: 'directory' } } as LdapRequest)
  return result.promise
}

describe('LDAP installed-client directory boundary', () => {
  for (const searchBind of [{}, { bindDn: '', bindCredentials: '' }, { bindDn: readerDn, bindCredentials: 'reader-secret' }]) {
    it(`authenticates with a separate user bind and keeps groups under the ${searchBind.bindDn ? 'configured' : 'anonymous'} search identity`, async () => {
      const fixture = await directory()
      try {
        const result = await authenticate(fixture.url, searchBind)
        expect(result.profile).toMatchObject({ dn: userDn, _groups: [{ cn: 'editors' }] })
        await fixture.settled()
        const searches = fixture.events.filter(event => event.operation === 'search')
        expect(searches).toHaveLength(2)
        expect(searches.map(event => event.identity)).toEqual([searchBind.bindDn ?? '', searchBind.bindDn ?? ''])
        expect(searches[0]?.filter).toBe('(uid=alice\\2a\\29\\28uid=\\2a\\29)')
        expect(searches[1]?.filter).toBe(`(member=${userDn})`)
        expect(searches[0]?.connection).toBe(searches[1]?.connection)
        const userBind = fixture.events.find(event => event.operation === 'bind' && event.identity === userDn)
        expect(userBind).toBeDefined()
        expect(userBind?.connection).not.toBe(searches[0]?.connection)
        expect(fixture.events.filter(event => event.operation === 'bind').map(event => event.identity)).toEqual(searchBind.bindDn ? [readerDn, userDn] : [userDn])
        expect(fixture.events.filter(event => event.operation === 'unbind')).toHaveLength(2)
      } finally { await fixture.close() }
    })
  }

  for (const scenario of [
    { name: 'anonymous search denial', policy: { anonymous: false }, bind: {}, expectedConnections: 1 },
    { name: 'configured search bind failure without anonymous fallback', policy: {}, bind: { bindDn: readerDn, bindCredentials: 'wrong' }, expectedConnections: 1 },
    { name: 'zero users', policy: { users: 0 }, bind: {}, expectedConnections: 1 },
    { name: 'multiple users', policy: { users: 2 }, bind: {}, expectedConnections: 1 },
    { name: 'group lookup denial after successful user bind', policy: { denyGroups: true }, bind: {}, expectedConnections: 2 }
  ]) {
    it(`fails closed and cleans up on ${scenario.name}`, async () => {
      const fixture = await directory(scenario.policy)
      try {
        const result = await authenticate(fixture.url, scenario.bind)
        expect(result.profile).toBeUndefined()
        expect(result.error ?? result.failure).toBeDefined()
        await fixture.settled()
        expect(fixture.events.filter(event => event.operation === 'unbind')).toHaveLength(scenario.expectedConnections)
        if (scenario.bind.bindDn) expect(fixture.events.filter(event => event.operation === 'search')).toEqual([])
        if (scenario.expectedConnections === 1) expect(fixture.events.some(event => event.operation === 'bind' && event.identity === userDn)).toBe(false)
      } finally { await fixture.close() }
    })
  }

  it('rejects a failed user password bind, skips groups, and closes both real connections', async () => {
    const fixture = await directory()
    try {
      const result = await authenticate(fixture.url, { bindDn: readerDn, bindCredentials: 'reader-secret' }, 'wrong-user-password')
      expect(result).toEqual({ failure: { message: 'Invalid username/password' } })
      await fixture.settled()
      expect(fixture.events.filter(event => event.operation === 'search').map(event => event.base)).toEqual([userBase])
      expect(fixture.events.filter(event => event.operation === 'unbind')).toHaveLength(2)
    } finally { await fixture.close() }
  })

  it('refuses an empty user password without ever contacting the directory', async () => {
    const fixture = await directory()
    try {
      expect(await authenticate(fixture.url, { bindDn: '' }, '')).toEqual({ failure: { message: 'Missing credentials' } })
      expect(fixture.events).toEqual([])
    } finally { await fixture.close() }
  })
})
