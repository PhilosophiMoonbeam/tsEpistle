import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  copyBounded,
  openStorageRoot,
  StorageFilesystemError,
  type StorageRootHandle
} from '../../modules/storage/local-filesystem.ts'
import { ImportBudget } from '../../modules/storage/import-budget.ts'
import {
  isStorageGitMetadataPath,
  isStorageInternalPath,
  isStorageReservedPath,
  isStorageTemporaryPath
} from '../../modules/storage/internal-path.ts'

describe('descriptor-confined local filesystem', () => {
  let temporaryRoot: string
  let storageRootPath: string
  let outsideRoot: string
  let storage: StorageRootHandle

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tsepistle-local-filesystem-'))
    storageRootPath = path.join(temporaryRoot, 'storage')
    outsideRoot = path.join(temporaryRoot, 'outside')
    await fs.mkdir(storageRootPath)
    await fs.mkdir(outsideRoot)
    storage = await openStorageRoot(storageRootPath)
  })

  afterEach(async () => {
    await storage.close()
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  })

  it('reads tiny files with large bounds and copies through descriptors without speculative allocation', async () => {
    await storage.ensureDirectory('nested/deep')
    await storage.writeAtomic('nested/deep/value.txt', 'descriptor bytes')

    const source = await storage.openFile('nested/deep/value.txt')
    expect(source.relativePath).toBe('nested/deep/value.txt')
    expect(Object.hasOwn(source, 'path')).toBe(false)
    const largeLimit = 300 * 1024 * 1024
    expect(await source.readBounded(largeLimit)).toEqual(Buffer.from('descriptor bytes'))
    await expect(source.readBounded(3)).rejects.toThrow(/exceeds 3 bytes/u)

    const destinationPath = path.join(temporaryRoot, 'copy.bin')
    const destination = await fs.open(destinationPath, 'wx', 0o600)
    try {
      expect(await copyBounded(source, destination, largeLimit)).toBe('descriptor bytes'.length)
    } finally {
      await destination.close()
    }
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('descriptor bytes')

    await source.close()
    await source.close()
    expect(source.closed).toBe(true)
    await expect(source.readBounded(largeLimit)).rejects.toMatchObject({ code: 'STORAGE_HANDLE_CLOSED' })
  })

  it('accepts empty files and rejects growth during a bounded read', async () => {
    await storage.writeAtomic('empty.txt', Buffer.alloc(0))
    const empty = await storage.openFile('empty.txt')
    expect(await empty.readBounded(0)).toEqual(Buffer.alloc(0))
    await empty.close()

    const growingPath = path.join(storageRootPath, 'growing.txt')
    await fs.writeFile(growingPath, 'seed')
    const growing = await storage.openFile('growing.txt')
    const originalStat = growing.handle.stat.bind(growing.handle)
    let statCalls = 0
    Object.defineProperty(growing.handle, 'stat', {
      value: async () => {
        const stats = await originalStat()
        if (++statCalls === 1) await fs.appendFile(growingPath, '-growth')
        return stats
      }
    })
    try {
      await expect(growing.readBounded(64)).rejects.toThrow(/grew during bounded read|changed during bounded read/u)
    } finally {
      await growing.close()
    }
  })

  it('atomically replaces regular files and cleans a failed temporary replacement', async () => {
    await storage.writeAtomic('target.txt', 'old bytes')
    await storage.writeAtomic('target.txt', 'new bytes')
    expect(await fs.readFile(path.join(storageRootPath, 'target.txt'), 'utf8')).toBe('new bytes')

    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.writeFile(outsideSentinel, 'outside remains')
    await fs.symlink(outsideSentinel, path.join(storageRootPath, 'blocked.txt'))
    await expect(storage.writeAtomic('blocked.txt', 'must not follow')).rejects.toBeInstanceOf(StorageFilesystemError)
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
    expect((await fs.readdir(storageRootPath)).some(name => name.includes('.blocked.txt.') && name.endsWith('.tmp'))).toBe(false)

    await expect(storage.writeAtomic('../outside.txt', 'traversal')).rejects.toThrow()
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })

  it('rejects symlink leaves, symlink parents, broken links, FIFOs, and absolute or noncanonical paths', async () => {
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.writeFile(outsideSentinel, 'do not disclose or remove')
    await fs.mkdir(path.join(outsideRoot, 'nested'))
    await fs.writeFile(path.join(outsideRoot, 'nested', 'secret.txt'), 'secret')

    await fs.symlink(outsideSentinel, path.join(storageRootPath, 'leaf-link'))
    await fs.symlink(path.join(outsideRoot, 'nested'), path.join(storageRootPath, 'parent-link'))
    await fs.symlink(path.join(outsideRoot, 'missing.txt'), path.join(storageRootPath, 'broken-link'))
    const fifoPath = path.join(storageRootPath, 'pipe')
    execFileSync('mkfifo', [fifoPath])

    for (const relativePath of ['leaf-link', 'broken-link', 'pipe']) {
      await expect(storage.openFile(relativePath)).rejects.toThrow()
      await expect(storage.removeFile(relativePath)).rejects.toThrow()
      await expect(storage.writeAtomic(relativePath, 'must reject')).rejects.toThrow()
    }
    await expect(storage.openFile('parent-link/secret.txt')).rejects.toThrow()
    await expect(storage.writeAtomic('parent-link/new.txt', 'must reject')).rejects.toThrow()
    await expect(storage.ensureDirectory('parent-link/new-dir')).rejects.toThrow()

    for (const relativePath of ['../escape', '/tmp/escape', 'a//b', 'a/./b', 'a/../b', 'C:\\escape']) {
      await expect(storage.openFile(relativePath)).rejects.toThrow()
      await expect(storage.writeAtomic(relativePath, 'must reject')).rejects.toThrow()
    }
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('do not disclose or remove')
    expect(await fs.readFile(path.join(outsideRoot, 'nested', 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('rejects parent substitution during later operations without reading outside content', async () => {
    await fs.mkdir(path.join(storageRootPath, 'stable'))
    await fs.writeFile(path.join(outsideRoot, 'secret.txt'), 'outside secret')
    await fs.rename(path.join(storageRootPath, 'stable'), path.join(storageRootPath, 'stable-real'))
    await fs.symlink(outsideRoot, path.join(storageRootPath, 'stable'))

    await expect(storage.openFile('stable/secret.txt')).rejects.toThrow()
    await expect(storage.writeAtomic('stable/new.txt', 'must reject')).rejects.toThrow()
    await expect(storage.removeFile('stable/secret.txt')).rejects.toThrow()
    expect(await fs.readFile(path.join(outsideRoot, 'secret.txt'), 'utf8')).toBe('outside secret')
  })

  it('moves and removes only regular files inside the same descriptor-confined root', async () => {
    await storage.ensureDirectory('moves')
    await storage.writeAtomic('moves/source.txt', 'move me')
    await storage.writeAtomic('moves/destination.txt', 'replace me')
    expect(await storage.move('moves/source.txt', 'moves/destination.txt')).toBe(true)
    expect(await fs.readFile(path.join(storageRootPath, 'moves/destination.txt'), 'utf8')).toBe('move me')
    await expect(storage.openFile('moves/source.txt')).rejects.toThrow()
    expect(await storage.removeFile('moves/destination.txt')).toBe(true)
    expect(await storage.removeFile('moves/destination.txt')).toBe(false)

    await fs.writeFile(path.join(outsideRoot, 'outside.txt'), 'outside')
    await fs.symlink(path.join(outsideRoot, 'outside.txt'), path.join(storageRootPath, 'destination-link'))
    await storage.writeAtomic('moves/source.txt', 'safe source')
    await expect(storage.move('moves/source.txt', 'destination-link')).rejects.toThrow()
    expect(await fs.readFile(path.join(outsideRoot, 'outside.txt'), 'utf8')).toBe('outside')
    expect(await fs.readFile(path.join(storageRootPath, 'moves/source.txt'), 'utf8')).toBe('safe source')
  })

  it('walks without following links and purges link entries themselves', async () => {
    await storage.ensureDirectory('tree/child')
    await storage.writeAtomic('tree/child/file.txt', 'inside')
    await fs.writeFile(path.join(outsideRoot, 'sentinel.txt'), 'outside')
    await fs.symlink(outsideRoot, path.join(storageRootPath, 'tree', 'outside-link'))

    const inventory = await Array.fromAsync(storage.walk({ rejectUnsafe: false }))
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'tree', kind: 'directory' }),
      expect.objectContaining({ relativePath: 'tree/child/file.txt', kind: 'file' }),
      expect.objectContaining({ relativePath: 'tree/outside-link', kind: 'symlink' })
    ]))
    await expect(Array.fromAsync(storage.walk())).rejects.toThrow()

    await storage.purgeContents()
    expect(await fs.readdir(storageRootPath)).toEqual([])
    expect(await fs.readFile(path.join(outsideRoot, 'sentinel.txt'), 'utf8')).toBe('outside')

    const fifoPath = path.join(storageRootPath, 'unsafe-pipe')
    execFileSync('mkfifo', [fifoPath])
    await expect(storage.purgeContents()).rejects.toThrow()
    expect((await fs.stat(fifoPath)).isFIFO()).toBe(true)
  })
  it('stops walking before consuming a wide directory when admission rejects', async () => {
    const fileCount = 128
    await Promise.all(Array.from({ length: fileCount }, (_, index) =>
      fs.writeFile(path.join(storageRootPath, `wide-${index}.txt`), 'entry')
    ))
    const budget = new ImportBudget(4, Number.MAX_SAFE_INTEGER)
    let inspected = 0
    await expect(Array.fromAsync(storage.walk({
      shouldSkip: () => {
        inspected += 1
        return false
      },
      admit: entry => budget.reserve(entry.kind === 'file' ? entry.identity.size : 0)
    }))).rejects.toThrow(/4-entry limit/u)
    expect(inspected).toBeLessThan(fileCount)

    await storage.purgeContents()
    expect(await fs.readdir(storageRootPath)).toEqual([])
  })

  it('prunes Git metadata before inspecting or descending into it', async () => {
    await storage.ensureDirectory('safe/nested')
    await storage.writeAtomic('safe/nested/content.txt', 'safe content')
    await storage.ensureDirectory('.GIT/objects')
    await fs.writeFile(path.join(storageRootPath, '.GIT', 'config'), 'not content')
    execFileSync('mkfifo', [path.join(storageRootPath, '.GIT', 'objects', 'unsafe-pipe')])

    const entries = await Array.fromAsync(storage.walk({ shouldSkip: isStorageGitMetadataPath }))
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'safe/nested/content.txt', kind: 'file' })
    ]))
    expect(entries.some(entry => isStorageGitMetadataPath(entry.relativePath))).toBe(false)
  })

  it('streams atomic output with cap enforcement and producer cleanup', async () => {
    await storage.writeAtomic('stream.txt', 'old bytes')
    let successfulClosed = false
    async function *successfulChunks (): AsyncGenerator<Uint8Array> {
      try {
        yield Buffer.from('new ')
        yield Buffer.from('bytes')
      } finally {
        successfulClosed = true
      }
    }
    await storage.writeAtomicStream('stream.txt', successfulChunks(), 32)
    expect(await fs.readFile(path.join(storageRootPath, 'stream.txt'), 'utf8')).toBe('new bytes')
    expect((await fs.stat(path.join(storageRootPath, 'stream.txt'))).mode & 0o777).toBe(0o600)
    expect(successfulClosed).toBe(true)

    let failedClosed = false
    async function *failingChunks (): AsyncGenerator<Uint8Array> {
      try {
        yield Buffer.from('partial')
        throw new Error('producer failed')
      } finally {
        failedClosed = true
      }
    }
    await expect(storage.writeAtomicStream('stream.txt', failingChunks(), 32)).rejects.toThrow('producer failed')
    expect(failedClosed).toBe(true)
    expect(await fs.readFile(path.join(storageRootPath, 'stream.txt'), 'utf8')).toBe('new bytes')

    let cappedClosed = false
    async function *cappedChunks (): AsyncGenerator<Uint8Array> {
      try {
        yield Buffer.from('too large')
      } finally {
        cappedClosed = true
      }
    }
    await expect(storage.writeAtomicStream('stream.txt', cappedChunks(), 3)).rejects.toThrow(/exceeds 3 bytes/u)
    expect(cappedClosed).toBe(true)
    expect(await fs.readFile(path.join(storageRootPath, 'stream.txt'), 'utf8')).toBe('new bytes')
    expect((await fs.readdir(storageRootPath)).some(name => name.includes('.stream.txt.') && name.endsWith('.tmp'))).toBe(false)
  })
  it('classifies only established internal namespaces', () => {
    expect(isStorageInternalPath('.GIT/config')).toBe(true)
    expect(isStorageInternalPath('nested/.git/hooks')).toBe(true)
    expect(isStorageInternalPath('_daily/archive.tar.gz')).toBe(true)
    expect(isStorageInternalPath('docs/_daily/notes.txt')).toBe(false)
    expect(isStorageReservedPath('docs/_manual/notes.txt')).toBe(false)
    expect(isStorageInternalPath('ordinary.daily')).toBe(false)
    expect(isStorageTemporaryPath('.target.txt.123.123e4567-e89b-42d3-a456-426614174000.tmp')).toBe(true)
  })
})
