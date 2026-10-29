import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { AgentMemoryContextProjectionSchema, type AgentMemoryContextProjection } from '../../../shared/agents/contracts.ts'
import { AgentSourceContextProjectionSchema, type AgentSourceContextProjection } from '../../../shared/agents/knowledge-context.ts'
import { document, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'

resetBody()

// Match production i18next's default escaping, while honoring each call's explicit
// Vue text/attribute interpolation policy. The English helper otherwise disables it.
const translateWithDefaultEscaping = (key: string, options: Record<string, unknown> = {}): string =>
  translateEnglish(key, { interpolation: { escapeValue: true }, ...options })

// Static imports would initialize Vue/Vuetify before the shared DOM boundary.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const { VIcon } = await import('vuetify/components')

Bun.plugin({
  name: 'agent-context-summary-real-sfc',
  setup(builder) {
    builder.onLoad({ filter: /agent-context-summary\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: `summary-interaction-${path.basename(filename, '.vue')}`,
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
// Static SFC imports bypass the compiler plugin; execute the real setup and template.
const AgentContextSummary = (await import('./agent-context-summary.vue')).default

type MemoryTarget = 'user' | 'agent'
interface SummaryProps {
  sources: AgentSourceContextProjection | null
  memory: AgentMemoryContextProjection | null
  loading: boolean
  networkBlocked: boolean
  sourcesDisabled: boolean
  memoryDisabled: boolean
}
interface MountedSummary {
  host: HTMLElement
  update: (patch: Partial<SummaryProps>) => Promise<void>
}

const mountedApps: Array<() => void> = []
const mountSummary = async (initial: Partial<SummaryProps> = {}): Promise<MountedSummary> => {
  const host = document.createElement('div')
  document.body.append(host)
  const props = Vue.shallowReactive<SummaryProps>({
    sources: null, memory: null, loading: false, networkBlocked: false,
    sourcesDisabled: false, memoryDisabled: false, ...initial
  })
  const app = Vue.createApp({
    setup: () => () => Vue.h(AgentContextSummary, props)
  })
  app.config.globalProperties.$t = translateWithDefaultEscaping
  app.use(createVuetify({ components: { VIcon } }))
  app.mount(host)
  mountedApps.push(() => {
    app.unmount()
    host.remove()
  })
  await Vue.nextTick()
  return {
    host,
    update: async patch => {
      Object.assign(props, patch)
      await Vue.nextTick()
    }
  }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
})

const required = <T extends Element = HTMLElement>(parent: ParentNode, selector: string): T => {
  const element = parent.querySelector<T>(selector)
  if (!element) throw new Error(`Missing rendered summary element: ${selector}`)
  return element
}
const sourceButton = (host: HTMLElement): HTMLButtonElement => required(host, '.agent-context-summary__sources')
const memoryButton = (host: HTMLElement, target: MemoryTarget): HTMLButtonElement => required(host, `.agent-context-summary__crystal--${target}`)
const memoryDescription = (button: HTMLButtonElement): HTMLElement => {
  const description = document.getElementById(button.getAttribute('aria-describedby') ?? '')
  if (!description) throw new Error('Memory opener must describe its rendered target metadata')
  return description
}
const activeMemoryDescription = (button: HTMLButtonElement): HTMLElement => required(memoryDescription(button), 'p')
const openDetails = async (host: HTMLElement): Promise<void> => {
  required<HTMLElement>(host, 'summary').click()
  await Vue.nextTick()
  expect(required<HTMLDetailsElement>(host, 'details').open).toBe(true)
}
const expectAttachmentCount = (host: HTMLElement, count: number): void => {
  const button = sourceButton(host)
  expect(required(button, 'strong').textContent).toBe(`${count}/8`)
  expect(button.getAttribute('aria-label')).toContain(`${count}/8`)
  const fill = required<SVGCircleElement>(button, 'circle[pathLength]')
  expect(fill.getAttribute('pathLength')).toBe('8')
  expect(fill.getAttribute('stroke-dashoffset')).toBe(String(8 - count))
}
const expectHintCounts = (host: HTMLElement, selected: number, accessible: number): void => {
  const description = Array.from(host.querySelectorAll('p')).find(row => row.textContent?.includes('distinct selected hints'))
  if (!description) throw new Error('Distinct selected and accessible hint counts must be disclosed')
  expect(description.textContent).toContain(`${selected} distinct selected hints`)
  expect(description.textContent).toContain(`${accessible} currently accessible hints`)
}

const attachments = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1, locale: 'en', path: `handbook/attachment-${index + 1}`,
  title: `Committed attachment ${index + 1}`, visibility: 'public' as const, sourceRevision: '3'
}))
const attachmentIdentities = attachments.map(({ id, locale, path }) => ({ id, locale, path }))
const pendingIdentities = Array.from({ length: 8 }, (_, index) => ({
  id: index + 101, locale: 'en', path: `pending-selection-${index + 101}`
}))
const committedProjection = (count: number): AgentSourceContextProjection => AgentSourceContextProjectionSchema.parse({
  identity: { kind: 'draft', ownerId: 7, draftId: 'summary-draft', sessionId: 'frozen-session' },
  generation: 4, scope: { kind: 'all' },
  attachedSources: attachments.slice(0, count).map(source => ({ source, access: 'accessible' })),
  pendingSources: pendingIdentities,
  currentPage: { included: false, origin: 'navigation', hint: null, access: 'unknown' },
  accessibleIdentities: attachmentIdentities.slice(0, count)
})
const knownMemory = (): AgentMemoryContextProjection => {
  const user = { state: 'available', target: 'user', characters: 77, limit: 1375, snapshotId: 'a'.repeat(64) }
  const agent = { state: 'available', target: 'agent', characters: 31, limit: 2200, snapshotId: 'c'.repeat(64) }
  return AgentMemoryContextProjectionSchema.parse({
    ownerId: 7, sessionId: 'frozen-session',
    frozen: { snapshotId: 'frozen-session', user, agent },
    latestSaved: { user, agent }, nextSession: { user: 'unchanged', agent: 'unchanged' }
  })
}
const changedSavedMemory = (): AgentMemoryContextProjection => {
  const memory = knownMemory()
  return AgentMemoryContextProjectionSchema.parse({
    ...memory,
    latestSaved: {
      ...memory.latestSaved,
      user: { state: 'available', target: 'user', characters: 204, limit: 1375, snapshotId: 'b'.repeat(64) }
    },
    nextSession: { ...memory.nextSession, user: 'changed' }
  })
}

describe('agent context summary DOM boundary', () => {
  it('fills 0 through 8 attachment slots from committed rows, never the eight pending selections', async () => {
    const mounted = await mountSummary({ sources: committedProjection(0) })
    await openDetails(mounted.host)

    for (let count = 0; count <= 8; count += 1) {
      await mounted.update({ sources: committedProjection(count) })
      expectAttachmentCount(mounted.host, count)
      expect(mounted.host.querySelectorAll('.agent-context-summary__source-list li')).toHaveLength(count)
      expectHintCounts(mounted.host, count, count)
      expect(mounted.host.textContent).not.toContain('pending-selection-')
    }
  })

  it('deduplicates an attached current hint, admits a distinct ninth hint without a ninth slot, and removes it on exclusion', async () => {
    const base = committedProjection(8)
    const duplicateHint = { ...attachmentIdentities[0], observedUpdatedAt: '2026-10-27T00:00:00Z' }
    const mounted = await mountSummary({
      sources: AgentSourceContextProjectionSchema.parse({
        ...base,
        currentPage: { included: true, origin: 'historical', hint: duplicateHint, access: 'accessible' }
      })
    })
    await openDetails(mounted.host)
    expectAttachmentCount(mounted.host, 8)
    expectHintCounts(mounted.host, 8, 8)

    const ninthIdentity = { id: 9, locale: 'en', path: 'handbook/current-ninth' }
    const ninthHint = { ...ninthIdentity, observedUpdatedAt: '2026-10-27T00:00:00Z' }
    const ninthProjection = AgentSourceContextProjectionSchema.parse({
      ...base,
      currentPage: { included: true, origin: 'historical', hint: ninthHint, access: 'accessible' },
      accessibleIdentities: [...attachmentIdentities, ninthIdentity]
    })
    await mounted.update({ sources: ninthProjection })
    expectAttachmentCount(mounted.host, 8)
    expectHintCounts(mounted.host, 9, 9)
    expect(mounted.host.querySelectorAll('.agent-context-summary__source-list li')).toHaveLength(8)
    const page = required(mounted.host, '.agent-context-summary__page')
    expect(page.textContent).toContain(translateEnglish('common:agentContextUi.pageIncluded'))
    expect(page.getAttribute('title')).toContain('en/handbook/current-ninth')

    await mounted.update({
      sources: AgentSourceContextProjectionSchema.parse({
        ...ninthProjection,
        currentPage: { ...ninthProjection.currentPage, included: false },
        accessibleIdentities: attachmentIdentities
      })
    })
    expectAttachmentCount(mounted.host, 8)
    expectHintCounts(mounted.host, 8, 8)
    expect(page.textContent).toContain(translateEnglish('common:agentContextUi.pageExcluded'))
  })

  it('keeps 77 frozen user characters active after latest saved becomes 204, with unescaped accessible and detail counts', async () => {
    const mounted = await mountSummary({ memory: knownMemory() })
    await openDetails(mounted.host)
    const user = memoryButton(mounted.host, 'user')
    expect(user.textContent).toContain('77')
    expect(user.getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.next.unchanged'))

    await mounted.update({ memory: changedSavedMemory() })
    expect(user.textContent).toContain('77')
    expect(user.textContent).not.toContain('204')
    expect(activeMemoryDescription(user).textContent).toContain('77/1375')
    expect(activeMemoryDescription(user).textContent).not.toContain('204/1375')
    expect(memoryDescription(user).textContent).toContain('204/1375')
    expect(user.getAttribute('aria-label')).toContain('77/1375')
    expect(user.getAttribute('aria-label')).toContain('204/1375')
    expect(user.getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.next.changed'))
    expect(memoryDescription(user).textContent).toContain(translateEnglish('common:agentContextUi.next.changed'))
    const agent = memoryButton(mounted.host, 'agent')
    expect(activeMemoryDescription(agent).textContent).toContain('31/2200')
    expect(agent.getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.next.unchanged'))
  })

  it('distinguishes unknown and failed reads from loaded empty memory, and retains explicitly stale counts without a fresh comparison', async () => {
    const unknown = AgentMemoryContextProjectionSchema.parse({
      ownerId: 7, sessionId: 'loading-session',
      frozen: { snapshotId: null, user: { state: 'unknown' }, agent: { state: 'unknown' } },
      latestSaved: { user: { state: 'unknown' }, agent: { state: 'unknown' } },
      nextSession: { user: 'unknown', agent: 'unknown' }
    })
    const mounted = await mountSummary({ memory: unknown })
    await openDetails(mounted.host)
    const user = memoryButton(mounted.host, 'user')
    expect(activeMemoryDescription(user).textContent).toContain(translateEnglish('common:agentContextUi.state.unknown'))
    expect(user.getAttribute('aria-label')).not.toContain('/1375')

    await mounted.update({
      memory: AgentMemoryContextProjectionSchema.parse({
        ...unknown,
        frozen: { ...unknown.frozen, user: { state: 'error' } },
        latestSaved: { ...unknown.latestSaved, user: { state: 'error' } }
      })
    })
    expect(activeMemoryDescription(user).textContent).toContain(translateEnglish('common:agentContextUi.state.error'))
    expect(user.getAttribute('aria-label')).not.toContain('/1375')

    const emptyUser = { state: 'available', target: 'user', characters: 0, limit: 1375, snapshotId: 'e'.repeat(64) }
    await mounted.update({
      memory: AgentMemoryContextProjectionSchema.parse({
        ...unknown, sessionId: 'empty-session',
        frozen: { ...unknown.frozen, snapshotId: 'empty-session', user: emptyUser },
        latestSaved: { ...unknown.latestSaved, user: emptyUser },
        nextSession: { ...unknown.nextSession, user: 'unchanged' }
      })
    })
    expect(activeMemoryDescription(user).textContent).toContain(translateEnglish('common:agentContextUi.emptyCount', { count: 0, limit: 1375 }))
    expect(user.getAttribute('aria-label')).toContain('0/1375')

    const savedChange = changedSavedMemory()
    await mounted.update({
      memory: AgentMemoryContextProjectionSchema.parse({
        ...savedChange,
        frozen: { ...savedChange.frozen, user: { ...savedChange.frozen.user, state: 'stale' } },
        nextSession: { ...savedChange.nextSession, user: 'unknown' }
      })
    })
    expect(user.textContent).toContain('77')
    expect(user.textContent?.toLowerCase()).toContain(translateEnglish('common:agentContextUi.state.stale').toLowerCase())
    expect(activeMemoryDescription(user).textContent).toContain('77/1375')
    expect(activeMemoryDescription(user).textContent?.toLowerCase()).toContain(translateEnglish('common:agentContextUi.state.stale').toLowerCase())
    expect(user.getAttribute('aria-label')).toContain('77/1375')
    expect(user.getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.next.unknown'))
    expect(user.getAttribute('aria-label')).not.toContain(translateEnglish('common:agentContextUi.next.changed'))
  })

  it('clears prior-session source and memory metadata when a rebind supplies null projections instead of inventing empty counts', async () => {
    const privateTitle = 'Prior private attachment'
    const privatePath = 'private/prior-attachment'
    const privateIdentity = { ...attachmentIdentities[0], path: privatePath }
    const memory = changedSavedMemory()
    const mounted = await mountSummary({
      sources: AgentSourceContextProjectionSchema.parse({
        ...committedProjection(1),
        attachedSources: [{ source: { ...attachments[0], title: privateTitle, path: privatePath }, access: 'accessible' }],
        accessibleIdentities: [privateIdentity]
      }),
      memory
    })
    await openDetails(mounted.host)
    const metadataOutput = (): string => [
      mounted.host.textContent,
      ...Array.from(mounted.host.querySelectorAll('[aria-label], [title]')).flatMap(element => [element.getAttribute('aria-label'), element.getAttribute('title')])
    ].join('\n')
    const oldMetadata = [privateTitle, privatePath, memory.sessionId, 'a'.repeat(64), 'c'.repeat(64), '77/1375', '204/1375', '31/2200']
    for (const marker of oldMetadata) expect(metadataOutput()).toContain(marker)

    await mounted.update({ sources: null, memory: null, loading: true })
    for (const marker of oldMetadata) expect(metadataOutput()).not.toContain(marker)
    expect(sourceButton(mounted.host).getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.state.loading'))
    expect(required(sourceButton(mounted.host), 'strong').textContent).toBe('—/8')
    expect(sourceButton(mounted.host).querySelector('circle[pathLength]')).toBeNull()
    for (const target of ['user', 'agent'] as const) {
      expect(memoryButton(mounted.host, target).getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.state.loading'))
    }

    await mounted.update({ loading: false })
    expect(sourceButton(mounted.host).getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.state.unknown'))
    await mounted.update({ networkBlocked: true })
    expect(sourceButton(mounted.host).getAttribute('aria-label')).toContain(translateEnglish('common:agentContextUi.state.offline'))
    for (const target of ['user', 'agent'] as const) {
      const label = memoryButton(mounted.host, target).getAttribute('aria-label')
      expect(label).toContain(translateEnglish('common:agentContextUi.state.offline'))
      expect(label).not.toContain('0/1375')
      expect(label).not.toContain('0/2200')
    }
    for (const marker of oldMetadata) expect(metadataOutput()).not.toContain(marker)
  })

})
