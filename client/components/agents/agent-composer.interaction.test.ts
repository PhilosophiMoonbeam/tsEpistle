import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'

interface Ref<T> {
  value: T
}

interface TestSkill {
  readonly id: string
  readonly versionId: string
  readonly name: string
  readonly description: string
  readonly exposureMode: 'owner'
  readonly isAgentDiscoverable: boolean
}

interface KeyOptions {
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly isComposing?: boolean
}

interface SentMessage {
  readonly content: string
  readonly invokedSkillVersionIds: readonly string[]
  readonly mode: 'message' | 'goal'
  readonly complete: (success: boolean) => void
}

interface ComposerHarness {
  readonly draft: Ref<string>
  readonly goalMode: Ref<boolean>
  readonly selectedSkillIds: Ref<string[]>
  readonly activeCommandSkill: Ref<TestSkill | null>
  readonly activeCommandOptionId: Ref<string | undefined>
  readonly skillCommandOpen: Ref<boolean>
  readonly handleKeydown: (event: KeyboardEvent) => void
  readonly submit: () => void
  readonly toggleChatPinned: () => void
  readonly pinnedEvents: boolean[]
  readonly sent: SentMessage[]
}

class FakeElement {}
class FakeTextArea extends FakeElement {}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-composer.vue script block was not found')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))
const bindingNames = [
  'draft',
  'goalMode',
  'selectedSkillIds',
  'activeCommandSkill',
  'activeCommandOptionId',
  'skillCommandOpen',
  'handleKeydown',
  'submit',
  'toggleChatPinned'
]
const evaluateComposer = new Function(
  '{ computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch, defineProps, defineEmits, defineExpose, filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills, caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret, window, document, HTMLElement, HTMLTextAreaElement }',
  `${executableScript}\nreturn { ${bindingNames.join(', ')} }`
) as (dependencies: Record<string, unknown>) => Record<string, unknown>
let nextComposerId = 0
const testUseId = (): string => `agent-composer-test-${++nextComposerId}`

const makeSkill = (name: string, versionId = `${name}-version`): TestSkill => ({
  id: name,
  versionId,
  name,
  description: `${name} skill`,
  exposureMode: 'owner',
  isAgentDiscoverable: true
})

const makeEvent = (key: string, options: KeyOptions = {}): KeyboardEvent & { wasPrevented: () => boolean } => {
  let prevented = false
  return {
    key,
    shiftKey: options.shiftKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    isComposing: options.isComposing ?? false,
    preventDefault: () => {
      prevented = true
    },
    wasPrevented: () => prevented
  } as KeyboardEvent & { wasPrevented: () => boolean }
}

const loadComposer = (
  options: {
    readonly skills?: readonly TestSkill[]
    readonly preferredSkills?: readonly { skillId: string; versionId: string; sourcePath: string }[]
    readonly invocationLimit?: number
    readonly initialSkillVersionIds?: readonly string[]
    readonly initialMode?: 'message' | 'goal'
    readonly disabled?: boolean
    readonly sending?: boolean
    readonly canStop?: boolean
    readonly chatPinned?: boolean
    readonly chatPinDisabled?: boolean
  } = {}
): ComposerHarness => {
  const props = {
    disabled: options.disabled ?? false,
    sending: options.sending ?? false,
    canStop: options.canStop ?? false,
    skillsEnabled: true,
    goalsEnabled: true,
    skills: options.skills ?? [makeSkill('docs')],
    skillsLoading: false,
    skillsLoadError: '',
    skillsPartial: false,
    preferredSkills: options.preferredSkills ?? [],
    invocationLimit: options.invocationLimit ?? 3,
    statusLabel: 'Ready',
    statusTone: 'ready' as const,
    initialSkillVersionIds: options.initialSkillVersionIds,
    initialMode: options.initialMode,
    chatPinned: options.chatPinned ?? false,
    chatPinDisabled: options.chatPinDisabled ?? false
  }
  const sent: SentMessage[] = []
  const pinnedEvents: boolean[] = []
  const composer = evaluateComposer({
    computed: <T>(getter: () => T): Ref<T> => ({
      get value() {
        return getter()
      }
    }),
    nextTick: (callback?: () => void) => {
      callback?.()
      return Promise.resolve()
    },
    onBeforeUnmount: () => {},
    onMounted: () => {},
    ref: <T>(value: T): Ref<T> => ({ value }),
    useId: testUseId,
    useTemplateRef: <T>(_key: string): Ref<T | null> => ({ value: null }),
    watch: () => {},
    defineProps: () => props,
    defineEmits:
      () =>
      (event: string, ...args: unknown[]) => {
        if (event === 'send') {
          sent.push({
            content: String(args[0]),
            invokedSkillVersionIds: args[1] as readonly string[],
            mode: args[2] as 'message' | 'goal',
            complete: args[3] as (success: boolean) => void
          })
        } else if (event === 'update:chatPinned') {
          pinnedEvents.push(Boolean(args[0]))
        }
      },
    defineExpose: () => {},
    filterPreferredBuiltInSkills,
    filterSkillsForCommand,
    filterUserSelectableSkills,
    caretBoundsFromMirror,
    calculateComposerSizing,
    scrollTopForCaret,
    window: { getComputedStyle: () => ({}) },
    document: {},
    HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeTextArea
  }) as unknown as ComposerHarness
  return { ...composer, sent, pinnedEvents }
}

const press = (composer: ComposerHarness, key: string, options?: KeyOptions): KeyboardEvent & { wasPrevented: () => boolean } => {
  const event = makeEvent(key, options)
  composer.handleKeydown(event)
  return event
}

describe('Agent composer slash-command keyboard gates', () => {
  it('submits a no-match command literally and keeps Tab native', () => {
    const composer = loadComposer({ skills: [makeSkill('docs')] })
    composer.draft.value = '/unknown'

    const tab = press(composer, 'Tab')
    expect(tab.wasPrevented()).toBe(false)
    expect(composer.sent).toHaveLength(0)

    const enter = press(composer, 'Enter')
    expect(enter.wasPrevented()).toBe(true)
    expect(composer.sent.map(message => message.content)).toEqual(['/unknown'])
  })

  it('submits a disabled preferred result literally without assigning an active option', () => {
    const skill = makeSkill('docs')
    const composer = loadComposer({
      skills: [skill],
      preferredSkills: [{ skillId: skill.id, versionId: skill.versionId, sourcePath: 'built-in/docs' }]
    })
    composer.draft.value = '/docs'

    expect(composer.activeCommandSkill.value).toBeNull()
    expect(composer.activeCommandOptionId.value).toBeUndefined()
    expect(press(composer, 'Tab').wasPrevented()).toBe(false)
    expect(composer.sent).toHaveLength(0)

    press(composer, 'Enter')
    expect(composer.sent.map(message => message.content)).toEqual(['/docs'])
  })

  it('submits a command literally when the invocation limit disables every result', () => {
    const composer = loadComposer({
      skills: [makeSkill('docs'), makeSkill('code')],
      invocationLimit: 1,
      initialSkillVersionIds: ['already-selected-version']
    })
    composer.draft.value = '/'

    expect(composer.activeCommandSkill.value).toBeNull()
    expect(composer.activeCommandOptionId.value).toBeUndefined()
    expect(press(composer, 'Tab').wasPrevented()).toBe(false)
    expect(composer.sent).toHaveLength(0)

    const enter = press(composer, 'Enter')
    expect(enter.wasPrevented()).toBe(true)
    expect(composer.sent.map(message => message.content)).toEqual(['/'])
  })

  it('accepts a usable active suggestion without sending and preserves surrounding whitespace', () => {
    const composer = loadComposer({ skills: [makeSkill('docs')] })
    composer.draft.value = 'Explain /docs'

    const enter = press(composer, 'Enter')
    expect(enter.wasPrevented()).toBe(true)
    expect(composer.sent).toHaveLength(0)
    expect(composer.draft.value).toBe('Explain ')
    expect(composer.selectedSkillIds.value).toEqual(['docs-version'])
  })

  it('uses an explicit submit to send the literal draft even while a suggestion is open', () => {
    const composer = loadComposer({ initialMode: 'goal', initialSkillVersionIds: ['docs-version'] })
    composer.draft.value = '/docs'

    composer.submit()
    expect(composer.sent).toHaveLength(1)
    expect(composer.sent[0].content).toBe('/docs')
    expect(composer.sent[0].invokedSkillVersionIds).toEqual(['docs-version'])
    expect(composer.sent[0].mode).toBe('goal')
  })

  it('keeps Shift+Tab and Shift+Enter native, while Ctrl and Meta Enter send', () => {
    const shiftTabComposer = loadComposer()
    shiftTabComposer.draft.value = '/docs'
    expect(press(shiftTabComposer, 'Tab', { shiftKey: true }).wasPrevented()).toBe(false)
    expect(shiftTabComposer.sent).toHaveLength(0)

    const shiftEnterComposer = loadComposer()
    shiftEnterComposer.draft.value = '/docs'
    expect(press(shiftEnterComposer, 'Enter', { shiftKey: true }).wasPrevented()).toBe(false)
    expect(shiftEnterComposer.sent).toHaveLength(0)

    const ctrlEnterComposer = loadComposer()
    ctrlEnterComposer.draft.value = '/docs'
    expect(press(ctrlEnterComposer, 'Enter', { ctrlKey: true }).wasPrevented()).toBe(true)
    expect(ctrlEnterComposer.sent).toHaveLength(1)
    expect(ctrlEnterComposer.sent[0].content).toBe('/docs')

    const metaEnterComposer = loadComposer()
    metaEnterComposer.draft.value = '/docs'
    expect(press(metaEnterComposer, 'Enter', { metaKey: true }).wasPrevented()).toBe(true)
    expect(metaEnterComposer.sent).toHaveLength(1)
    expect(metaEnterComposer.sent[0].content).toBe('/docs')
  })

  it('leaves IME composition untouched and Escape dismisses only the command token', () => {
    const composing = loadComposer()
    composing.draft.value = '/docs'
    expect(press(composing, 'Enter', { isComposing: true }).wasPrevented()).toBe(false)
    expect(composing.sent).toHaveLength(0)

    const dismissed = loadComposer()
    dismissed.draft.value = 'Keep this /docs'
    const escapeEvent = press(dismissed, 'Escape')
    expect(escapeEvent.wasPrevented()).toBe(true)
    expect(dismissed.draft.value).toBe('Keep this /docs')
    expect(dismissed.skillCommandOpen.value).toBe(false)
  })
})

describe('Agent composer chat pin semantics', () => {
  it('emits a pin update while an active run has disabled the composer', () => {
    const activeRun = loadComposer({ disabled: true, sending: true, canStop: true })

    activeRun.toggleChatPinned()

    expect(activeRun.pinnedEvents).toEqual([true])
  })

  it('guards the pin update while workspace selection is unsettled', () => {
    const unsettled = loadComposer({ chatPinDisabled: true })

    unsettled.toggleChatPinned()

    expect(unsettled.pinnedEvents).toHaveLength(0)
  })

  it('emits an unpin update from the selected tonal state', () => {
    const pinned = loadComposer({ chatPinned: true })

    pinned.toggleChatPinned()

    expect(pinned.pinnedEvents).toEqual([false])
  })
})

describe('Agent composer instance accessibility', () => {
  it('keeps option IDs and descriptions distinct across instances', () => {
    const first = loadComposer()
    const second = loadComposer()
    first.draft.value = '/docs'
    second.draft.value = '/docs'

    expect(first.activeCommandOptionId.value).toBeDefined()
    expect(second.activeCommandOptionId.value).toBeDefined()
    expect(first.activeCommandOptionId.value).not.toBe(second.activeCommandOptionId.value)
  })
})
