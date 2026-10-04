import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { createModalFocusScope } from '../common/modal-focus-scope'
import { helpers } from '../../helpers/index.ts'
import type { AgentMemoryEntry, AgentMemoryView, PersonalAgentSkill } from '../../helpers/agents-api.ts'
import type { App, Ref, RenderFunction } from 'vue'

// Vue/Vuetify capture browser capabilities at module evaluation; the shared test DOM must exist first.
const Vue = await import('vue')
const { createVuetify, useDisplay } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')

interface InventoryDefinition {
  evaluate: (dependencies: Record<string, unknown>) => Record<string, unknown>
  render: RenderFunction
}
interface InventoryProps {
  csrfToken: string
  ownerId: number
  embedded: boolean
  networkBlocked: boolean
  headingId: string
  descriptionId: string
}
interface MountedInventory {
  app: App
  host: HTMLElement
  props: InventoryProps
  model: Ref<boolean>
  errors: unknown[]
}
interface OrganizationSkill {
  id: string
  name: string
  rootPageId: number
  rootPath: string
  assetFolderId: number | null
  status: 'enabled' | 'disabled'
  exposureMode: 'all_agent_users' | 'groups'
  currentVersionId: string | null
  currentContentHash: string | null
  approvedSourceRevision: string | null
  liveSourceRevision: string
  drifted: boolean
  groupIds: number[]
}

const compileInventory = (filename: string): InventoryDefinition => {
  const componentPath = path.join(process.cwd(), 'client/components/agents', filename)
  const descriptor = parse(fs.readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor
  if (!descriptor.scriptSetup || !descriptor.template) throw new Error(`${filename} setup and template are required`)
  const metadata = compileScript(descriptor, { id: `inventory-${filename}` })
  if (!metadata.scriptSetupAst || !metadata.bindings) throw new Error(`${filename} setup metadata was not compiled`)
  const script = descriptor.scriptSetup.content
  const parts: string[] = []
  let previousImportEnd = 0
  for (const statement of metadata.scriptSetupAst) {
    if (statement.type !== 'ImportDeclaration') continue
    if (typeof statement.start !== 'number' || typeof statement.end !== 'number') throw new Error('Import positions are required')
    parts.push(script.slice(previousImportEnd, statement.start))
    previousImportEnd = statement.end
  }
  parts.push(script.slice(previousImportEnd))
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(parts.join(''))
  const bindings = Object.keys(metadata.bindings).filter(
    name => metadata.bindings?.[name] !== 'props' && metadata.bindings?.[name] !== 'props-aliased' && !metadata.imports?.[name]
  )
  const dependencies = [...Object.keys(metadata.imports ?? {}), 'defineProps', 'defineModel', 'defineEmits']
  const evaluate = new Function(`{ ${dependencies.join(', ')} }`, `${executable}\nreturn { ${bindings.join(', ')} }`) as (
    dependencies: Record<string, unknown>
  ) => Record<string, unknown>
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: componentPath,
    id: `inventory-${filename}`,
    compilerOptions: { mode: 'function' }
  })
  if (template.errors.length) throw template.errors[0]
  return { evaluate, render: new Function('Vue', template.code)(Vue) as RenderFunction }
}

const personalInventory = compileInventory('agent-personal-skills.vue')
const organizationInventory = compileInventory('skill-admin.vue')
const memoryInventory = compileInventory('agent-memory-manager.vue')
const mountedApps: MountedInventory[] = []
const settle = async (): Promise<void> => {
  for (let pass = 0; pass < 5; pass += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

const mountInventory = (
  inventory: InventoryDefinition,
  dependencies: Record<string, unknown> = {},
  extraProps: Partial<InventoryProps> = {}
): MountedInventory => {
  const errors: unknown[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const model = Vue.ref(true)
  const props = Vue.reactive({
    csrfToken: 'csrf-token',
    ownerId: 1,
    embedded: true,
    networkBlocked: false,
    headingId: 'knowledge-memory-title',
    descriptionId: 'knowledge-memory-description',
    ...extraProps
  })
  const component = Vue.defineComponent({
    props: ['csrfToken', 'ownerId', 'embedded', 'networkBlocked', 'headingId', 'descriptionId'],
    setup(componentProps) {
      return {
        ...componentProps,
        ...inventory.evaluate({
          ...Vue,
          useDisplay,
          useTranslate: () => translateEnglish,
          createModalFocusScope,
          helpers,
          z,
          defineProps: () => componentProps,
          defineModel: () => model,
          defineEmits: () => () => undefined,
          ...dependencies
        })
      }
    },
    render: inventory.render
  })
  const app = Vue.createApp({ render: () => Vue.h(component, { ...props }) })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateEnglish
  app.config.errorHandler = error => errors.push(error)
  app.mount(host)
  const mounted = { app, host, props, model, errors }
  mountedApps.push(mounted)
  return mounted
}

const personalSkill = (name: string, id = name): PersonalAgentSkill => ({
  id,
  name,
  description: `${name} reference material`,
  versionId: `${id}-revision`,
  contentHash: 'a'.repeat(64),
  isAgentDiscoverable: true,
  skillMarkdown: `---\nname: ${name}\ndescription: ${name} reference material\n---\nOriginal instructions`,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z'
})

const personalDependencies = (read: () => PersonalAgentSkill[]) => ({
  listPersonalAgentSkills: vi.fn(async () => read()),
  createPersonalAgentSkill: vi.fn(async () => personalSkill('created')),
  updatePersonalAgentSkill: vi.fn(async () => personalSkill('updated')),
  removePersonalAgentSkill: vi.fn(async () => undefined)
})

const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement => {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.trim() === name)
  if (!button) throw new Error(`Button ${name} did not render`)
  return button
}
const field = <T extends HTMLElement>(selector: string): T => {
  const element = document.body.querySelector<T>(selector)
  if (!element) throw new Error(`Field ${selector} did not render`)
  return element
}
const enterText = async (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  element.value = value
  element.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await settle()
}
const refreshPersonal = async (mounted: MountedInventory): Promise<void> => {
  mounted.props.networkBlocked = true
  await settle()
  mounted.props.networkBlocked = false
  await settle()
}

const organizationSkill = (name: string, rootPath = `_skills/${name}`): OrganizationSkill => ({
  id:
    name === 'wiki-authoring'
      ? '3c6f9a72-ae12-454b-bfc1-c653d9371498'
      : name === 'alpha'
        ? '62e7fd9c-51dd-41e3-883d-d5f027de9053'
        : 'ef1a782d-cb10-4db5-97d6-cb8dc029ae58',
  name,
  rootPageId: 12,
  rootPath,
  assetFolderId: null,
  status: 'disabled',
  exposureMode: 'all_agent_users',
  currentVersionId: null,
  currentContentHash: null,
  approvedSourceRevision: null,
  liveSourceRevision: 'source-1',
  drifted: false,
  groupIds: []
})
const organizationDependencies = (skills: OrganizationSkill[], failSources = false) => ({
  sameOriginJsonFetch: vi.fn(async (_fetcher: unknown, url: string) => {
    if (url.startsWith('/_api/agents/admin/skills/sources?')) {
      if (failSources) throw new Error('Untrusted internal source error')
      return new Response(JSON.stringify({ namespace: '_skills', pages: [], hasMore: false }))
    }
    return new Response(JSON.stringify(url === '/_api/groups' ? [] : { skills }))
  })
})

afterEach(() => {
  for (const mounted of mountedApps.splice(0)) {
    mounted.app.unmount()
    mounted.host.remove()
  }
  resetBody()
})

describe('Clearable skill inventory searches', () => {
  it('restores both personal and organization lists when the search clear control emits null', async () => {
    const personal = mountInventory(
      personalInventory,
      personalDependencies(() => [personalSkill('alpha'), personalSkill('beta')])
    )
    await settle()
    await enterText(field<HTMLInputElement>('.personal-inventory__search input'), 'alpha')
    expect(document.body.querySelectorAll('.personal-skill-item')).toHaveLength(1)
    field<HTMLElement>('.personal-inventory__search .v-field__clearable .v-icon').click()
    await yieldEventLoop()
    await settle()
    expect(document.body.querySelectorAll('.personal-skill-item')).toHaveLength(2)
    expect(personal.errors).toEqual([])
    personal.model.value = false
    await settle()

    const organization = mountInventory(organizationInventory, organizationDependencies([organizationSkill('alpha'), organizationSkill('beta')]))
    await settle()
    await enterText(field<HTMLInputElement>('.skill-inventory-toolbar__search input'), 'alpha')
    expect(organization.host.querySelectorAll('.skill-record')).toHaveLength(1)
    field<HTMLElement>('.skill-inventory-toolbar__search .v-field__clearable .v-icon').click()
    await yieldEventLoop()
    await settle()
    expect(organization.host.querySelectorAll('.skill-record')).toHaveLength(2)
    expect(organization.errors).toEqual([])
  })
})

describe('Personal skill source ownership', () => {
  it('updates an untouched frontmatter name but keeps manual source edits when the name field changes', async () => {
    const dependencies = personalDependencies(() => [])
    const mounted = mountInventory(personalInventory, dependencies)
    await settle()
    const name = field<HTMLInputElement>('.personal-editor input')
    const source = field<HTMLTextAreaElement>('.personal-editor textarea')
    await enterText(name, 'initial-name')
    expect(source.value).toContain('\nname: initial-name\n')

    const manualSource = source.value.replace(/^name:[^\r\n]*/m, 'name: manually-edited-name')
    await enterText(source, manualSource)
    await enterText(name, 'different-field-name')
    expect(source.value).toBe(manualSource)
    expect(dependencies.createPersonalAgentSkill).not.toHaveBeenCalled()
    expect(mounted.errors).toEqual([])
  })
})

describe('Personal skill refresh reconciliation', () => {
  it('resets a clean deleted editor instead of keeping the removed skill as an implicit create draft', async () => {
    const removed = personalSkill('removed-skill')
    let skills = [removed]
    const dependencies = personalDependencies(() => skills)
    const mounted = mountInventory(personalInventory, dependencies)
    await settle()
    field<HTMLElement>('.personal-skill-item').click()
    await settle()
    buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.removeSkill')).click()
    await settle()
    expect(field<HTMLInputElement>('.personal-editor input').value).toBe('removed-skill')
    skills = []
    await refreshPersonal(mounted)
    expect(field<HTMLInputElement>('.personal-editor input').value).not.toBe('removed-skill')
    expect(field<HTMLTextAreaElement>('.personal-editor textarea').value).not.toContain('Original instructions')
    expect(buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.createSkill')).disabled).toBe(false)
    expect(dependencies.createPersonalAgentSkill).not.toHaveBeenCalled()
    expect(dependencies.updatePersonalAgentSkill).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(translateEnglish('common:agentPersonalSkills.removeTargetNoLongerAvailable'))
    expect(dependencies.removePersonalAgentSkill).not.toHaveBeenCalled()
  })

  it('preserves a dirty removed draft, blocks recreation, and still requires an explicit discard choice', async () => {
    let skills = [personalSkill('removed-skill')]
    const dependencies = personalDependencies(() => skills)
    const mounted = mountInventory(personalInventory, dependencies)
    await settle()
    field<HTMLElement>('.personal-skill-item').click()
    await settle()
    await enterText(field<HTMLTextAreaElement>('.personal-editor textarea'), 'My unsaved instructions')
    buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.removeSkill')).click()
    await settle()
    skills = []
    await refreshPersonal(mounted)
    expect(field<HTMLTextAreaElement>('.personal-editor textarea').value).toBe('My unsaved instructions')
    expect(buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.saveRevision')).disabled).toBe(true)
    field<HTMLFormElement>('#personal-skill-form').dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(dependencies.createPersonalAgentSkill).not.toHaveBeenCalled()
    expect(dependencies.updatePersonalAgentSkill).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(translateEnglish('common:agentPersonalSkills.editedSkillRemoved'))
    expect(dependencies.removePersonalAgentSkill).not.toHaveBeenCalled()

    buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.newSkill')).click()
    await settle()
    expect(document.body.querySelector('#personal-discard-title')).not.toBeNull()
    buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.continueEditing')).click()
    await settle()
    expect(field<HTMLTextAreaElement>('.personal-editor textarea').value).toBe('My unsaved instructions')
    buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.newSkill')).click()
    await settle()
    buttonNamed(document.body, translateEnglish('common:agentPersonalSkills.discardChanges2')).click()
    await settle()
    expect(field<HTMLInputElement>('.personal-editor input').disabled).toBe(false)
    expect(mounted.errors).toEqual([])
  })
})

describe('Bundled organization skill identity', () => {
  it('loads namespace metadata before Create is opened and identifies only the reserved root path', async () => {
    for (const rootPath of ['_skills/wiki-authoring', 'handbook/wiki-authoring']) {
      const dependencies = organizationDependencies([organizationSkill('wiki-authoring', rootPath)])
      const mounted = mountInventory(organizationInventory, dependencies)
      await settle()
      const reviewAction = Array.from(mounted.host.querySelectorAll('button')).find(
        button => button.textContent?.trim() === translateEnglish('admin:skillAdmin.reviewSource')
      )
      expect(Boolean(reviewAction)).toBe(rootPath.startsWith('_skills/'))
      expect(document.body.querySelector('#skill-create-title')).toBeNull()
      expect(mounted.errors).toEqual([])
      mounted.app.unmount()
      mounted.host.remove()
      mountedApps.splice(
        mountedApps.findIndex(app => app.host === mounted.host),
        1
      )
    }
  })

  it('keeps the inventory usable when source metadata fails and shows only a safe independent message', async () => {
    const mounted = mountInventory(organizationInventory, organizationDependencies([organizationSkill('alpha')], true))
    await settle()
    expect(mounted.host.querySelectorAll('.skill-record')).toHaveLength(1)
    expect(mounted.host.textContent).toContain(translateEnglish('admin:skillAdmin.sourcePagesCouldNot'))
    expect(mounted.host.textContent).not.toContain('Untrusted internal source error')
    expect(buttonNamed(mounted.host, translateEnglish('admin:skillAdmin.retrySourceSearch'))).toBeDefined()
    expect(mounted.errors).toEqual([])
  })
})

describe('Organization skill source selection', () => {
  it('keeps selected references read-only and retains them for manual editing after clearing the page', async () => {
    const sourcePage = { id: 42, title: 'Guidance source', path: '_skills/guidance', locale: 'en' }
    const dependencies = {
      sameOriginJsonFetch: vi.fn(async (_fetcher: unknown, url: string) => {
        if (url.startsWith('/_api/agents/admin/skills/sources?')) {
          return new Response(JSON.stringify({ namespace: '_skills', pages: [sourcePage], hasMore: false }))
        }
        return new Response(JSON.stringify(url === '/_api/groups' ? [] : { skills: [] }))
      })
    }
    const mounted = mountInventory(organizationInventory, dependencies)
    await settle()
    buttonNamed(mounted.host, translateEnglish('admin:skillAdmin.mapOrganizationSkill')).click()
    await settle()
    const picker = field<HTMLInputElement>('#skill-create-form .v-autocomplete input')
    picker.dispatchEvent(new browserWindow.MouseEvent('mousedown', { bubbles: true }))
    await settle()
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('.v-list-item')).find(
      item => item.querySelector('.v-list-item-title')?.textContent?.trim() === sourcePage.title
    )
    if (!option) throw new Error('The source page option did not render')
    option.click()
    await settle()

    const rootPageId = field<HTMLInputElement>('.skill-source-references input[type="number"]')
    const rootPath = field<HTMLInputElement>('.skill-form-grid__wide input')
    expect(rootPageId.value).toBe(String(sourcePage.id))
    expect(rootPath.value).toBe(sourcePage.path)
    expect(rootPageId.readOnly).toBe(true)
    expect(rootPath.readOnly).toBe(true)
    field<HTMLElement>('#skill-create-form .v-autocomplete .v-field__clearable .v-icon').click()
    await yieldEventLoop()
    await settle()
    expect(rootPageId.readOnly).toBe(false)
    expect(rootPath.readOnly).toBe(false)
    expect(rootPageId.value).toBe(String(sourcePage.id))
    expect(rootPath.value).toBe(sourcePage.path)

    await enterText(rootPageId, '84')
    await enterText(rootPath, 'handbook/guidance')
    expect(rootPageId.value).toBe('84')
    expect(rootPath.value).toBe('handbook/guidance')
    expect(mounted.errors).toEqual([])
  })
})

describe('Rendered memory recovery boundaries', () => {
  const entry = {
    id: 'memory-1',
    target: 'user' as const,
    content: 'Prefer concise answers',
    version: 3,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z'
  }
  const view = (entries: AgentMemoryEntry[] = [entry]): AgentMemoryView => ({
    user: { entries, characters: entries.reduce((sum, memory) => sum + memory.content.length, 0), limit: 1375 },
    agent: { entries: [], characters: 0, limit: 2200 }
  })
  const dependencies = (read: () => AgentMemoryView) => ({
    getAgentMemories: vi.fn(async () => read()),
    createAgentMemory: vi.fn(),
    updateAgentMemory: vi.fn(),
    removeAgentMemory: vi.fn(),
    clearAgentMemories: vi.fn(async () => undefined)
  })

  it.each([false, true])('preserves a conflicting draft and visible resolution choices on keyboard Escape (removed=%s)', async removed => {
    let memories = view()
    const api = dependencies(() => memories)
    const mounted = mountInventory(memoryInventory, api)
    await settle()
    buttonNamed(document.body, translateEnglish('common:actions.edit')).click()
    await settle()
    await enterText(field<HTMLTextAreaElement>('.agent-memory__editor textarea'), 'Keep my unsaved draft')
    memories = view(removed ? [] : [{ ...entry, content: 'Changed elsewhere', version: 4 }])
    await refreshPersonal(mounted)

    field<HTMLTextAreaElement>('.agent-memory__editor textarea').dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    await settle()
    expect(field<HTMLTextAreaElement>('.agent-memory__editor textarea').value).toBe('Keep my unsaved draft')
    const warning = field<HTMLElement>('.agent-memory__editor-warning')
    expect(buttonNamed(warning, translateEnglish(removed ? 'common:agentMemoryManager.discardDraft' : 'common:agentMemoryManager.keepMyText')).disabled).toBe(
      false
    )
    if (!removed) {
      expect(buttonNamed(warning, translateEnglish('common:agentMemoryManager.useRefreshedRecord')).disabled).toBe(false)
      buttonNamed(warning, translateEnglish('common:agentMemoryManager.keepMyText')).click()
      await settle()
      expect(field<HTMLTextAreaElement>('.agent-memory__editor textarea').value).toBe('Keep my unsaved draft')
      expect(document.body.querySelector('.agent-memory__editor-warning')).toBeNull()
    }
    expect(api.createAgentMemory).not.toHaveBeenCalled()
    expect(api.updateAgentMemory).not.toHaveBeenCalled()
    expect(mounted.errors).toEqual([])
  })

  it('blocks rendered Clear after the record count changes until cancellation and fresh review', async () => {
    let memories = view()
    const api = dependencies(() => memories)
    const mounted = mountInventory(memoryInventory, api)
    await settle()
    buttonNamed(document.body, translateEnglish('common:agentMemory.clearAll')).click()
    await settle()
    memories = view([entry, { ...entry, id: 'memory-2', content: 'Another preference' }])
    await refreshPersonal(mounted)

    const dialog = field<HTMLElement>('.agent-memory__dialog')
    expect(Array.from(dialog.querySelectorAll('p'), paragraph => paragraph.textContent?.match(/\d+/)?.[0])).toEqual(['1', '2'])
    const confirm = buttonNamed(dialog, translateEnglish('common:agentMemoryManager.clearMemory'))
    expect(confirm.disabled).toBe(true)
    confirm.click()
    await settle()
    expect(api.clearAgentMemories).not.toHaveBeenCalled()
    buttonNamed(dialog, translateEnglish('common:agentMemoryManager.keepMemories')).click()
    await settle()
    buttonNamed(document.body, translateEnglish('common:agentMemory.clearAll')).click()
    await settle()
    const reviewed = field<HTMLElement>('.agent-memory__dialog')
    expect(Array.from(reviewed.querySelectorAll('p'), paragraph => paragraph.textContent?.match(/\d+/)?.[0])).toEqual(['2', '2'])
    expect(buttonNamed(reviewed, translateEnglish('common:agentMemoryManager.clearMemory')).disabled).toBe(false)
    buttonNamed(reviewed, translateEnglish('common:agentMemoryManager.clearMemory')).click()
    await settle()
    expect(api.clearAgentMemories).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('.v-overlay--active .agent-memory__dialog')).toBeNull()
    expect(mounted.errors).toEqual([])
  })
})
