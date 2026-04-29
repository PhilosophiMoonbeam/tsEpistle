const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '../..')
const scanRoot = path.join(repoRoot, 'client')
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

const hasDirectiveFilterPipe = line => {
  const bindings = line.match(/(?:^|[\s(,])(?::(?:\[[^\]]+\]|[A-Za-z0-9_$-]+)|v-bind(?::(?:\[[^\]]+\]|[A-Za-z0-9_$-]+))?|v-text|v-html)\s*=\s*(['"`])(?:(?!\1).)*\1/g) || []
  return bindings.some(binding => /(^|[^|])\|\s*[A-Za-z_$][A-Za-z0-9_$]*/.test(binding.replace(/\|\|/g, '')))
}

describe('Vue template filter removal guard', () => {
  test('does not reintroduce Vue 2 template filters or filter registrations', () => {
    const offenders = []

    for (const filePath of collectFiles(scanRoot)) {
      if (filePath === __filename) {
        continue
      }
      const relPath = path.relative(repoRoot, filePath)
      const content = fs.readFileSync(filePath, 'utf8')
      const lines = content.split(/\r?\n/)

      if (/^\s*filters:\s*\{/m.test(content)) {
        offenders.push(`${relPath}: component filters option`)
      }
      if (/Vue\.filter\s*\(/.test(content)) {
        offenders.push(`${relPath}: global Vue.filter registration`)
      }
      lines.forEach((line, index) => {
        if (/\{\{[^{}]*\|\s*[A-Za-z_$][A-Za-z0-9_$]*/.test(line)) {
          offenders.push(`${relPath}:${index + 1}: mustache filter pipe`)
        }
        if (hasDirectiveFilterPipe(line)) {
          offenders.push(`${relPath}:${index + 1}: directive/binding filter pipe`)
        }
      })
    }

    expect(offenders).toEqual([])
  })
})
