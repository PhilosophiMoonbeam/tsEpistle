import path from 'node:path'
import fs from 'fs-extra'
import type { SimpleGit } from 'simple-git'

export type InterruptedGitOperation = 'merge' | 'rebase'

export interface GitRecoveryLogger {
  warn(message: unknown): void
}

export const interruptedGitOperation = async (git: SimpleGit): Promise<InterruptedGitOperation | null> => {
  const gitDir = (await git.revparse(['--absolute-git-dir'])).trim()
  if (
    await fs.pathExists(path.join(gitDir, 'rebase-merge')) ||
    await fs.pathExists(path.join(gitDir, 'rebase-apply'))
  ) return 'rebase'
  return await fs.pathExists(path.join(gitDir, 'MERGE_HEAD')) ? 'merge' : null
}

export const recoverInterruptedGitOperation = async (
  git: SimpleGit,
  logger: GitRecoveryLogger
): Promise<InterruptedGitOperation | null> => {
  const interrupted = await interruptedGitOperation(git)
  if (!interrupted) return null
  logger.warn(`(STORAGE/GIT) Rolling back an unfinished ${interrupted}...`)
  await git.raw([interrupted, '--abort'])
  return interrupted
}

const unmergedPaths = async (git: SimpleGit): Promise<string[]> => {
  const output = await git.raw(['diff', '--name-only', '--diff-filter=U', '-z'])
  return output.split('\0').filter(Boolean)
}

export const pullRemoteAuthoritative = async (
  git: SimpleGit,
  branch: string,
  logger: GitRecoveryLogger
): Promise<string[]> => {
  const options = ['--rebase', '--autostash']
  try {
    await git.pull('origin', branch, options)
    return []
  } catch (error) {
    const conflicted = await unmergedPaths(git)
    await recoverInterruptedGitOperation(git, logger)
    if (conflicted.length === 0) throw error

    logger.warn(
      `(STORAGE/GIT) ${conflicted.length} path(s) conflict with origin/${branch}; taking the remote version...`
    )
    try {
      // During a rebase, "ours" is the fetched branch and "theirs" is the local commit being replayed.
      await git.pull('origin', branch, [...options, '-X', 'ours'])
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

export const sharesHistoryWith = async (git: SimpleGit, remoteBranch: string): Promise<boolean> => git
  .raw(['merge-base', 'HEAD', remoteBranch])
  .then(output => output.trim().length > 0)
  .catch(() => false)

export const reattachUnrelatedHistory = async (
  git: SimpleGit,
  branch: string,
  logger: GitRecoveryLogger
): Promise<void> => {
  const remoteBranch = `origin/${branch}`
  logger.warn(`(STORAGE/GIT) Local history is unrelated to ${remoteBranch}; reattaching it...`)
  try {
    await git.raw([
      'merge',
      '--allow-unrelated-histories',
      '-X',
      'ours',
      '--no-edit',
      '-m',
      `chore: reconcile the working copy with ${remoteBranch}`,
      remoteBranch
    ])
  } catch (error) {
    await recoverInterruptedGitOperation(git, logger)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `(STORAGE/GIT) The working copy has no history in common with ${remoteBranch}, and reattaching it failed: ${message}. Purge Local Repository starts again from the remote copy.`,
      { cause: error }
    )
  }
}
