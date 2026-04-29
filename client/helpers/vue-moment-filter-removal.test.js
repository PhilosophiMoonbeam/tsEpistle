const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '../..')
const scanRoots = [
  path.join(repoRoot, 'client')
]

const skippedDirs = new Set(['node_modules', 'dist', '.git'])
const scannedExtensions = new Set(['.js', '.vue'])

const collectFiles = dir => {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap(entry => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return skippedDirs.has(entry.name) ? [] : collectFiles(fullPath)
    }
    if (entry.isFile() && scannedExtensions.has(path.extname(entry.name))) {
      return [fullPath]
    }
    return []
  })
}

describe('vue-moment filter removal guard', () => {
  test('does not reintroduce Vue 2 moment filters or vue-moment plugin usage', () => {
    const offenders = []
    const blockedPatterns = [
      /\|\s*moment\s*\(/,
      /\$options\.filters\.moment\s*\(/,
      /from ['"]vue-moment['"]/,
      /require\(['"]vue-moment['"]\)/,
      /VueMoment/,
      /Vue\.use\(\s*VueMoment/,
      /Vue\.filter\(\s*['"]moment['"]/
    ]

    for (const scanRoot of scanRoots) {
      for (const filePath of collectFiles(scanRoot)) {
        if (filePath === __filename) {
          continue
        }
        const relPath = path.relative(repoRoot, filePath)
        const content = fs.readFileSync(filePath, 'utf8')
        blockedPatterns.forEach(pattern => {
          if (pattern.test(content)) {
            offenders.push(`${relPath}: ${pattern}`)
          }
        })
      }
    }

    expect(offenders).toEqual([])
  })
})
