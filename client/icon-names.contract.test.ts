import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from '../server/test/bun-test.mts'

// Vuetify renders an unknown `mdi-*` name as an empty icon slot without any
// warning, so every literal icon name in the client must exist in the
// installed Material Design Icons font.
const root = process.cwd()
const fontCss = readFileSync(join(root, 'node_modules/@mdi/font/css/materialdesignicons.css'), 'utf8')
const knownIcons = new Set(Array.from(fontCss.matchAll(/\.(mdi-[a-z0-9-]+)::before/g), match => match[1]))

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name)
  if (entry.isDirectory()) return sourceFiles(path)
  return /\.(vue|ts|js)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
})

describe('Material Design icon names', () => {
  test('the installed icon font is the one the client loads', () => {
    expect(readFileSync(join(root, 'client/index-app.ts'), 'utf8')).toContain("@mdi/font/css/materialdesignicons.css")
    expect(knownIcons.size).toBeGreaterThan(5000)
  })

  test('every literal mdi-* name in client sources exists in the font', () => {
    const missing: string[] = []
    for (const file of sourceFiles(join(root, 'client'))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/(?<![\w-])(mdi-[a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/g)) {
        if (!knownIcons.has(match[1]!)) missing.push(`${relative(root, file)}: ${match[1]}`)
      }
    }
    expect(missing).toEqual([])
  })
})
