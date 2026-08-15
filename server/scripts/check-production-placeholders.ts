import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const roots = ['client', 'server', 'shared']
const sourceExtensions = new Set(['.cjs', '.js', '.mjs', '.pug', '.scss', '.ts', '.vue', '.yaml', '.yml'])
const excludedPathParts = ['/scripts/', '/test/', '/tests/']
const excludedFilePattern = /\.(?:spec|test)\.[^.]+$/
const placeholderPattern = /\b(?:TODO|FIXME|WIP)\b|coming soon|not implemented|unimplemented|fake fallback|disabled save action/gi

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(entryPath))
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(entryPath)
    }
  }
  return files
}

const files = (await Promise.all(roots.map(collectSourceFiles)))
  .flat()
  .map(file => file.split(path.sep).join('/'))
  .filter(file => !excludedPathParts.some(part => `/${file}`.includes(part)))
  .filter(file => !excludedFilePattern.test(file))
  .sort()

const failures: string[] = []
for (const file of files) {
  const lines = (await readFile(file, 'utf8')).split('\n')
  for (const [index, line] of lines.entries()) {
    placeholderPattern.lastIndex = 0
    const matches = [...line.matchAll(placeholderPattern)]
    if (matches.length > 0) {
      failures.push(`${file}:${index + 1}: ${matches.map(match => match[0]).join(', ')}`)
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Production placeholder markers are forbidden:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
}

console.log(`Production placeholder policy valid across ${files.length} source files`)
