import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Server, Client } from 'ssh2'
import { describe, it, expect } from '../bun-test.mts'
import { gitStorageSshCommand, gitStorageHttpRemote, writeGitStorageConnectionFile } from '../../modules/storage/git/connection.ts'
import { storageHostVerifier } from '../../modules/storage/sftp/host-key.ts'

describe('Storage SSH trust and Git connection files', () => {
  it('encodes complete HTTP credential components and rejects credentials hidden in the repository address', () => {
    const username = 'user@name:/%40',
      password = 'pass@word:/?#%25'
    const url = new URL(gitStorageHttpRemote('https://git.example.test/team/repo.git', username, password))
    expect(url.hostname).toBe('git.example.test')
    expect(url.pathname).toBe('/team/repo.git')
    expect(decodeURIComponent(url.username)).toBe(username)
    expect(decodeURIComponent(url.password)).toBe(password)
    expect(gitStorageHttpRemote('git.example.test/team/repo.git', '', '')).toBe('https://git.example.test/team/repo.git')
    expect(() => gitStorageHttpRemote('https://hidden:credential@git.example.test/repo', 'user', 'pass')).toThrow()
    expect(() => gitStorageHttpRemote('ftp://git.example.test/repo', 'user', 'pass')).toThrow()
    expect(() => gitStorageSshCommand('/keys/$(command)')).toThrow()
  })

  it('publishes private connection files by replacement and repairs an existing loose file mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'storage-ssh-files-'))
    try {
      const file = await writeGitStorageConnectionFile(root, 'git-ssh.pem', 'fixture-key')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      await rm(file)
      await writeFile(file, 'old', { mode: 0o644 })
      expect(await writeGitStorageConnectionFile(root, 'git-ssh.pem', 'replacement')).toBe(file)
      expect(await readFile(file, 'utf8')).toBe('replacement\n')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('verifies real local SSH handshakes before authentication, including literal spaces, quotes and percent signs in paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "storage-ssh '100%-")),
      clients = new Set<{ end(): unknown }>()
    let server: Server | undefined,
      authentications = 0
    try {
      const identity = path.join(root, 'identity'),
        hostKey = path.join(root, 'host')
      for (const file of [identity, hostKey]) execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', file], { stdio: 'ignore' })
      const publicKey = (await readFile(hostKey + '.pub', 'utf8')).trim().split(' ').slice(0, 2).join(' ')
      const identityKey = Buffer.from((await readFile(identity + '.pub', 'utf8')).split(' ')[1]!, 'base64')
      const rawKey = Buffer.from(publicKey.split(' ')[1]!, 'base64'),
        fingerprint = 'SHA256:' + createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')
      server = new Server({ hostKeys: [await readFile(hostKey)] }, client => {
        clients.add(client)
        client.on('error', () => {})
        client.on('close', () => clients.delete(client))
        client.on('authentication', ctx => {
          authentications++
          if ((ctx.method === 'publickey' && ctx.key.data.equals(identityKey)) || (ctx.method === 'password' && ctx.password === 'fixture-password'))
            ctx.accept()
          else ctx.reject()
        })
        client.on('ready', () =>
          client.on('session', accept =>
            accept().on('exec', accept => {
              const stream = accept()
              stream.exit(0)
              stream.end()
            })
          )
        )
      })
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(0, '127.0.0.1', resolve)
      })
      const port = (server.address() as { port: number }).port
      const known = await writeGitStorageConnectionFile(root, 'git-known-hosts', `[127.0.0.1]:${port} ${publicKey}`)
      const command = gitStorageSshCommand(identity, known)
      const connectGit = async () => {
        const child = Bun.spawn(['/bin/sh', '-c', `${command} -p ${port} -o ConnectTimeout=2 -o LogLevel=ERROR 127.0.0.1 true`], {
          stdout: 'pipe',
          stderr: 'pipe'
        })
        const stderr = await new Response(child.stderr).text()
        return { status: await child.exited, stderr }
      }
      expect((await connectGit()).status).toBe(0)
      const authenticated = authentications
      await writeGitStorageConnectionFile(root, 'git-known-hosts', `[127.0.0.1]:${port} ${(await readFile(identity + '.pub', 'utf8')).trim()}`)
      expect((await connectGit()).status).toBe(255)
      expect(authentications).toBe(authenticated)
      await writeGitStorageConnectionFile(root, 'git-known-hosts', '')
      expect((await connectGit()).status).toBe(255)
      expect(authentications).toBe(authenticated)

      const connectSftpTransport = (pin: string) =>
        new Promise<boolean>(resolve => {
          const client = new Client()
          client.once('ready', () => {
            client.end()
            resolve(true)
          })
          client.once('error', () => {
            client.end()
            resolve(false)
          })
          client.connect({
            host: '127.0.0.1',
            port,
            username: 'fixture',
            password: 'fixture-password',
            readyTimeout: 2000,
            hostVerifier: storageHostVerifier(pin)
          })
        })
      expect(await connectSftpTransport(fingerprint)).toBe(true)
      const afterVerified = authentications
      expect(await connectSftpTransport('SHA256:' + 'A'.repeat(43))).toBe(false)
      expect(authentications).toBe(afterVerified)
      expect(() => storageHostVerifier('')).toThrow()
      expect(() => storageHostVerifier('SHA256:invalid')).toThrow()
    } finally {
      for (const client of clients) client.end()
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
})
