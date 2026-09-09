import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { openStorageRoot } from '../local-filesystem.ts'

const shellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const gitStorageSshCommand = (identityPath: string, knownHostsPath?: string): string => {
  // OpenSSH expands percent tokens after the shell has parsed its arguments.
  const literalPath = (value: string) => {
    if (!value || /["`$\r\n\0]/.test(value)) throw new Error('The SSH file path contains unsupported command characters.')
    return value.replaceAll('%', '%%')
  }
  const optionPath = (value: string) => `"${literalPath(value).replaceAll('\\', '\\\\')}"`
  const args = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', `IdentityFile=${optionPath(identityPath)}`]
  if (knownHostsPath) args.push('-o', `UserKnownHostsFile=${optionPath(knownHostsPath)}`, '-o', 'GlobalKnownHostsFile=/dev/null')
  return args.map(shellArgument).join(' ')
}

export const gitStorageHttpRemote = (address: string, username: string, password: string): string => {
  const url = new URL(address.includes('://') ? address : `https://${address}`)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new Error('Use an HTTP(S) repository address without embedded credentials, query or fragment.')
  url.username = encodeURIComponent(username)
  url.password = encodeURIComponent(password)
  return url.toString()
}

export const writeGitStorageConnectionFile = async (
  dataPath: string,
  name: 'git-ssh.pem' | 'git-known-hosts',
  contents: string
): Promise<string> => {
  await mkdir(dataPath, { recursive: true, mode: 0o700 })
  const root = await openStorageRoot(dataPath)
  try {
    await root.writeAtomic(`secure/${name}`, contents.endsWith('\n') ? contents : `${contents}\n`)
  } finally {
    await root.close()
  }
  return path.resolve(dataPath, 'secure', name)
}
