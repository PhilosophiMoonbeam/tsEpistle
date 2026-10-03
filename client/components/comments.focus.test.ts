import { readFileSync } from 'node:fs'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document } from '../test/browser-dom.mts'
import { CommentApiError, fetchComment } from '../helpers/comments-api.ts'


// Vue runtime-dom must capture the browser document installed by browser-dom.
const Vue = await import('vue')
const filename = new URL('./comments.vue', import.meta.url).pathname
const descriptor = parse(readFileSync(filename, 'utf8')).descriptor
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script!.content.replace(/^import .*$/gm, '').replace('export default', 'return')
)
const compiled = compileTemplate({
  source: descriptor.template!.content, filename, id: 'comments-focus', preprocessLang: 'pug',
  preprocessOptions: { doctype: 'html' }, compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw compiled.errors[0]
const render = new Function('Vue', compiled.code)(Vue)
const passthrough = (tag = 'div') => Vue.defineComponent({
  setup(_props, { attrs, slots }) { return () => Vue.h(tag, attrs, slots.default?.()) }
})
const Textarea = Vue.defineComponent({
  inheritAttrs: false,
  props: ['modelValue', 'disabled'],
  setup(props, { attrs }) {
    return () => Vue.h('div', attrs, [Vue.h('textarea', { value: props.modelValue, disabled: props.disabled })])
  }
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const settle = async () => { await Promise.resolve(); await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick() }
const response = (id = 42) => new Response(JSON.stringify({ id, content: 'Fetched edit content' }), {
  status: 200, headers: { 'Content-Type': 'application/json' }
})


type VisibleComment = {
  id: number
  replyTo: number
  authorName: string
  initials: string
  render: string
  createdAt: string
  updatedAt: string
}
type CommentsView = {
  ensureContext: () => void
  authorityReady: boolean
  isLoading: boolean
  hasLoadedOnce: boolean
  comments: VisibleComment[]
  editComment: (comment: VisibleComment) => Promise<void>
  editCommentCancel: () => void
}
const mountComments = async () => {
  let release!: (value: Response) => void
  const transport = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
  const store = Vue.reactive({
    page: { id: 9, effectivePermissions: { comments: { write: false, manage: true } } },
    user: { id: 7, authenticated: true, name: 'Reader' },
    startLoading: vi.fn(), stopLoading: vi.fn(), showNotification: vi.fn()
  })
  const connection = Vue.reactive({ connectionState: 'online' })
  const dependencies = {
    defineComponent: Vue.defineComponent, markRaw: Vue.markRaw, useGoTo: () => vi.fn(),
    wikiStore: store, pwaState: connection, AsyncState: passthrough(), CommentApiError, fetchComment,
    window: { fetch: transport, location: browserWindow.location }, getErrorMessage: (error: Error) => error.message
  }
  const component = new Function(...Object.keys(dependencies), script)(...Object.values(dependencies))
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ ...component, render })
  for (const name of ['v-alert', 'v-spacer', 'v-icon', 'v-timeline', 'v-timeline-item', 'v-card', 'v-card-text', 'v-card-actions', 'v-avatar', 'v-dialog', 'v-tooltip']) {
    app.component(name, passthrough())
  }
  app.component('v-btn', passthrough('button'))
  app.component('v-textarea', Textarea)
  app.directive('intersect', {})
  app.config.globalProperties.$t = (key: string) => key
  app.config.globalProperties.$helpers = { formatMoment: () => 'Today' }
  // The compiled SFC boundary loses the Options API instance type.
  const comments = app.mount(host) as unknown as CommentsView
  cleanups.push(() => { app.unmount(); host.remove() })
  comments.ensureContext()
  comments.authorityReady = true
  comments.isLoading = false
  comments.hasLoadedOnce = true
  comments.comments = [{ id: 42, replyTo: 0, authorName: 'Author', initials: 'A', render: '<p>Original comment</p>', createdAt: '', updatedAt: '' }]
  await Vue.nextTick()
  const edit = host.querySelector<HTMLButtonElement>('button[aria-label="common:comments.edit"]')
    ?? host.querySelector<HTMLButtonElement>('.comments-post-actions button')!
  return { comments, host, edit, store, connection, release: (value: Response) => release(value) }
}

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
