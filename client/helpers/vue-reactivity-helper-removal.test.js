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

const groupVModelFiles = [
  'client/components/admin/admin-groups-edit-permissions.vue',
  'client/components/admin/admin-groups-edit-rules.vue',
  'client/components/admin/admin-groups-edit-users.vue'
]

describe('Vue 2 reactivity helper removal guard', () => {
  test('admin group child v-model setters emit input updates', () => {
    groupVModelFiles.forEach(relPath => {
      const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8')
      const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
      const script = scriptMatch && scriptMatch[1]

      expect(script).not.toBeNull()
      expect(script).toMatch(/set\s*\(\s*val\s*\)\s*\{\s*this\.\$emit\(\s*['"]input['"]\s*,\s*val\s*\)\s*\}/)
      expect(script).not.toMatch(/this\.\$set\s*\(/)
    })
  })

  test('does not reintroduce Vue.set/delete or instance $set/$delete helpers', () => {
    const offenders = []
    const disallowedPatterns = [
      { pattern: /\bVue\s*\.\s*set\s*\(/, label: 'Vue.set' },
      { pattern: /\bVue\s*\.\s*delete\s*\(/, label: 'Vue.delete' },
      { pattern: /\bthis\s*\.\s*\$set\s*\(/, label: 'this.$set' },
      { pattern: /\bthis\s*\.\s*\$delete\s*\(/, label: 'this.$delete' }
    ]

    for (const filePath of collectFiles(scanRoot)) {
      if (filePath === __filename) {
        continue
      }
      const relPath = path.relative(repoRoot, filePath)
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)

      lines.forEach((line, index) => {
        disallowedPatterns.forEach(({ pattern, label }) => {
          if (pattern.test(line)) {
            offenders.push(`${relPath}:${index + 1}: ${label}`)
          }
        })
      })
    }

    expect(offenders).toEqual([])
  })
})
