import type { SimpleGit } from 'simple-git'

export interface GitRepositoryCommand {
  run(args: readonly string[]): Promise<string>
}

type GitRepositoryClient = SimpleGit | GitRepositoryCommand

export type InterruptedGitOperation = 'merge' | 'rebase'

export interface GitRecoveryLogger {
  warn(message: unknown): void
}

function isCommandRunner (git: GitRepositoryClient): git is GitRepositoryCommand {
  return 'run' in git && typeof git.run === 'function'
}

async function runGit (git: GitRepositoryClient, args: readonly string[]): Promise<string> {
  return isCommandRunner(git) ? git.run(args) : git.raw([...args])
}

function remoteObject (value: string): string {
  if (/^(?:[0-9a-f]{7,64})$/u.test(value) || value.startsWith('origin/')) return value
  return `origin/${value}`
}

const markerExists = async (git: GitRepositoryClient, marker: 'REBASE_HEAD' | 'MERGE_HEAD'): Promise<boolean> => {
  try {
    const output = await runGit(git, ['rev-parse', '--verify', '--quiet', marker])
    return output.trim().length > 0
  } catch {
    return false
  }
}

export const interruptedGitOperation = async (git: GitRepositoryClient): Promise<InterruptedGitOperation | null> => {
  if (await markerExists(git, 'REBASE_HEAD')) return 'rebase'
  if (await markerExists(git, 'MERGE_HEAD')) return 'merge'
  return null
}

export const recoverInterruptedGitOperation = async (
  git: GitRepositoryClient,
  logger: GitRecoveryLogger
): Promise<InterruptedGitOperation | null> => {
  const interrupted = await interruptedGitOperation(git)
  if (!interrupted) return null
  logger.warn(`(STORAGE/GIT) Rolling back an unfinished ${interrupted}...`)
  await runGit(git, [interrupted, '--abort'])
  return interrupted
}

const unmergedPaths = async (git: GitRepositoryClient): Promise<string[]> => {
  const output = await runGit(git, ['diff', '--name-only', '--diff-filter=U', '-z'])
  const paths = output.split('\0')
  if (paths.at(-1) === '') paths.pop()
  if (paths.some(relativePath => relativePath.includes('\0'))) throw new Error('Git returned an invalid conflict path')
  return paths.filter(Boolean)
}

export const pullRemoteAuthoritative = async (
  git: GitRepositoryClient,
  remoteRevision: string,
  logger: GitRecoveryLogger
): Promise<string[]> => {
  const remoteObjectId = remoteObject(remoteRevision)
  try {
    await runGit(git, ['rebase', '--autostash', remoteObjectId])
    return []
  } catch (error) {
    const conflicted = await unmergedPaths(git)
    await recoverInterruptedGitOperation(git, logger)
    if (conflicted.length === 0) throw error

    logger.warn(
      `(STORAGE/GIT) ${conflicted.length} path(s) conflict with ${remoteObjectId}; taking the remote version...`
    )
    try {
      // During a rebase, "ours" is the fetched branch and "theirs" is the local commit being replayed.
      await runGit(git, ['rebase', '--autostash', '-X', 'ours', remoteObjectId])
    } catch (retryError) {
      const unsettled = await unmergedPaths(git)
      await recoverInterruptedGitOperation(git, logger)
      if (unsettled.length === 0) throw retryError
      const paths = `${unsettled.slice(0, 5).join(', ')}${unsettled.length > 5 ? ', ...' : ''}`
      throw new Error(
        `(STORAGE/GIT) ${paths} changed on one side and were deleted on the other. The rebase was rolled back, so the repository remains usable. Purge Local Repository takes the remote version; Force Sync in Push mode takes the wiki version.`,
        { cause: retryError }
      )
    }
    return conflicted
  }
}

export const sharesHistoryWith = async (git: GitRepositoryClient, remoteRevision: string): Promise<boolean> => runGit(git, [
  'merge-base',
  'HEAD',
  remoteObject(remoteRevision)
])
  .then(output => output.trim().length > 0)
  .catch(() => false)

export const reattachUnrelatedHistory = async (
  git: GitRepositoryClient,
  remoteRevision: string,
  logger: GitRecoveryLogger
): Promise<void> => {
  const remoteObjectId = remoteObject(remoteRevision)
  logger.warn(`(STORAGE/GIT) Local history is unrelated to ${remoteObjectId}; reattaching it...`)
  try {
    await runGit(git, [
      'merge',
      '--allow-unrelated-histories',
      '-X',
      'ours',
      '--no-edit',
      '-m',
      `chore: reconcile the working copy with ${remoteObjectId}`,
      remoteObjectId
    ])
  } catch (error) {
    await recoverInterruptedGitOperation(git, logger)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `(STORAGE/GIT) The working copy has no history in common with ${remoteObjectId}, and reattaching it failed: ${message}. Purge Local Repository starts again from the remote copy.`,
      { cause: error }
    )
  }
}

