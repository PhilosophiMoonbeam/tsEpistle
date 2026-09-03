import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import * as Vue from 'vue'
import { createSSRApp, defineComponent } from 'vue'
import type { RenderFunction } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, test } from '../../../server/test/bun-test.mts'
import type { AgentMessageView } from '../../../shared/agents/contracts.ts'
import { buildAgentThreadPresentation } from './agent-thread-presentation.ts'

const componentPath = join(process.cwd(), 'client/components/agents/agent-thread.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.scriptSetup?.content ?? ''
const helperScript = script.match(/const navigableHrefCache[\s\S]*?(?=const temporalMetadataFor)/)?.[0]
if (!helperScript) throw new Error('agent-thread.vue source helpers were not found')
const executableHelperScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(helperScript)
const loadThreadHelpers = (): {
  safeNavigableHref: (href: string | null) => string | undefined
  sourceDomId: (messageId: string, evidenceId: string, sourceKind: 'page' | 'section') => string
} => {
  const evaluate = new Function(`${executableHelperScript}\nreturn { safeNavigableHref, sourceDomId }`) as () => {
    safeNavigableHref: (href: string | null) => string | undefined
    sourceDomId: (messageId: string, evidenceId: string, sourceKind: 'page' | 'section') => string
  }
  return evaluate()
}

const sourceDetails = template.match(/<details\b[^>]*class="agent-sources\b[^>]*>[\s\S]*?<\/details>/)?.[0] ?? ''
const activityDetails = template.match(/<details\b[^>]*class="agent-activity\b[^>]*>[\s\S]*?<\/details>/)?.[0] ?? ''

const componentStyleId = 'agent-thread-disclosures'
const componentScopeId = `data-v-${componentStyleId}`
const compiledTemplate = compileTemplate({
  source: template,
  filename: componentPath,
  id: componentStyleId,
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) {
  throw new Error(`Could not compile agent-thread.vue template: ${compiledTemplate.errors.join(', ')}`)
}
const renderThreadTemplate = new Function('Vue', compiledTemplate.code)(Vue) as RenderFunction
const componentStyles = descriptor.styles
  .map(style => {
    const compiled = compileStyle({
      source: style.content,
      filename: componentPath,
      id: componentStyleId,
      scoped: style.scoped
    })
    if (compiled.errors.length > 0) {
      throw new Error(`Could not compile agent-thread.vue styles: ${compiled.errors.join(', ')}`)
    }
    return compiled.code
  })
  .join('\n')

const makeMessage = (id: string, ordinal: number): AgentMessageView => ({
  id,
  runId: null,
  ordinal,
  role: 'assistant',
  status: 'complete',
  content: '',
  citations: [
    {
      evidenceId: 'page:shared source:section:repeat/1',
      kind: 'page',
      label: 'Citation',
      href: null
    }
  ],
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z'
})

const renderDuplicateSources = async (): Promise<string> => {
  const messages = [makeMessage('message one/α', 1), makeMessage('message two/β', 2)]
  const thread = { messages, artifacts: [], suggestions: [] }
  const { safeNavigableHref, sourceDomId } = loadThreadHelpers()
  const component = Object.assign(
    defineComponent({
      setup: () => ({
        thread,
        threadPresentation: buildAgentThreadPresentation(messages, [], [], []),
        decidingApprovalId: null,
        canSubmit: true,
        safeNavigableHref,
        sourceDomId,
        messageTime: () => '',
        messageTimestamp: () => '',
        toolStateIcon: () => '',
        toolStateColor: () => undefined,
        toolStateLabel: () => '',
        forwardDecision: () => undefined,
        emit: () => undefined,
        liveSummary: ''
      }),
      render: renderThreadTemplate
    }),
    { __scopeId: componentScopeId }
  )
  const emptyStub = defineComponent({ render: () => null })
  const app = createSSRApp(component)
  for (const name of ['AgentMarkdown', 'AgentTaskProgress', 'AgentToolCard', 'v-avatar', 'v-btn', 'v-icon']) {
    app.component(name, emptyStub)
  }
  return renderToString(app)
}

describe('Agent thread disclosures', () => {
  test('renders Sources as a closed native disclosure and keeps Activity collapsible', () => {
    expect(errors).toEqual([])
    expect(sourceDetails).toContain('<summary class="agent-sources__heading">')
    expect(sourceDetails).not.toMatch(/\bopen(?:\s|=|$)/)
    expect(activityDetails).toContain('<summary>')
    expect(activityDetails).not.toMatch(/\bopen(?:\s|=|$)/)
  })

  test('preserves ordered numbered citations and renders only safe source URLs as new-tab links', () => {
    const { safeNavigableHref } = loadThreadHelpers()

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

  test('renders unique encoded page and section identifiers when messages repeat evidence', async () => {
    const dom = new JSDOM(await renderDuplicateSources())
    const disclosures = [...dom.window.document.querySelectorAll<HTMLDetailsElement>('.agent-sources')]
    const pageIds = disclosures.map(disclosure => disclosure.querySelector<HTMLElement>('.agent-sources__group')?.id ?? '')
    const sectionIds = disclosures.map(disclosure => disclosure.querySelector<HTMLElement>('.agent-sources__sections > li')?.id ?? '')
    const sourceIds = [...pageIds, ...sectionIds]

    expect(disclosures).toHaveLength(2)
    expect(disclosures.every(disclosure => !disclosure.open)).toBe(true)
    expect(pageIds[0]).not.toBe(pageIds[1])
    expect(sectionIds[0]).not.toBe(sectionIds[1])
    expect(new Set(sourceIds).size).toBe(sourceIds.length)
    expect(sourceIds.every(id => id.length > 0 && !/\s/u.test(id))).toBe(true)
  })

  test('keeps the source count and chevron together behind one auto spacer', async () => {
    const renderedHtml = await renderDuplicateSources()
    const dom = new JSDOM(`<!doctype html><html><head><style>${componentStyles}</style></head><body>${renderedHtml}</body></html>`)
    const summary = dom.window.document.querySelector<HTMLElement>('.agent-sources__heading')
    if (!summary) throw new Error('Rendered source summary was not found')
    expect(summary.lastElementChild?.classList.contains('agent-sources__count')).toBe(true)

    const rules = [...dom.window.document.styleSheets[0]!.cssRules].filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    const styleFor = (selector: string): CSSStyleDeclaration => {
      const rule = rules.find(candidate => candidate.selectorText.split(',').some(candidateSelector => candidateSelector.trim() === selector))
      if (!rule) throw new Error(`Compiled source summary rule was not found: ${selector}`)
      return rule.style
    }
    const summarySelector = `.agent-sources__heading[${componentScopeId}]`
    const summaryStyle = styleFor(summarySelector)
    const countStyle = styleFor(`.agent-sources__count[${componentScopeId}]`)
    const chevronStyle = styleFor(`${summarySelector}::after`)
    const autoSpacers = [countStyle, chevronStyle].map(style => style.getPropertyValue('margin-inline-start').trim()).filter(value => value === 'auto')

    expect(summaryStyle.getPropertyValue('gap').trim()).toBe('var(--wiki-space-2)')
    expect(countStyle.getPropertyValue('margin-inline-start').trim()).toBe('auto')
    expect(chevronStyle.getPropertyValue('margin-inline-start').trim()).toBe('')
    expect(autoSpacers).toHaveLength(1)
  })
})
