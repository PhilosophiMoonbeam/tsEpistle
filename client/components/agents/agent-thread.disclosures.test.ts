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
import type { AgentMessageView, AgentThreadState } from '../../../shared/agents/contracts.ts'
import { buildAgentThreadPresentation } from './agent-thread-presentation.ts'

import { translateEnglish } from '../../test/english-translate.mts'
globalThis.useTranslate = () => translateEnglish
resetBody()

const componentPath = join(process.cwd(), 'client/components/agents/agent-thread.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''

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
      label: 'Citation › Referenced section',
      href: null
    }
  ],
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z'
})

const renderDuplicateSources = async (): Promise<string> => {
  const messages = [makeMessage('message one/α', 1), makeMessage('message two/β', 2)]
  const thread: AgentThreadState = {
    session: {
      id: 'session-sources',
      title: 'Repeated source references',
      retention: 'saved',
      folderId: null,
      status: 'active',
      executionMode: 'agent',
      version: 1,
      providerProfileId: null,
      profileResolutionToken: 'sources-profile-resolution',
      mediaCapabilities: null,
      skills: [],
      currentRun: null,
      createdAt: messages[0].createdAt,
      updatedAt: messages[1].updatedAt,
      lastActivityAt: messages[1].updatedAt,
      expiresAt: null
    },
    messages,
    tools: [],
    tasks: [],
    specialistInvocations: [],
    routingDecisions: [],
    goal: null,
    proposals: [],
    artifacts: [],
    suggestions: [],
    historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false }
  }
  const threadPresentation = buildAgentThreadPresentation(messages, [], [], [])
  const threadProjection = {
    orderedMessages: threadPresentation.orderedMessages.map(entry => ({
      ...entry,
      statusLabel: entry.statusLabel ? translateEnglish(entry.statusLabel.key, entry.statusLabel.params) : '',
      ariaLabel: translateEnglish(entry.ariaLabel.key, { status: translateEnglish('common:agentThread.complete') }),
      temporal: { time: '', timestamp: '' },
      citationGroups: entry.citationGroups.map(group => ({
        ...group,
        safeHref: undefined,
        previewSelector: null,
        sections: group.sections.map(citationEntry => ({
          ...citationEntry,
          safeHref: undefined,
          previewSelector: null
        }))
      })),
      run: entry.run
        ? {
            ...entry.run,
            activityLabel: entry.run.activityLabel.map(label => translateEnglish(label.key, label.params)).join(' · '),
            pageLinks: entry.run.pageLinks.map(link => ({
              ...link,
              safeHref: undefined,
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
        artifactPlacement: { byMessage: new Map(), unplaced: [] },
        artifactTimeLabel: () => '',
        decidingApprovalId: null,
        canSubmit: true,
        previewSelector: null,
        forwardDecision: () => undefined,
        emit: () => undefined
      }),
      render: renderThreadTemplate
    }),
    { __scopeId: componentScopeId }
  )
  const emptyStub = defineComponent({ render: () => null })
  const app = createSSRApp(component)
  app.config.globalProperties.$t = translateEnglish
  for (const name of [
    'AgentAnswerActions',
    'AgentArtifactGrid',
    'WikiSourcePreview',
    'AgentMarkdown',
    'AgentTaskProgress',
    'AgentToolCard',
    'v-avatar',
    'v-btn',
    'v-icon'
  ]) {
    app.component(name, emptyStub)
  }
  return renderToString(app)
}

describe('Agent thread disclosures', () => {
  test('keeps repeated sources in independent collapsed disclosures with numbered section links, not misnumbered overview links', async () => {
    const dom = new JSDOM(await renderDuplicateSources())
    try {
      const disclosures = [...dom.window.document.querySelectorAll<HTMLDetailsElement>('.agent-sources')]
      expect(disclosures).toHaveLength(2)
      expect(disclosures.every(disclosure => !disclosure.open)).toBe(true)
      for (const disclosure of disclosures) {
        expect(disclosure.querySelector('.agent-sources__page .agent-sources__number')).toBeNull()
        expect(disclosure.querySelector('.agent-sources__sections .agent-sources__number')?.textContent).toBe('1')
        expect(disclosure.querySelector('.agent-sources__label')?.textContent).toBe('Referenced section')
      }
    } finally {
      dom.window.close()
    }
  })
})
