import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { caretBoundsFromMirror, calculateComposerSizing, scrollTopForCaret } from './agent-composer-sizing.ts'

interface Ref<T> {
  value: T
}

interface FakeStyle {
  height: string
  overflowY: string
  minHeight: string
  maxHeight: string
  paddingTop: string
  paddingBottom: string
  lineHeight: string
  [key: string]: string
}

class FakeElement {
  readonly style: FakeStyle = {
    height: '',
    overflowY: '',
    minHeight: '40px',
    maxHeight: '100px',
    paddingTop: '8px',
    paddingBottom: '8px',
    lineHeight: '24px'
  }
  parentNode: FakeElement | null = null
  children: FakeElement[] = []
  textContent = ''
  private rectTop = 0

  setRectTop(top: number): void {
    this.rectTop = top
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentNode = this
      this.children.push(node)
    }
  }

  appendChild(node: FakeElement): void {
    this.append(node)
  }

  querySelector(_selector: string): FakeTextArea | null {
    return null
  }

  remove(): void {
    if (!this.parentNode) return
    this.parentNode.children = this.parentNode.children.filter(child => child !== this)
    this.parentNode = null
  }

  setAttribute(_name: string, _value: string): void {}

  getBoundingClientRect(): { top: number } {
    return { top: this.rectTop }
  }

  getClientRects(): Array<{ top: number; height: number }> {
    return [{ top: this.rectTop, height: 24 }]
  }
}

class FakeTextArea extends FakeElement {
  value = ''
  selectionStart = 0
  selectionEnd = 0
  selectionDirection: 'forward' | 'backward' = 'forward'
  clientWidth = 320
  clientHeight = 100
  scrollHeight = 100
  scrollTop = 0
}

interface FakeDocument {
  readonly body: FakeElement
  createElement: (tagName: string) => FakeElement
  createTextNode: (data: string) => { data: string }
}

interface ComposerHarness {
  readonly textarea: FakeTextArea
  readonly body: FakeElement
  readonly draft: Ref<string>
  readonly goalMode: Ref<boolean>
  readonly selectedSkillIds: Ref<string[]>
  readonly sendFailed: Ref<boolean>
  readonly submit: () => void
  readonly resizeInput: () => void
  readonly mounted: () => void
  readonly unmount: () => void
  readonly sent: Array<{ content: string; complete: (success: boolean) => void }>
}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-composer.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-composer.vue script block was not found')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

const createFakeDocument = (caretTop: () => number, mirrorTop: number): FakeDocument => {
  const body = new FakeElement()
  return {
    body,
    createElement: (tagName: string): FakeElement => {
      const element = new FakeElement()
      if (tagName === 'span') element.setRectTop(caretTop())
      if (tagName === 'div') element.setRectTop(mirrorTop)
      return element
    },
    createTextNode: (data: string) => ({ data })
  }
}

const loadComposer = (options: { caretTop?: () => number; mirrorTop?: number } = {}): ComposerHarness => {
  const textarea = new FakeTextArea()
  const caretTop = options.caretTop ?? (() => 0)
  const mirrorTop = options.mirrorTop ?? 0
  const document = createFakeDocument(caretTop, mirrorTop)
  const sent: ComposerHarness['sent'] = []
  const mountedCallbacks: Array<() => void> = []
  const unmountCallbacks: Array<() => void> = []
  const props = {
    disabled: false,
    sending: false,
    canStop: false,
    skillsEnabled: false,
    goalsEnabled: true,
    skills: [],
    preferredSkills: [],
    invocationLimit: 3
  }
  const evaluate = new Function(
    'computed',
    'nextTick',
    'onBeforeUnmount',
    'onMounted',
    'ref',
    'watch',
    'defineProps',
    'defineEmits',
    'defineExpose',
    'window',
    'document',
    'HTMLElement',
    'HTMLTextAreaElement',
    'filterSkillsForCommand',
    'caretBoundsFromMirror',
    'calculateComposerSizing',
    'scrollTopForCaret',
    `${executableScript}\nreturn { draft, goalMode, selectedSkillIds, sendFailed, submit, resizeInput, messageInput }`
  ) as (...dependencies: unknown[]) => {
    draft: Ref<string>
    goalMode: Ref<boolean>
    selectedSkillIds: Ref<string[]>
    sendFailed: Ref<boolean>
    submit: () => void
    resizeInput: () => void
    messageInput: Ref<{ $el: FakeElement; focus: () => void } | null>
  }
  const composer = evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    (callback?: () => void) => {
      callback?.()
      return Promise.resolve()
    },
    (callback: () => void) => unmountCallbacks.push(callback),
    (callback: () => void) => mountedCallbacks.push(callback),
    <T>(value: T): Ref<T> => ({ value }),
    () => {},
    () => props,
    () =>
      (event: string, ...args: unknown[]) => {
        if (event === 'send') sent.push({ content: String(args[0]), complete: args[3] as (success: boolean) => void })
      },
    () => {},
    {
      getComputedStyle: () => textarea.style,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document,
    FakeElement,
    FakeTextArea,
    () => [],
    caretBoundsFromMirror,
    calculateComposerSizing,
    scrollTopForCaret
  )
  const inputRoot = new FakeElement()
  inputRoot.querySelector = () => textarea
  composer.messageInput.value = { $el: inputRoot, focus: () => {} }
  return {
    textarea,
    body: document.body,
    draft: composer.draft,
    goalMode: composer.goalMode,
    selectedSkillIds: composer.selectedSkillIds,
    sendFailed: composer.sendFailed,
    submit: composer.submit,
    resizeInput: composer.resizeInput,
    mounted: () =>
      mountedCallbacks.forEach(callback => {
        callback()
      }),
    unmount: () =>
      unmountCallbacks.forEach(callback => {
        callback()
      }),
    sent
  }
}

describe('Agent composer sizing and caret behavior', () => {
  it('clamps input height at the minimum, content, and maximum while switching overflow at the cap', () => {
    expect(calculateComposerSizing(20, 40, 100)).toEqual({ height: 40, overflowing: false })
    expect(calculateComposerSizing(72, 40, 100)).toEqual({ height: 72, overflowing: false })
    expect(calculateComposerSizing(100, 40, 100)).toEqual({ height: 100, overflowing: false })
    expect(calculateComposerSizing(140, 40, 100)).toEqual({ height: 100, overflowing: true })

    const composer = loadComposer()
    composer.textarea.scrollHeight = 20
    composer.resizeInput()
    expect(composer.textarea.style.height).toBe('40px')
    expect(composer.textarea.style.overflowY).toBe('hidden')

    composer.textarea.scrollHeight = 72
    composer.resizeInput()
    expect(composer.textarea.style.height).toBe('72px')
    expect(composer.textarea.style.overflowY).toBe('hidden')

    composer.textarea.scrollHeight = 100
    composer.resizeInput()
    expect(composer.textarea.style.height).toBe('100px')
    expect(composer.textarea.style.overflowY).toBe('hidden')

    composer.textarea.scrollHeight = 140
    composer.resizeInput()
    expect(composer.textarea.style.height).toBe('100px')
    expect(composer.textarea.style.overflowY).toBe('auto')
  })

  it('shrinks back to the default height and clears stale scroll when content falls below the cap', () => {
    const composer = loadComposer()
    composer.textarea.scrollHeight = 180
    composer.textarea.scrollTop = 60
    composer.resizeInput()
    expect(composer.textarea.style.overflowY).toBe('auto')

    composer.textarea.scrollHeight = 32
    composer.resizeInput()
    expect(composer.textarea.style.height).toBe('40px')
    expect(composer.textarea.style.overflowY).toBe('hidden')
    expect(composer.textarea.scrollTop).toBe(0)
  })

  it('uses rendered mirror geometry to scroll a soft-wrapped caret below the viewport', () => {
    const composer = loadComposer({ caretTop: () => 700, mirrorTop: 100 })
    composer.textarea.value = 'A soft-wrapped paragraph with no newline characters '.repeat(20)
    composer.textarea.selectionStart = composer.textarea.value.length
    composer.textarea.selectionEnd = composer.textarea.value.length
    composer.textarea.scrollHeight = 500
    composer.mounted()
    composer.resizeInput()

    expect(caretBoundsFromMirror(700, 100, 24, 24)).toEqual({ top: 600, bottom: 624 })
    expect(composer.textarea.scrollTop).toBe(400)
  })

  it('scrolls the caret above and below the viewport while preserving an already-visible caret', () => {
    expect(
      scrollTopForCaret({
        scrollTop: 120,
        clientHeight: 100,
        scrollHeight: 500,
        paddingTop: 8,
        paddingBottom: 8,
        caret: { top: 80, bottom: 104 }
      })
    ).toBe(72)
    expect(
      scrollTopForCaret({
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 500,
        paddingTop: 8,
        paddingBottom: 8,
        caret: { top: 160, bottom: 184 }
      })
    ).toBe(92)
    expect(
      scrollTopForCaret({
        scrollTop: 120,
        clientHeight: 100,
        scrollHeight: 500,
        paddingTop: 8,
        paddingBottom: 8,
        caret: { top: 148, bottom: 172 }
      })
    ).toBe(120)
  })

  it('mounts one reusable caret mirror and removes it on unmount', () => {
    const composer = loadComposer()
    composer.mounted()
    composer.mounted()
    expect(composer.body.children).toHaveLength(1)
    composer.unmount()
    expect(composer.body.children).toHaveLength(0)
  })
})

describe('Agent composer send completion', () => {
  it('resets the draft, attachments, and goal mode only after a successful send', () => {
    const composer = loadComposer()
    composer.draft.value = 'start a goal'
    composer.selectedSkillIds.value.push('skill-version')
    composer.goalMode.value = true
    composer.submit()
    expect(composer.sent).toHaveLength(1)
    expect(composer.draft.value).toBe('start a goal')
    expect(composer.selectedSkillIds.value).toEqual(['skill-version'])
    expect(composer.goalMode.value).toBe(true)

    composer.sent[0].complete(true)
    expect(composer.draft.value).toBe('')
    expect(composer.selectedSkillIds.value).toEqual([])
    expect(composer.goalMode.value).toBe(false)
    expect(composer.sendFailed.value).toBe(false)
  })

  it('retains the draft and context for a failed send so it can be retried', () => {
    const composer = loadComposer()
    composer.draft.value = 'retry this request'
    composer.selectedSkillIds.value.push('skill-version')
    composer.goalMode.value = true
    composer.submit()
    composer.sent[0].complete(false)

    expect(composer.draft.value).toBe('retry this request')
    expect(composer.selectedSkillIds.value).toEqual(['skill-version'])
    expect(composer.goalMode.value).toBe(true)
    expect(composer.sendFailed.value).toBe(true)
  })
})
