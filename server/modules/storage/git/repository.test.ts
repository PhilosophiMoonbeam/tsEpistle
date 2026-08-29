import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import {
  pullRemoteAuthoritative,
  reattachUnrelatedHistory,
  sharesHistoryWith
} from './repository.ts'

const roots: string[] = []

const temporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-git-storage-'))
  roots.push(root)
  return root
}

const configureAuthor = async (git: SimpleGit): Promise<void> => {
  await git.addConfig('user.name', 'Wiki Test')
  await git.addConfig('user.email', 'wiki@example.test')
}

const initializeWorkingRepository = async (directory: string): Promise<SimpleGit> => {
  await fs.ensureDir(directory)
  const git = simpleGit(directory)
  await git.init()
  await git.raw(['checkout', '-b', 'main'])
  await configureAuthor(git)
  return git
}

const commitFile = async (
  git: SimpleGit,
  directory: string,
  file: string,
  content: string,
  message: string
): Promise<void> => {
  await fs.outputFile(path.join(directory, file), content)
  await git.add(file)
  await git.commit(message)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.remove(root)))
})

describe('Git storage repository recovery', () => {
  it('resolves a rebase conflict toward the remote and leaves the working copy writable', async () => {
    const root = await temporaryRoot()
    const remote = path.join(root, 'remote.git')
    await simpleGit(root).raw(['init', '--bare', '--initial-branch=main', remote])

    const writerDir = path.join(root, 'writer')
    const writer = await initializeWorkingRepository(writerDir)
    await commitFile(writer, writerDir, 'page.md', 'base\n', 'base')
    await writer.addRemote('origin', remote)
    await writer.push(['--set-upstream', 'origin', 'main'])

    const localDir = path.join(root, 'local')
    await simpleGit(root).clone(remote, localDir)
    const local = simpleGit(localDir)
    await configureAuthor(local)
    await commitFile(local, localDir, 'page.md', 'local\n', 'local edit')

    await commitFile(writer, writerDir, 'page.md', 'remote\n', 'remote edit')
    await writer.push('origin', 'main')

    const logger = { warn: vi.fn() }
    await expect(pullRemoteAuthoritative(local, 'main', logger)).resolves.toEqual(['page.md'])
    await expect(fs.readFile(path.join(localDir, 'page.md'), 'utf8')).resolves.toBe('remote\n')
    expect((await local.status()).conflicted).toEqual([])

    await commitFile(local, localDir, 'after.md', 'still writable\n', 'prove recovery')
    expect((await local.log({ maxCount: 1 })).latest?.message).toBe('prove recovery')
  })

  it('merges unrelated remote history without replacing newer wiki files', async () => {
    const root = await temporaryRoot()
    const remote = path.join(root, 'remote.git')
    await simpleGit(root).raw(['init', '--bare', '--initial-branch=main', remote])

    const writerDir = path.join(root, 'writer')
    const writer = await initializeWorkingRepository(writerDir)
    await commitFile(writer, writerDir, 'shared.md', 'remote version\n', 'remote root')
    await commitFile(writer, writerDir, 'remote-only.md', 'from remote\n', 'remote content')
    await writer.addRemote('origin', remote)
    await writer.push(['--set-upstream', 'origin', 'main'])

    const localDir = path.join(root, 'local')
    const local = await initializeWorkingRepository(localDir)
    await commitFile(local, localDir, 'shared.md', 'wiki version\n', 'wiki root')
    await commitFile(local, localDir, 'local-only.md', 'from wiki\n', 'wiki content')
    await local.addRemote('origin', remote)
    await local.fetch('origin', 'main')

    expect(await sharesHistoryWith(local, 'origin/main')).toBe(false)
    await reattachUnrelatedHistory(local, 'main', { warn: vi.fn() })

    expect(await sharesHistoryWith(local, 'origin/main')).toBe(true)
    await expect(fs.readFile(path.join(localDir, 'shared.md'), 'utf8')).resolves.toBe('wiki version\n')
    await expect(fs.readFile(path.join(localDir, 'remote-only.md'), 'utf8')).resolves.toBe('from remote\n')
    await expect(fs.readFile(path.join(localDir, 'local-only.md'), 'utf8')).resolves.toBe('from wiki\n')
  })
})
