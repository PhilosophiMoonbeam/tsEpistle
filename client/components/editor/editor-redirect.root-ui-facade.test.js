import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/editor/editor-redirect.vue'), 'utf8')

const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? ''

describe('editor redirect REST migration guard', () => {
  test('loads group options through an abortable REST request with balanced loading state', () => {
    expect(source).toMatch(/<script\s+lang\s*=\s*['"]ts['"]\s*>/)
    expect(script).toMatch(/import\s*\{\s*fetchGroupOptions\s*,\s*type\s+GroupOption\s*\}\s*from\s*['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/this\.groupsAbortController\?\.\s*abort\s*\(\s*\)/)
    expect(script).toMatch(
      /fetchGroupOptions\s*\(\s*\(\s*url\s*,\s*init\s*\)\s*=>\s*window\.fetch\s*\(\s*url\s*,\s*\{\s*\.\.\.init\s*,\s*signal\s*:\s*abortController\.signal\s*\}\s*\)\s*\)/
    )
    expect(script).toMatch(/this\.groupsAbortController\s*===\s*abortController\s*&&\s*!abortController\.signal\.aborted[\s\S]*?this\.groups\s*=\s*groups/)
    expect(script).toMatch(
      /const\s+wasLoading\s*=\s*this\.groupsLoading[\s\S]*?if\s*\(\s*!wasLoading\s*\)\s*\{[\s\S]*?setLoading\s*\(\s*wikiStore\s*,\s*['"]editor-redirect-groups['"]\s*,\s*true\s*\)/
    )
    expect(script).toMatch(
      /finally\s*\{[\s\S]*?this\.groupsAbortController\s*===\s*abortController[\s\S]*?setLoading\s*\(\s*wikiStore\s*,\s*['"]editor-redirect-groups['"]\s*,\s*false\s*\)/
    )
    expect(script).toMatch(
      /beforeUnmount\s*\(\s*\)\s*\{[\s\S]*?this\.groupsAbortController\?\.\s*abort\s*\(\s*\)[\s\S]*?this\.groupsAbortController\s*=\s*null[\s\S]*?setLoading\s*\(\s*wikiStore\s*,\s*['"]editor-redirect-groups['"]\s*,\s*false\s*\)/
    )
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves redirect initialization and current Vuetify rule and fallback controls', () => {
    expect(script).toContain("wikiStore.editor.editorKey = 'redirect'")
    expect(script).toContain("wikiStore.editor.content = '<h1>Title</h1>\\n\\n<p>Some text here</p>'")

    const systemBar = source.match(/^\s*v-system-bar\.editor-status-bar\.editor-redirect-sysbar\s*\(([^)]*)\)/m)
    expect(systemBar).not.toBeNull()
    expect(systemBar[1]).toMatch(/\babsolute\b/)
    expect(systemBar[1]).toMatch(/\bcolor\s*=\s*["']grey-darken-3["']/)
    expect(systemBar[1]).not.toMatch(/(?:^|,)\s*status\s*(?:,|$)/)

    expect(source).toMatch(
      /v-for\s*=\s*['"]rule\s+in\s+conditionalRules['"][\s\S]*?:key\s*=\s*['"]rule\.key['"][\s\S]*?v-select\.editor-redirect-groups\s*\([\s\S]*?v-model\s*=\s*['"]rule\.groups['"][\s\S]*?v-btn-toggle\.editor-redirect-toggle\s*\([\s\S]*?v-model\s*=\s*['"]rule\.mode['"][\s\S]*?v-text-field\.editor-redirect-url\s*\([\s\S]*?v-model\s*=\s*['"]rule\.url['"]/
    )
    expect(source).toMatch(
      /Otherwise,\s+redirect\s+to[\s\S]*?v-btn-toggle\.editor-redirect-toggle\s*\([\s\S]*?v-model\s*=\s*['"]fallbackMode['"][\s\S]*?v-text-field\.editor-redirect-url\s*\([\s\S]*?v-model\s*=\s*['"]fallbackUrl['"]/
    )
  })
})
