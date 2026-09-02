import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/agents/agent-thread.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.scriptSetup?.content ?? ''
const safeLinkScript = script.match(/const navigableHrefCache[\s\S]*?(?=const temporalMetadataFor)/)?.[0]
if (!safeLinkScript) throw new Error('agent-thread.vue safe link helper was not found')
const executableSafeLinkScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(safeLinkScript)
const loadSafeNavigableHref = (): ((href: string | null) => string | undefined) => {
  const evaluate = new Function(`${executableSafeLinkScript}\nreturn safeNavigableHref`) as () => (href: string | null) => string | undefined
  return evaluate()
}

const sourceDetails = template.match(/<details\b[^>]*class="agent-sources\b[^>]*>[\s\S]*?<\/details>/)?.[0] ?? ''
const activityDetails = template.match(/<details\b[^>]*class="agent-activity\b[^>]*>[\s\S]*?<\/details>/)?.[0] ?? ''

describe('Agent thread disclosures', () => {
  test('renders Sources as a closed native disclosure and keeps Activity collapsible', () => {
    expect(errors).toEqual([])
    expect(sourceDetails).toContain('<summary class="agent-sources__heading">')
    expect(sourceDetails).not.toMatch(/\bopen(?:\s|=|$)/)
    expect(activityDetails).toContain('<summary>')
    expect(activityDetails).not.toMatch(/\bopen(?:\s|=|$)/)
  })

  test('preserves ordered numbered citations and renders only safe source URLs as new-tab links', () => {
    const safeNavigableHref = loadSafeNavigableHref()

    expect(safeNavigableHref('/en/runbook#response')).toBe('/en/runbook#response')
    expect(safeNavigableHref('https://docs.example.test/guide')).toBe('https://docs.example.test/guide')
    expect(safeNavigableHref('javascript:alert(1)')).toBeUndefined()
    expect(safeNavigableHref('data:text/html,unsafe')).toBeUndefined()
    expect(safeNavigableHref('https://[')).toBeUndefined()

    expect(template).toContain(':citations="entry.message.citations"')
    expect(sourceDetails).toMatch(/v-for="group in entry\.citationGroups"[\s\S]*v-for="citationEntry in group\.sections"/)
    expect(sourceDetails).toContain('{{ group.pageCitation.number }}')
    expect(sourceDetails).toContain('{{ citationEntry.number }}')
    expect(sourceDetails).toContain(":is=\"safeNavigableHref(group.pageHref) ? 'a' : 'div'\"")
    expect(sourceDetails).toContain(':href="safeNavigableHref(group.pageHref)"')
    expect(sourceDetails).toContain(':target="safeNavigableHref(group.pageHref) ? \'_blank\' : undefined"')
    expect(sourceDetails).toContain(':rel="safeNavigableHref(group.pageHref) ? \'noopener noreferrer\' : undefined"')
    expect(sourceDetails).toContain(":is=\"safeNavigableHref(citationEntry.citation.href) ? 'a' : 'span'\"")
    expect(sourceDetails).toContain(':href="safeNavigableHref(citationEntry.citation.href)"')
    expect(sourceDetails).toContain(':target="safeNavigableHref(citationEntry.citation.href) ? \'_blank\' : undefined"')
    expect(sourceDetails).toContain(':rel="safeNavigableHref(citationEntry.citation.href) ? \'noopener noreferrer\' : undefined"')
  })
})
