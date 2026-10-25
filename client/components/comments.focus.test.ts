import { readFileSync } from 'node:fs'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document } from '../test/browser-dom.mts'
import {
  CommentApiError,
  createComment,
  deleteComment,
  fetchComment,
  fetchComments,
  fetchDiscussionAvailability,
  fetchMentionCandidates,
  updateComment
} from '../helpers/comments-api.ts'
import {
  composeDiscussionAnnotation,
  discussionAnnotationsChanged,
  focusDiscussionThread,
  jumpDiscussionAnnotation,
  onComposeDiscussionAnnotation,
  onFocusDiscussionThread
} from '../helpers/discussion-annotation-events.ts'
import { changeDiscussionAnnotation, isDiscussionAnchor } from '../helpers/discussion-annotations-api.ts'
import { renderSafeMarkdown } from '../helpers/safe-markdown.ts'
import type { DiscussionAnnotation, DiscussionAnnotationInput } from '../../shared/discussion-annotations.ts'
import validateValues from '../../shared/validation.ts'

// Vue runtime-dom must capture the browser document installed by browser-dom.
const Vue = await import('vue')
const filename = new URL('./comments.vue', import.meta.url).pathname
const descriptor = parse(readFileSync(filename, 'utf8')).descriptor
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.script!.content.replace(/^import .*$/gm, '').replace('export default', 'return'))
const compiled = compileTemplate({
  source: descriptor.template!.content,
  filename,
  id: 'comments-focus',
  preprocessLang: 'pug',
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw compiled.errors[0]
const render = new Function('Vue', compiled.code)(Vue)
const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })
const Textarea = Vue.defineComponent({
  inheritAttrs: false,
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      Vue.h('div', attrs, [
        Vue.h('textarea', {
          value: props.modelValue,
          disabled: props.disabled,
          onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
        })
      ])
  }
})
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})
const settle = async () => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}
const response = (id = 42) =>
  new Response(JSON.stringify({ id, content: 'Fetched edit content' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

type VisibleComment = {
  id: number
  replyTo: number
  authorName: string
  initials: string
  render: string
  createdAt: string
  updatedAt: string
  annotations: DiscussionAnnotation[]
  authorId?: number
}
type CommentsView = {
  ensureContext: () => void
  authorityReady: boolean
  isLoading: boolean
  hasLoadedOnce: boolean
  comments: VisibleComment[]
  editComment: (comment: VisibleComment) => Promise<void>
  editCommentCancel: () => void
  annotationDrafts: DiscussionAnnotationInput[]
  newcomment: string
  replyTo: number
  annotationErrors: Record<number, string>
  postComment: () => Promise<void>
  prepareFeedbackDraft: (content: string) => Promise<void>
  feedbackDraftActive: boolean
  feedbackDraftMessage: string
  noteComposerInput: () => void
  availability: { enabled: boolean; closed: boolean; canPost: boolean } | null
  changeAnnotationState: (comment: VisibleComment, annotation: DiscussionAnnotation) => Promise<void>
}
const mountComments = async (options: { write?: boolean; cold?: boolean; transport?: (url: string, init?: RequestInit) => Promise<Response> } = {}) => {
  let release!: (value: Response) => void
  const transport = vi.fn(
    options.transport ??
      (() =>
        new Promise<Response>(resolve => {
          release = resolve
        }))
  )
  const store = Vue.reactive({
    page: { id: 9, effectivePermissions: { comments: { read: true, write: options.write ?? false, manage: true } } },
    user: { id: 7, authenticated: true, authVersion: 3, email: 'reader@example.test', name: 'Reader' },
    offlineIdentityEpoch: 1,
    authRefreshSettled: true,
    authRefreshOutcome: 'authenticated',
    authRefreshPending: false,
    startLoading: vi.fn(),
    stopLoading: vi.fn(),
    showNotification: vi.fn()
  })
  const connection = Vue.reactive({ connectionState: 'online' })
  const goTo = vi.fn()
  const dependencies = {
    defineComponent: Vue.defineComponent,
    markRaw: Vue.markRaw,
    useGoTo: () => goTo,
    wikiStore: store,
    pwaState: connection,
    AsyncState: passthrough(),
    CommentReplyOptIn: passthrough(),
    CommentApiError,
    fetchComment,
    createComment,
    deleteComment,
    fetchComments,
    fetchDiscussionAvailability,
    fetchMentionCandidates,
    updateComment,
    changeDiscussionAnnotation,
    isDiscussionAnchor,
    discussionAnnotationsChanged,
    jumpDiscussionAnnotation,
    onComposeDiscussionAnnotation,
    onFocusDiscussionThread,
    renderSafeMarkdown,
    validateValues,
    showNotification: (_store: unknown, notification: unknown) => store.showNotification(notification),
    window: { fetch: transport, location: browserWindow.location },
    getErrorMessage: (error: Error) => error.message
  }
  const component = new Function(...Object.keys(dependencies), script)(...Object.values(dependencies))
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ ...component, render })
  for (const name of [
    'v-alert',
    'v-spacer',
    'v-icon',
    'v-timeline',
    'v-timeline-item',
    'v-card',
    'v-card-text',
    'v-card-actions',
    'v-avatar',
    'v-dialog',
    'v-tooltip'
  ]) {
    app.component(name, passthrough())
  }
  app.component('v-btn', passthrough('button'))
  app.component('v-textarea', Textarea)
  let intersect!: (visible: boolean) => void
  app.directive('intersect', {
    mounted(_element: Element, binding: { value: (visible: boolean, entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void }) {
      intersect = visible => binding.value(visible, [], {} as IntersectionObserver)
    }
  })
  app.config.globalProperties.$t = (key: string) => key
  app.config.globalProperties.$helpers = { formatMoment: () => 'Today' }
  // The compiled SFC boundary loses the Options API instance type.
  const comments = app.mount(host) as unknown as CommentsView
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  comments.ensureContext()
  if (!options.cold) {
    comments.authorityReady = true
    comments.isLoading = false
    comments.availability = { enabled: true, closed: false, canPost: true }
    comments.hasLoadedOnce = true
    comments.comments = [
      { id: 42, replyTo: 0, authorName: 'Author', initials: 'A', render: '<p>Original comment</p>', annotations: [], createdAt: '', updatedAt: '' }
    ]
  }
  await Vue.nextTick()
  const edit =
    host.querySelector<HTMLButtonElement>('button[aria-label="common:comments.edit"]') ??
    host.querySelector<HTMLButtonElement>('.comments-post-actions button')!
  return { comments, host, edit, store, connection, transport, goTo, intersect, release: (value: Response) => release(value) }
}

describe('passage discussion handoffs', () => {
  const anchor = { exact: 'A real passage', prefix: 'before ', suffix: ' after', heading: 'Guide', offset: 7 }
  const annotation: DiscussionAnnotation = {
    id: 8,
    commentId: 700,
    position: 0,
    anchor,
    note: '**A note**',
    revision: 1,
    resolvedAt: null,
    resolvedById: null,
    createdAt: '',
    updatedAt: ''
  }
  const root = {
    id: 700,
    pageId: 9,
    authorId: 7,
    authorName: 'Reader',
    authorHandle: 'reader',
    replyTo: 0,
    content: 'A thread',
    render: '<p>A thread</p>',
    annotations: [annotation],
    createdAt: '',
    updatedAt: ''
  }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  it('posts passages and notes in the one native root request, without an attach request', async () => {
    const { comments, transport } = await mountComments({
      write: true,
      transport: async (_url, init) =>
        json(init?.method === 'POST' ? { id: 700 } : _url.includes('/availability/') ? { enabled: true, closed: false, canPost: true } : [root])
    })
    composeDiscussionAnnotation(9, anchor)
    comments.annotationDrafts[0]!.note = '**A note**'
    comments.newcomment = 'A thread'
    await comments.postComment()
    const writes = transport.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]![1]!.body as string)).toMatchObject({
      pageId: 9,
      replyTo: 0,
      content: 'A thread',
      annotations: [{ anchor, note: '**A note**' }]
    })
    expect(comments.annotationDrafts).toEqual([])
  })
  it('bounds root captures, refuses reply captures, and clears all passage drafts on an account switch', async () => {
    const { comments, store } = await mountComments({ write: true })
    composeDiscussionAnnotation(10, anchor)
    expect(comments.annotationDrafts).toEqual([])
    comments.replyTo = 42
    composeDiscussionAnnotation(9, anchor)
    expect(comments.annotationDrafts).toEqual([])
    comments.replyTo = 0
    for (let index = 0; index < 9; index++) composeDiscussionAnnotation(9, { ...anchor, offset: index })
    expect(comments.annotationDrafts).toHaveLength(8)
    store.user.id = 8
    await Vue.nextTick()
    expect(comments.annotationDrafts).toEqual([])
  })
  it('loads and focuses a real older reply instead of reporting it missing from the initial view', async () => {
    const reply = { ...root, id: 701, replyTo: 700, annotations: [] }
    const { comments, host, transport } = await mountComments({
      write: true,
      transport: async url => json(url.includes('/availability/') ? { enabled: true, closed: false, canPost: true } : [root, reply])
    })
    comments.newcomment = 'Unrelated draft'
    focusDiscussionThread(9, 701)
    for (let index = 0; index < 4; index++) await settle()
    expect(transport.mock.calls.some(([url]) => url === '/_api/comments?pageId=9')).toBe(true)
    const target = host.querySelector('#comment-post-id-701')
    expect(target).not.toBeNull()
    expect(document.activeElement).toBe(target)
    expect(comments.newcomment).toBe('Unrelated draft')
  })
  it('reloads a conflicting annotation state without overwriting the unrelated root draft', async () => {
    const updated = { ...annotation, revision: 2, resolvedAt: '2026-10-15T12:00:00Z', resolvedById: 7 }
    const transport = async (url: string, init?: RequestInit) =>
      json(
        init?.method === 'PATCH'
          ? { error: 'Changed' }
          : url.includes('/availability/')
            ? { enabled: true, closed: false, canPost: true }
            : [{ ...root, annotations: [updated] }],
        init?.method === 'PATCH' ? 409 : 200
      )
    const previous = browserWindow.fetch
    browserWindow.fetch = transport as typeof fetch
    cleanups.push(() => {
      browserWindow.fetch = previous
    })
    const { comments } = await mountComments({ write: true, transport })
    comments.comments = [{ ...root, initials: 'R' }]
    comments.newcomment = 'Keep my draft'
    composeDiscussionAnnotation(9, anchor)
    comments.annotationDrafts[0]!.note = 'Unposted note'
    await comments.changeAnnotationState(comments.comments[0]!, annotation)
    expect(comments.comments[0]!.annotations[0]!.revision).toBe(2)
    expect(comments.annotationErrors[8]).toContain('changed')
    expect(comments.newcomment).toBe('Keep my draft')
    expect(comments.annotationDrafts[0]!.note).toBe('Unposted note')
  })
})

describe('optional contextual feedback drafts', () => {
  const anchor = { exact: 'Keep this passage', prefix: '', suffix: '', heading: 'Guide', offset: 0 }
  const draft = 'Task: install the service\nExpected outcome: a running service\nWhat is missing: the final command'
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const writes = (calls: Array<[string, RequestInit?]>) => calls.filter(([, init]) => init?.method && init.method !== 'GET')

  for (const existing of ['comment', 'reply', 'passages'] as const) {
    it(`preserves an existing ${existing} instead of replacing it with rating feedback`, async () => {
      const { comments, host, transport } = await mountComments({ write: true })
      if (existing === 'comment') comments.newcomment = 'My unfinished comment'
      if (existing === 'reply') comments.replyTo = 42
      if (existing === 'passages') {
        composeDiscussionAnnotation(9, anchor)
        comments.annotationDrafts[0]!.note = 'My attached note'
      }
      await Vue.nextTick()
      const before = { content: comments.newcomment, replyTo: comments.replyTo, annotations: JSON.stringify(comments.annotationDrafts) }
      await comments.prepareFeedbackDraft(draft)
      await settle()
      expect(comments.newcomment).toBe(before.content)
      expect(comments.replyTo).toBe(before.replyTo)
      expect(JSON.stringify(comments.annotationDrafts)).toBe(before.annotations)
      expect(comments.feedbackDraftActive).toBe(false)
      const preservedNotice = host.querySelector('p[role="status"]')
      expect(preservedNotice).not.toBeNull()
      expect(writes(transport.mock.calls)).toEqual([])
    })
  }

  for (const cold of [false, true]) {
    it(`exposes editable feedback after fresh availability on a ${cold ? 'cold first' : 'warm'} handoff without posting`, async () => {
      const acl = Promise.withResolvers<void>()
      const { comments, host, transport, intersect } = await mountComments({
        write: true,
        cold,
        transport: async url => {
          if (!url.includes('/availability/')) return json([])
          await acl.promise
          return json({ enabled: true, closed: false, canPost: true })
        }
      })
      expect(transport).not.toHaveBeenCalled()
      const preparing = comments.prepareFeedbackDraft(draft)
      await Vue.nextTick()
      // A browser can deliver the cold pane's first intersection after the
      // explicit handoff has already started its availability read.
      if (cold) intersect(true)
      expect(comments.newcomment).toBe('')
      expect(comments.feedbackDraftActive).toBe(false)
      acl.resolve()
      await preparing
      await settle()
      const textarea = host.querySelector<HTMLTextAreaElement>('.comments-composer textarea')!
      expect(textarea.value).toBe(draft)
      expect(textarea.disabled).toBe(false)
      expect(document.activeElement).toBe(textarea)
      expect(host.querySelector('.comments-feedback-draft')).not.toBeNull()
      expect(comments.feedbackDraftActive).toBe(true)
      textarea.value = 'My edited feedback'
      textarea.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
      await settle()
      expect(comments.newcomment).toBe('My edited feedback')
      expect(writes(transport.mock.calls)).toEqual([])
    })
  }

  it('keeps a cold discussion lazy until its first visible intersection when no explicit handoff activates it', async () => {
    const { comments, transport, intersect } = await mountComments({
      cold: true,
      transport: async url => json(url.includes('/availability/') ? { enabled: true, closed: false, canPost: true } : [])
    })
    expect(transport).not.toHaveBeenCalled()
    intersect(false)
    expect(transport).not.toHaveBeenCalled()
    intersect(true)
    await settle()
    expect(transport.mock.calls.map(([url]) => url).sort()).toEqual(['/_api/comments/availability/9', '/_api/comments?pageId=9'].sort())
    expect(comments.feedbackDraftActive).toBe(false)
    expect(writes(transport.mock.calls)).toEqual([])
  })

  for (const outcome of ['closed', 'denied', 'owner-change', 'page-change', 'typing'] as const) {
    it(`does not replace the composer after a delayed ${outcome} availability response`, async () => {
      const acl = Promise.withResolvers<Response>()
      const { comments, host, store, transport } = await mountComments({
        write: true,
        transport: async url => (url.includes('/availability/') ? acl.promise : json([]))
      })
      const preparing = comments.prepareFeedbackDraft(draft)
      if (outcome === 'owner-change') store.user.id = 8
      if (outcome === 'page-change') store.page.id = 10
      if (outcome === 'typing') {
        comments.newcomment = 'Typed while access was checked'
        comments.noteComposerInput()
      }
      acl.resolve(
        outcome === 'denied'
          ? json({ error: 'No discussion access' }, 403)
          : json({ enabled: true, closed: outcome === 'closed', canPost: outcome !== 'closed' })
      )
      await preparing
      await settle()
      expect(comments.newcomment).toBe(outcome === 'typing' ? 'Typed while access was checked' : '')
      expect(comments.feedbackDraftActive).toBe(false)
      expect(host.querySelector('.comments-feedback-draft')).toBeNull()
      expect(writes(transport.mock.calls)).toEqual([])
    })
  }
})

describe('comment edit focus handoff', () => {
  it('moves focus from Edit into the rendered, enabled textarea after a successful read', async () => {
    const { comments, host, edit, release } = await mountComments()
    edit.focus()
    const request = comments.editComment(comments.comments[0])
    await Vue.nextTick()
    expect(host.querySelector('.comments-post-editcontent textarea')).toBeNull()
    release(response())
    await request
    await settle()
    const textarea = host.querySelector<HTMLTextAreaElement>('.comments-post-editcontent textarea')!
    expect(textarea.value).toBe('Fetched edit content')
    expect(textarea.disabled).toBe(false)
    expect(document.activeElement).toBe(textarea)
  })

  for (const outcome of ['failure', 'cancel', 'identity-change', 'transport-change', 'wrong-comment'] as const) {
    it(`does not steal focus after ${outcome}`, async () => {
      const { comments, host, store, connection, release } = await mountComments()
      const request = comments.editComment(comments.comments[0])
      await Vue.nextTick()
      const destination = document.createElement('button')
      host.append(destination)
      destination.focus()
      if (outcome === 'cancel') comments.editCommentCancel()
      if (outcome === 'identity-change') store.user.id = 8
      if (outcome === 'transport-change') connection.connectionState = 'offline'
      release(outcome === 'failure' ? new Response('{}', { status: 500 }) : response(outcome === 'wrong-comment' ? 43 : 42))
      await request
      await settle()
      expect(document.activeElement).toBe(destination)
      expect(host.querySelector('.comments-post-editcontent textarea')).toBeNull()
    })
  }
})
