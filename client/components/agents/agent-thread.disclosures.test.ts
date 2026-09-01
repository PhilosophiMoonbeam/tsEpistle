import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/agents/agent-thread.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''

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

  test('preserves ordered numbered citations and safe new-tab source links', () => {
    expect(template).toContain(':citations="entry.message.citations"')
    expect(sourceDetails).toMatch(/v-for="group in entry\.citationGroups"[\s\S]*v-for="citationEntry in group\.sections"/)
    expect(sourceDetails).toContain('{{ group.pageCitation.number }}')
    expect(sourceDetails).toContain('{{ citationEntry.number }}')
    expect(sourceDetails).toContain(':target="group.pageHref ? \'_blank\' : undefined"')
    expect(sourceDetails).toContain(':rel="group.pageHref ? \'noopener noreferrer\' : undefined"')
    expect(sourceDetails).toContain(':target="citationEntry.citation.href ? \'_blank\' : undefined"')
    expect(sourceDetails).toContain(':rel="citationEntry.citation.href ? \'noopener noreferrer\' : undefined"')
  })
})
