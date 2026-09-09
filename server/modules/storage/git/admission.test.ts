import { describe, expect, it, vi } from '../../../test/bun-test.mts'
import type { GitNativeCommand } from './admission.ts'

vi.mockModule('../../../helpers/page.ts', import.meta.url, () => ({
  default: {
    getContentType: (filePath: string) => filePath.endsWith('.md') ? 'markdown' : undefined
  }
}))

// The admission module imports the page helper at module evaluation, so register its test double first.
const { admitGitTree, streamGitNameStatus } = await import('./admission.ts')

const oid = 'a'.repeat(40)

function fakeCommand (output: string): GitNativeCommand & { readonly calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async run (args, options = {}) {
      calls.push([...args])
      if (options.onStdoutChunk) {
        const bytes = Buffer.from(output)
        const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2))
        options.onStdoutChunk(bytes.subarray(0, midpoint))
        options.onStdoutChunk(bytes.subarray(midpoint))
      }
      return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: '' }
    }
  }
}

describe('Git bounded admission', () => {
  it('admits only regular blob/tree modes and parses streamed records', async () => {
    const command = fakeCommand(
      `040000 tree ${oid}          -\tdocs\0` +
      `100644 blob ${oid}          3\tpage.md\0` +
      `100755 blob ${oid}          1\tdocs/run.sh\0`
    )
    const admission = await admitGitTree(command, oid, { maxAssetBytes: 1024 })
    expect(admission.entries.map(entry => [entry.mode, entry.type, entry.path, entry.size])).toEqual([
      ['040000', 'tree', 'docs', 0],
      ['100644', 'blob', 'page.md', 3],
      ['100755', 'blob', 'docs/run.sh', 1]
    ])
    expect(command.calls[0]).toEqual(['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', oid])
  })

  it('rejects symlink/gitlink and internal namespace records before admission completes', async () => {
    const symlink = fakeCommand(`120000 blob ${oid}          7\tunsafe\0`)
    await expect(admitGitTree(symlink, oid)).rejects.toThrow('disallowed mode')

    const internal = fakeCommand(`100644 blob ${oid}          4\t.git/config\0`)
    await expect(admitGitTree(internal, oid)).rejects.toThrow('internal path')
  })

  it('parses raw NUL name-status paths without human rename formatting', async () => {
    const command = fakeCommand(
      'R100\0old => name.txt\0new\tname.txt\0' +
      'M\0literal { braces }.md\0' +
      'D\0gone.bin\0'
    )
    const changes = await streamGitNameStatus(command, oid, oid)
    expect(changes).toEqual([
      { status: 'R', score: 100, oldPath: 'old => name.txt', path: 'new\tname.txt' },
      { status: 'M', oldPath: 'literal { braces }.md', path: 'literal { braces }.md' },
      { status: 'D', oldPath: 'gone.bin', path: 'gone.bin' }
    ])
    expect(command.calls[0]).toEqual(['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', oid, oid, '--'])
  })

  it('rejects an admitted tree when its entry or byte budget is crossed', async () => {
    const command = fakeCommand(`100644 blob ${oid}          3\tpage.md\0`)
    await expect(admitGitTree(command, oid, { maxEntries: 0 })).rejects.toThrow('entry limit')
    await expect(admitGitTree(command, oid, { maxBytes: 2 })).rejects.toThrow('byte limit')
  })
})
