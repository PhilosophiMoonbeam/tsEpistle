import { compileScript, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { resetBody } from '../../test/browser-dom.mts'
import * as Vue from 'vue'
import { resolveUserPicture } from '../../helpers/user-picture.ts'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, test } from '../../../server/test/bun-test.mts'
import type { AgentMessageView, AgentThreadState } from '../../../shared/agents/contracts.ts'

import { translateEnglish } from '../../test/english-translate.mts'
globalThis.useTranslate = () => translateEnglish
resetBody()

// Vuetify snapshots browser capabilities, so it must load after resetBody.
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
Bun.plugin({
  name: 'agent-thread-disclosures-real-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: 'agent-thread-disclosures',
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
// The loader must be installed before this real component and its children load.
const AgentThread = (await import('./agent-thread.vue')).default

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
      href: 'https://sources.example/wiki#referenced-section'
    }
  ],
  createdAt: '2026-09-03T10:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z'
})

const renderDuplicateSources = async (): Promise<string> => {
  const messages = [makeMessage('message one/α', 1), makeMessage('message two/β', 2)]
  const timestamp = '2026-09-03T10:00:00.000Z'
  const thread: AgentThreadState = {
    session: {
      id: 'session-sources',
      title: 'Source review',
      retention: 'saved',
      folderId: null,
      status: 'active',
      executionMode: 'agent',
      version: 1,
      providerProfileId: null,
      profileResolutionToken: 'profile-token',
      skills: [],
      currentRun: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      expiresAt: null
    },
    messages,
    tools: [],
    tasks: [],
    proposals: [],
    goal: null,
    artifacts: [],
    suggestions: [],
    historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false }
  }
  const app = Vue.createSSRApp(AgentThread, {
    thread,
    connection: 'connected',
    userPicture: resolveUserPicture({ id: 42, name: 'Ada Lovelace', pictureUrl: '' }),
    canSubmit: true
  })
  app.use(createVuetify({ components: vuetifyComponents, ssr: true }))
  app.config.globalProperties.$t = translateEnglish
  return renderToString(app)
}

describe('Agent thread disclosures', () => {
  test('keeps repeated sources in independent collapsed disclosures with numbered section links, not misnumbered overview links', async () => {
    const dom = new JSDOM(await renderDuplicateSources())
    const disclosures = [...dom.window.document.querySelectorAll<HTMLDetailsElement>('.agent-sources')]
    expect(disclosures).toHaveLength(2)
    expect(disclosures.every(disclosure => !disclosure.open)).toBe(true)
    for (const disclosure of disclosures) {
      expect(disclosure.querySelector('.agent-sources__page .agent-sources__number')).toBeNull()
      const section = disclosure.querySelector<HTMLAnchorElement>('.agent-sources__sections a')
      expect(section?.querySelector('.agent-sources__number')?.textContent).toBe('1')
      expect(section?.querySelector('.agent-sources__label')?.textContent).toBe('Referenced section')
      expect(section?.getAttribute('href')).toBe('https://sources.example/wiki#referenced-section')
      expect(section?.getAttribute('target')).toBe('_blank')
      expect(new Set(section?.rel.split(/\s+/))).toEqual(new Set(['noopener', 'noreferrer']))
    }
    const firstSummary = disclosures[0]?.querySelector<HTMLElement>('summary')
    if (!firstSummary) throw new Error('The first source disclosure has no native summary')
    firstSummary.click()
    expect(disclosures[0]?.open).toBe(true)
    expect(disclosures[1]?.open).toBe(false)
    dom.window.close()
  })
})
