import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { resetBody } from '../../test/browser-dom.mts'
import * as Vue from 'vue'
import { createSSRApp, defineComponent } from 'vue'
import type { RenderFunction } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, test } from '../../../server/test/bun-test.mts'
import type { AgentMessageView, AgentToolCallView } from '../../../shared/agents/contracts.ts'
import { buildAgentThreadPresentation } from './agent-thread-presentation.ts'

resetBody()

const componentPath = join(process.cwd(), 'client/components/agents/agent-thread.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.scriptSetup?.content ?? ''
const helperScript = script.match(/const safeNavigableHref[\s\S]*?(?=interface LinkPresentationMetadata)/)?.[0]
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

const makeMessage = (id: string, ordinal: number, runId: string | null = null): AgentMessageView => ({
  id,
  runId,
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

const makeTool = (id: string, state: AgentToolCallView['state']): AgentToolCallView => ({
  id,
  runId: 'run',
  actionName: 'pages.get',
  title: 'Get page',
  state,
  risk: 'read',
  summary: null,
  proposalId: null,
  ...(state === 'omitted' || state === 'not_executed' ? { contextExclusion: { status: state, reason: 'tool_result_capacity' as const } } : {}),
  startedAt: '2026-09-03T10:00:00.000Z',
  completedAt: '2026-09-03T10:00:01.000Z'
})

const renderDuplicateSources = async (tools: readonly AgentToolCallView[] = []): Promise<string> => {
  const messages = tools.length ? [makeMessage('activity message', 1, 'run')] : [makeMessage('message one/α', 1), makeMessage('message two/β', 2)]
  const thread = { messages, artifacts: [], suggestions: [] }
  const { safeNavigableHref, sourceDomId } = loadThreadHelpers()
  const threadPresentation = buildAgentThreadPresentation(messages, tools, [], [])
  const threadProjection = {
    orderedMessages: threadPresentation.orderedMessages.map(entry => ({
      ...entry,
      temporal: { time: '', timestamp: '' },
      citationGroups: entry.citationGroups.map(group => ({
        ...group,
        safeHref: safeNavigableHref(group.pageHref),
        previewSelector: null,
        sections: group.sections.map(citationEntry => ({
          ...citationEntry,
          safeHref: safeNavigableHref(citationEntry.citation.href),
          previewSelector: null
        }))
      })),
      run: entry.run
        ? {
            ...entry.run,
            pageLinks: entry.run.pageLinks.map(link => ({
              ...link,
              safeHref: safeNavigableHref(link.href),
              previewSelector: null
            }))
          }
        : null
    }))
  }
  const component = Object.assign(
    defineComponent({
      setup: () => ({
        thread,
        threadPresentation,
        threadProjection,
        decidingApprovalId: null,
        canSubmit: true,
        sourceDomId,
        previewSelector: null,
        toolStateIcon: (state: AgentToolCallView['state']) =>
          ({
            preparing: 'mdi-dots-horizontal',
            running: 'mdi-progress-clock',
            awaitingApproval: 'mdi-shield-alert-outline',
            complete: 'mdi-check-circle-outline',
            failed: 'mdi-alert-circle-outline',
            denied: 'mdi-cancel',
            cancelled: 'mdi-stop-circle-outline',
            omitted: 'mdi-eye-off-outline',
            not_executed: 'mdi-minus-circle-outline'
          })[state],
        toolStateColor: (state: AgentToolCallView['state']) =>
          state === 'complete' ? 'success' : state === 'failed' || state === 'denied' ? 'error' : undefined,
        toolStateLabel: (state: AgentToolCallView['state']) =>
          ({
            preparing: 'Preparing',
            running: 'Running',
            awaitingApproval: 'Awaiting approval',
            complete: 'Complete',
            failed: 'Failed',
            denied: 'Denied',
            cancelled: 'Cancelled',
            omitted: 'Result omitted',
            not_executed: 'Not executed'
          })[state],
        forwardDecision: () => undefined,
        emit: () => undefined
      }),
      render: renderThreadTemplate
    }),
    { __scopeId: componentScopeId }
  )
  const emptyStub = defineComponent({ render: () => null })
  const app = createSSRApp(component)
  for (const name of ['AgentAnswerActions', 'WikiSourcePreview', 'AgentMarkdown', 'AgentTaskProgress', 'AgentToolCard', 'v-avatar', 'v-btn', 'v-icon']) {
    app.component(name, emptyStub)
  }
  return renderToString(app)
}

describe('Agent thread disclosures', () => {
  test('renders omitted and not-executed activity states as calm accessible rows', async () => {
    const renderedHtml = await renderDuplicateSources([
      makeTool('complete', 'complete'),
      makeTool('omitted', 'omitted'),
      makeTool('not-executed', 'not_executed')
    ])
    const dom = new JSDOM(renderedHtml)
    const activity = dom.window.document.querySelector<HTMLElement>('.agent-activity')
    if (!activity) throw new Error('Rendered activity disclosure was not found')
    expect(activity.textContent).toContain('Activity · 3 activities · 1 omitted · 1 not executed')
    expect(activity.textContent).toContain('Result omitted')
    expect(activity.textContent).toContain('Not executed')
    expect(activity.textContent).not.toContain('failed')
  })

  test('rejects executable and malformed source URLs while allowing navigable sources', () => {
    const { safeNavigableHref } = loadThreadHelpers()

    expect(safeNavigableHref('/en/runbook#response')).toBe('/en/runbook#response')
    expect(safeNavigableHref('https://docs.example.test/guide')).toBe('https://docs.example.test/guide')
    expect(safeNavigableHref('javascript:alert(1)')).toBeUndefined()
    expect(safeNavigableHref('data:text/html,unsafe')).toBeUndefined()
    expect(safeNavigableHref('https://[')).toBeUndefined()
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
})
