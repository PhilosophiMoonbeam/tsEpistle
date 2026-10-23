import { execFileSync } from 'node:child_process'
import { describe, it, expect } from '../server/test/bun-test.mts'
import { isStorageGitBranchName, isStorageHostKeyFingerprint, storageConfigurationIssues, storageActionDefinition } from './storage-workspace.ts'
describe('Storage configuration and effect contracts', () => {
  it('matches Git literal branch validation including components, Unicode and option-like input', () => {
    for (const name of [
      'main',
      'release/next',
      '@',
      'foo]bar',
      'foo\u00a0bar',
      'a./b',
      '-bad',
      'foo bar',
      'foo\x7fbar',
      '.hidden',
      'a/.hidden',
      'a.lock/b',
      '/foo',
      'foo//bar',
      'foo/',
      'foo..bar',
      'foo~bar',
      'foo^bar',
      'foo:bar',
      'foo?bar',
      'foo*bar',
      'foo[bar',
      'foo\\bar',
      'foo@{bar',
      'foo.',
      'foo.lock',
      'main\n'
    ]) {
      let valid = true
      try {
        execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' })
      } catch {
        valid = false
      }
      expect(isStorageGitBranchName(name)).toBe(valid)
    }
    expect(isStorageGitBranchName('@{-1}')).toBe(false)
    expect(isStorageGitBranchName('a'.repeat(255))).toBe(true)
    for (const name of ['a'.repeat(256), Array(10).fill('a'.repeat(30)).join('/')]) {
      execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' })
      expect(isStorageGitBranchName(name)).toBe(false)
    }
  })
  it('describes real archive and Git recreation effects, without promising a full workspace backup', () => {
    expect(storageActionDefinition('disk', 'backup')?.effect).toContain('does not first refresh files from the database')
    expect(storageActionDefinition('git', 'purge')?.effect).toContain('ensuing synchronization can affect the remote repository')
    expect(storageActionDefinition('git', 'syncUntracked')?.effect).toContain('overwritten')
    expect(storageActionDefinition('s3', 'purge')).toBeNull()
  })
  it('permits the bundled S3 runtime credential provider and requires complete explicit credential pairs', () => {
    const target = { key: 's3', config: { bucket: 'wiki', region: 'us-east-1', accessKeyId: '' }, secrets: { secretAccessKey: false } }
    expect(storageConfigurationIssues(target)).toEqual([])
    target.config.accessKeyId = 'key'
    expect(storageConfigurationIssues(target)).toHaveLength(1)
    target.secrets.secretAccessKey = true
    expect(storageConfigurationIssues(target)).toEqual([])
  })
  it('permits explicit S3-compatible signing regions and retains runtime resolution when omitted', () => {
    for (const key of ['s3generic', 'digitalocean']) {
      const target = { key, config: { bucket: 'wiki', endpoint: 'https://objects.example.test', region: '' }, secrets: {} }
      expect(storageConfigurationIssues(target)).toEqual([])
      target.config.region = 'auto'
      expect(storageConfigurationIssues(target)).toEqual([])
      target.config.region = 'us-east-1\n'
      expect(storageConfigurationIssues(target)).toContain('region must not contain control characters.')
    }
  })
  it('requires a canonical server fingerprint before SFTP can be enabled', () => {
    const target = {
      key: 'sftp',
      config: { host: 'example.test', port: 22, username: 'wiki', basePath: '/wiki', authMode: 'password', hostKeyFingerprint: '' },
      secrets: { password: true }
    }
    expect(storageConfigurationIssues(target)).toContain('Provide the server’s verified SHA256 host-key fingerprint.')
    target.config.hostKeyFingerprint = 'SHA256:' + 'A'.repeat(43)
    expect(storageConfigurationIssues(target)).toEqual([])
    expect(isStorageHostKeyFingerprint(target.config.hostKeyFingerprint + '=')).toBe(true)
    expect(isStorageHostKeyFingerprint('SHA256:' + 'A'.repeat(42) + 'B')).toBe(false)
    expect(isStorageHostKeyFingerprint('SHA256:' + 'A'.repeat(44))).toBe(false)
  })
  it('rejects command interpolation in key paths and preserves literal branch validation', () => {
    const target = {
      key: 'git',
      config: {
        repoUrl: 'git@example.test:wiki/repo.git',
        branch: 'main',
        localRepoPath: './data/repo',
        defaultName: 'Wiki',
        defaultEmail: 'wiki@example.test',
        authType: 'ssh',
        sshPrivateKeyMode: 'path',
        sshPrivateKeyPath: '/keys/wiki'
      },
      secrets: {}
    }
    expect(storageConfigurationIssues(target)).toEqual([])
    target.config.sshPrivateKeyPath = '/keys/$(command)'
    expect(storageConfigurationIssues(target)).toContain('The private-key path contains unsupported command characters.')
    target.config.sshPrivateKeyPath = '/keys/wiki'
    target.config.branch = ' main '
    expect(storageConfigurationIssues(target)).toContain('Enter a valid Git branch name.')
  })
  it('matches the selected Git authentication transport while preserving SSH and intentional local remotes', () => {
    const target = {
      key: 'git',
      config: {
        repoUrl: '',
        branch: 'main',
        localRepoPath: './data/repo',
        defaultName: 'Wiki',
        defaultEmail: 'wiki@example.test',
        authType: 'ssh',
        sshPrivateKeyMode: 'path',
        sshPrivateKeyPath: '/keys/wiki'
      },
      secrets: {}
    }
    for (const address of [
      'git@alias:team/repo.git',
      "alias:team/quoted 'repository'.git",
      'git@[::1]:team/repo.git',
      'ssh://git@[::1]:2222/team/repo.git',
      'ssh://alias:2222/team/repo.git',
      "/tmp/quoted 'repository'.git",
      './local/repo.git',
      './local:repo.git',
      '../local/repo.git',
      'bare-repository.git',
      '  git@alias:team/repo.git  ',
      'file:///tmp/repo.git'
    ]) {
      target.config.repoUrl = address
      expect(storageConfigurationIssues(target)).toEqual([])
    }
    for (const address of ['https://git.example.test/repo.git', 'http://git.example.test/repo.git', 'git://alias/repo', 'https::repo', 'ssh://']) {
      target.config.repoUrl = address
      expect(storageConfigurationIssues(target)).toHaveLength(1)
    }
    target.config.authType = 'basic'
    for (const address of ['https://git.example.test/repo.git', 'http://git.example.test/repo.git', 'git.example.test/repo.git']) {
      target.config.repoUrl = address
      expect(storageConfigurationIssues(target)).toEqual([])
    }
    for (const address of [
      'ssh://git@alias/repo.git',
      'git@alias:repo.git',
      'file:///tmp/repo.git',
      'https://user:password@git.example.test/repo.git',
      'https://git.example.test/repo.git?query',
      'https://git.example.test/repo.git#fragment'
    ]) {
      target.config.repoUrl = address
      expect(storageConfigurationIssues(target)).toHaveLength(1)
    }
    target.config.repoUrl = 'https://git.example.test/repo.git'
    target.config.branch = Array(10).fill('a'.repeat(30)).join('/')
    expect(storageConfigurationIssues(target)).toEqual(['Enter a valid Git branch name.'])
  })
})
