import type { ChainedCommands, Editor, JSONContent } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { fetchPageLinkSuggestions, searchPages } from '../../../helpers/pages-api.ts'
import type { BrowserFetch } from '../../../helpers/json-transport.ts'

interface MenuRange {
  kind: 'slash' | 'commands' | 'links'
  from: number
  to: number
  query: string
  inlineOnly: boolean
  authority: string
}
interface SlashAction {
  id: string
  label: string
  icon: string
  hint: string
  keywords?: string
  inlineSafe?: boolean
  run: (chain: ChainedCommands) => ChainedCommands
}
export interface DiscoveredPageLink {
  id: string | number
  title: string
  locale: string
  path: string
  visibility: 'public' | 'private'
  href: string
}
interface DiscoveryOptions {
  /** Null retires discovery; changes bind a new actor/document/authority generation. */
  authority?: () => string | null
  links?: {
    locale: () => string
    localizedPaths: boolean
    content: (page: DiscoveredPageLink) => JSONContent
    fetch?: BrowserFetch
    label: string
    emptyLabel: string
    loadingLabel: string
    errorLabel: string
  }
}
export type TiptapMenuDisposer = (() => void) & { invalidate: () => void }
type LocalInput = { from: number; to: number; text: string }

let menuSerial = 0

function inlineEligible(state: EditorState): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty || !selection.$from.parent.isTextblock) return false
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth)
    if (node.type.spec.code || /^(?:wikiSourceBlock|wikiSourceInline|wikiLink)$/.test(node.type.name)) return false
  }
  return !(state.storedMarks ?? selection.$from.marks()).some(mark => mark.type.spec.code || mark.type.name === 'link')
}

function emptyRoot(state: EditorState): boolean {
  const { $from } = state.selection
  return inlineEligible(state) && $from.depth === 1 && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0
}

function candidate(state: EditorState, range: MenuRange): MenuRange | null {
  if (!inlineEligible(state)) return null
  const { selection } = state
  const { $from } = selection
  if (range.from < $from.start() || range.from > selection.from) return null
  let plain = true
  state.doc.nodesBetween(range.from, selection.from, node => {
    if ((node.isInline && !node.isText) || node.marks.some(mark => mark.type.spec.code || mark.type.name === 'link')) plain = false
  })
  if (!plain) return null
  const text = state.doc.textBetween(range.from, selection.from)
  if (range.kind === 'slash') {
    if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || range.from !== $from.start() || $from.parentOffset !== $from.parent.content.size || $from.parent.firstChild?.marks.length) return null
    const match = /^\/([\p{L}\p{M}\p{N} -]{0,48})$/u.exec(text)
    return match ? { ...range, to: selection.from, query: match[1] ?? '' } : null
  }
  if (range.kind === 'links') {
    if (!/^\[\[[^[\]\r\n|]{0,128}$/u.test(text)) return null
    return { ...range, to: selection.from, query: text.slice(2) }
  }
  if (!/^[\p{L}\p{M}\p{N} -]{0,48}$/u.test(text)) return null
  if (!range.inlineOnly && ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || range.from !== $from.start() || $from.parentOffset !== $from.parent.content.size)) return null
  return { ...range, to: selection.from, query: text }
}

/** Detect even a replacement with identical bytes; changed text never belongs to this menu. */
function touchesRange(transaction: Transaction, range: MenuRange): boolean {
  let { from, to } = range
  for (const map of transaction.mapping.maps) {
    let touched = false
    map.forEach((start, end) => { if (start <= to && end >= from) touched = true })
    if (touched) return true
    from = map.map(from, -1)
    to = map.map(to, 1)
  }
  return false
}

/** One native picker: source stays literal until a current, owned choice succeeds. */
export function installTiptapSlashMenu(editor: Editor, actions: readonly SlashAction[], label: string, emptyLabel = 'No matching commands', options: DiscoveryOptions = {}): TiptapMenuDisposer {
  const key = new PluginKey<MenuRange | null>('wikiSlashMenu')
  const authority = options.authority ?? (() => '')
  const editorDOM = editor.view.dom
  const menu = document.createElement('div')
  menu.className = 'editor-tiptap-slash-menu'
  menu.id = `wiki-slash-${++menuSerial}`
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  let composing = false
  let detached = false
  let localInput: LocalInput | null = null
  let selected = 0
  let choices: readonly SlashAction[] = []
  let lastQuery = ''
  let renderedSignature = ''
  let request: { abort: AbortController; state: EditorState; range: MenuRange } | null = null
  let pages: DiscoveredPageLink[] = []
  let linkState: 'loading' | 'ready' | 'error' = 'loading'
  const viewport = window.visualViewport
  const noteLocalInput = (input: LocalInput) => {
    localInput = input
    // Native DOM changes may dispatch in a mutation-observer microtask. Never
    // carry their provenance into a later remote/network event.
    queueMicrotask(() => queueMicrotask(() => { if (localInput === input) localInput = null }))
  }
  const surfaceAvailable = () => {
    if (editorDOM.closest('[inert], [aria-hidden="true"], [contenteditable="false"]')) return false
    const modal = document.querySelector('.v-dialog.v-overlay--active, dialog[open]')
    const focusedOverlay = document.activeElement?.closest('.v-overlay--active, [role="dialog"]')
    return (!modal || modal.contains(editorDOM) || modal.contains(menu)) &&
      (!focusedOverlay || focusedOverlay.contains(editorDOM) || focusedOverlay.contains(menu))
  }
  const current = () => {
    if (detached || editor.isDestroyed || !editor.isEditable || editor.view.composing || composing || !surfaceAvailable()) return null
    const range = key.getState(editor.state)
    if (!range || authority() !== range.authority) return null
    const now = candidate(editor.state, range)
    return now && range.to === now.to && range.query === now.query ? now : null
  }
  const retireRequest = () => {
    request?.abort.abort()
    request = null
    pages = []
  }
  const close = () => {
    retireRequest()
    if (!editor.isDestroyed && !detached && key.getState(editor.state)) editor.view.dispatch(editor.state.tr.setMeta(key, 'close'))
  }
  const position = () => {
    const range = current()
    if (!range || menu.hidden) return
    const gutter = 8
    const left = (viewport?.offsetLeft ?? 0) + gutter
    const top = (viewport?.offsetTop ?? 0) + gutter
    const right = left + (viewport?.width ?? window.innerWidth) - gutter * 2
    const bottom = top + (viewport?.height ?? window.innerHeight) - gutter * 2
    menu.style.width = `${Math.min(280, Math.max(0, right - left))}px`
    menu.style.minWidth = `${Math.min(260, Math.max(0, right - left))}px`
    const caret = editor.view.coordsAtPos(range.to)
    const below = Math.max(0, bottom - caret.bottom - 4)
    const above = Math.max(0, caret.top - top - 4)
    const desired = Math.min(320, menu.scrollHeight)
    const placeBelow = below >= desired || below >= above
    menu.style.maxHeight = `${Math.min(320, placeBelow ? below : above)}px`
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(left, Math.min(caret.left, right - bounds.width))}px`
    menu.style.top = `${Math.max(top, Math.min(placeBelow ? caret.bottom + 4 : caret.top - bounds.height - 4, bottom - bounds.height))}px`
  }
  const updateSelection = () => {
    for (const [index, button] of menu.querySelectorAll('button').entries()) {
      button.classList.toggle('is-active', index === selected)
      button.tabIndex = index === selected ? 0 : -1
      if (index === selected) editorDOM.setAttribute('aria-activedescendant', button.id)
    }
  }
  const execute = (action: SlashAction) => {
    const range = current()
    if (!range || !choices.includes(action)) return
    if (range.kind === 'links' && (!request || request.state.doc !== editor.state.doc || !request.state.selection.eq(editor.state.selection) || request.abort.signal.aborted)) return
    if (!action.run(editor.can().chain().deleteRange({ from: range.from, to: range.to })).run()) return
    // Separate this atomic replacement from both trigger typing and subsequent input.
    const chain = editor.chain().command(({ tr }) => { closeHistory(tr); tr.setMeta(key, 'close'); return true }).deleteRange({ from: range.from, to: range.to })
    if (action.run(chain).run()) {
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.commands.focus()
    }
    close()
  }
  const discover = (range: MenuRange) => {
    if (!options.links) return
    if (request && request.state.doc === editor.state.doc && request.state.selection.eq(editor.state.selection) && request.range.authority === range.authority) return
    retireRequest()
    const owned = { abort: new AbortController(), state: editor.state, range }
    request = owned
    linkState = 'loading'
    const live = () => request === owned && !owned.abort.signal.aborted && !!current() &&
      owned.state.doc === editor.state.doc && owned.state.selection.eq(editor.state.selection)
    const fetchImpl = options.links.fetch ?? fetch
    const fetchOwned: BrowserFetch = (input, init) => fetchImpl(input, { ...init, signal: owned.abort.signal })
    const query = range.query.trim()
    const results = query.startsWith('/') || !query
      ? fetchPageLinkSuggestions(fetchOwned, { locale: options.links.locale(), pathPrefix: query || '/', limit: 20, signal: owned.abort.signal })
      : searchPages(fetchOwned, query, { locale: options.links.locale() }).then(result => result.results.slice(0, 20).map(page => ({
          id: page.id, title: page.title, locale: page.locale, path: page.path, visibility: page.visibility,
          href: `${page.visibility === 'private' ? '/_private' : ''}/${page.visibility === 'private' || options.links!.localizedPaths ? `${encodeURIComponent(page.locale)}/` : ''}${page.path.split('/').map(encodeURIComponent).join('/')}`
        })))
    void results.then(result => {
      if (!live()) return
      pages = result
      linkState = 'ready'
      render()
    }).catch(() => {
      if (!live()) return
      pages = []
      linkState = 'error'
      render()
    })
  }
  const render = () => {
    const range = current()
    if (!range && key.getState(editor.state)) {
      // View-only changes (notably setEditable) must retire plugin ownership,
      // not merely hide it until the same literal trigger becomes editable again.
      close()
      return
    }
    menu.hidden = !range
    editorDOM.removeAttribute('aria-activedescendant')
    if (!range) {
      retireRequest()
      editorDOM.removeAttribute('aria-controls')
      menu.removeAttribute('aria-busy')
      menu.replaceChildren()
      selected = 0
      lastQuery = ''
      choices = []
      renderedSignature = ''
      return
    }
    editorDOM.setAttribute('aria-controls', menu.id)
    menu.dataset.kind = range.kind
    menu.setAttribute('aria-label', range.kind === 'links' ? options.links!.label : label)
    if (lastQuery !== range.query) selected = 0
    lastQuery = range.query
    const query = range.query.trim().toLocaleLowerCase()
    if (range.kind === 'links') discover(range)
    else retireRequest()
    const signature = `${range.kind}:${range.inlineOnly}:${range.query}:${range.kind === 'links' ? linkState : ''}`
    if (renderedSignature === signature) {
      updateSelection()
      position()
      return
    }
    renderedSignature = signature
    choices = range.kind === 'links'
      ? pages.map((page, index) => ({ id: `page-${index}`, label: page.title, icon: 'mdi-link', hint: page.href, run: chain => chain.insertContent(options.links!.content(page)) }))
      : actions.filter(action => (!range.inlineOnly || action.inlineSafe === true) && `${action.label} ${action.keywords ?? ''}`.toLocaleLowerCase().includes(query))
    menu.setAttribute('aria-busy', String(range.kind === 'links' && linkState === 'loading'))
    selected = Math.min(selected, Math.max(0, choices.length - 1))
    menu.replaceChildren()
    for (const [index, action] of choices.entries()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.id = `${menu.id}-${action.id}`
      button.setAttribute('aria-label', action.label)
      const icon = document.createElement('span')
      icon.className = `editor-tiptap-slash-icon mdi ${action.icon}`
      icon.setAttribute('aria-hidden', 'true')
      const title = document.createElement('span')
      title.className = 'editor-tiptap-slash-title'
      title.textContent = action.label
      const hint = document.createElement('span')
      hint.className = 'editor-tiptap-slash-hint'
      hint.textContent = action.hint
      if (range.kind === 'links') {
        hint.id = `${button.id}-destination`
        button.setAttribute('aria-describedby', hint.id)
      } else hint.setAttribute('aria-hidden', 'true')
      button.append(icon, title, hint)
      button.setAttribute('role', 'menuitem')
      button.tabIndex = index === selected ? 0 : -1
      button.classList.toggle('is-active', index === selected)
      if (index === selected) editorDOM.setAttribute('aria-activedescendant', button.id)
      button.addEventListener('pointerdown', event => event.preventDefault())
      button.addEventListener('click', () => execute(action))
      button.addEventListener('keydown', event => { if (handleKey(event)) event.preventDefault() })
      button.addEventListener('pointermove', () => {
        if (selected === index) return
        selected = index
        updateSelection()
      })
      menu.append(button)
    }
    if (!choices.length) {
      const empty = document.createElement('div')
      empty.textContent = range.kind !== 'links' ? emptyLabel : linkState === 'loading' ? options.links!.loadingLabel : linkState === 'error' ? options.links!.errorLabel : options.links!.emptyLabel
      empty.setAttribute('role', 'status')
      menu.append(empty)
    }
    position()
  }
  const handleKey = (event: KeyboardEvent): boolean => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing || editor.view.composing || !editor.isEditable || authority() === null || !surfaceAvailable()) return false
    const target = event.target
    if (target instanceof Node && !editorDOM.contains(target) && !menu.contains(target)) return false
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.code === 'Space' || event.key === ' ')) {
      if (!inlineEligible(editor.state)) return false
      const range: MenuRange = { kind: 'commands', from: editor.state.selection.from, to: editor.state.selection.to, query: '', inlineOnly: !emptyRoot(editor.state), authority: authority()! }
      if (range.inlineOnly && !actions.some(action => action.inlineSafe)) return false
      editor.view.dispatch(editor.state.tr.setMeta(key, range))
      return true
    }
    if (!current()) return false
    if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const { from, to } = editor.state.selection
      noteLocalInput({ from: Math.max(0, from - 1), to, text: '' })
    }
    if (event.key === 'Escape') {
      close()
      editor.commands.focus()
      return true
    }
    if (event.key === 'Tab') { close(); return false }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && choices.length) {
      const menuFocused = menu.contains(document.activeElement)
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
      updateSelection()
      const button = menu.querySelectorAll('button')[selected]
      if (menuFocused) button?.focus({ preventScroll: true })
      button?.scrollIntoView({ block: 'nearest' })
      return true
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && choices[selected]) {
      execute(choices[selected])
      return true
    }
    return false
  }
  const outside = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node) && !editorDOM.contains(event.target as Node)) close()
  }
  const focusOut = (event: FocusEvent) => { if (!menu.contains(event.relatedTarget as Node | null)) close() }
  const reposition = () => { if (!editor.isDestroyed) position() }
  const detach = () => {
    detached = true
    retireRequest()
    document.removeEventListener('pointerdown', outside, true)
    menu.removeEventListener('focusout', focusOut)
    window.removeEventListener('resize', reposition)
    window.removeEventListener('scroll', reposition, true)
    viewport?.removeEventListener('resize', reposition)
    viewport?.removeEventListener('scroll', reposition)
    editorDOM.removeAttribute('aria-controls')
    editorDOM.removeAttribute('aria-activedescendant')
    menu.remove()
  }
  const plugin = new Plugin<MenuRange | null>({
    key,
    state: {
      init: () => null,
      apply: (transaction, previous, oldState, state) => {
        const input = localInput
        localInput = null
        const owner = authority()
        const meta = transaction.getMeta(key) as MenuRange | 'close' | undefined
        if (meta === 'close' || composing || editor.view.composing || !editor.isEditable || owner === null || !surfaceAvailable()) return null
        if (meta) return meta.authority === owner ? candidate(state, meta) : null
        const local = input && transaction.docChanged && oldState.tr.insertText(input.text, input.from, input.to).doc.eq(transaction.doc)
        if (previous) {
          if (previous.authority !== owner) return null
          if (!transaction.docChanged && !state.selection.eq(oldState.selection)) return null
          if (transaction.docChanged && !local && (touchesRange(transaction, previous) || !state.selection.eq(oldState.selection.map(transaction.doc, transaction.mapping)))) return null
          if (local && (input.from < previous.from || input.to > previous.to)) return null
          const mapped = transaction.mapping.mapResult(previous.from, -1)
          if (mapped.deleted) return null
          const next = candidate(state, { ...previous, from: mapped.pos })
          return next && (local || next.query === previous.query) ? next : null
        }
        if (!local || !inlineEligible(oldState) || input.from !== oldState.selection.from || input.to !== oldState.selection.to) return null
        if (input.text === '/' && emptyRoot(oldState)) {
          return candidate(state, { kind: 'slash', from: input.from, to: state.selection.from, query: '', inlineOnly: false, authority: owner })
        }
        if (!options.links || (input.text !== '[' && input.text !== '[[')) return null
        const { $from } = state.selection
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 3), $from.parentOffset)
        const opening = /(?:^|[^\[\\])(\[\[)$/u.exec(before)
        if (!opening) return null
        return candidate(state, { kind: 'links', from: state.selection.from - 2, to: state.selection.from, query: '', inlineOnly: true, authority: owner })
      }
    },
    props: {
      handleTextInput: (_view, from, to, text) => {
        if (key.getState(editor.state) || text === '/' || text === '[' || text === '[[') noteLocalInput({ from, to, text })
        return false
      },
      handleKeyDown: (_view, event) => handleKey(event),
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          if (event.defaultPrevented || event.isComposing) return false
          if (event.inputType === 'deleteContentBackward' && current()) {
            const { from, to } = editor.state.selection
            noteLocalInput({ from: Math.max(0, from - 1), to, text: '' })
          }
          return false
        },
        compositionstart: () => { composing = true; close(); return false },
        compositionend: () => { composing = false; return false },
        blur: (_view, event) => { focusOut(event); return false }
      }
    },
    view: view => {
      const host = view.dom.closest('.editor-tiptap') ?? view.dom.parentElement
      host?.append(menu)
      document.addEventListener('pointerdown', outside, true)
      menu.addEventListener('focusout', focusOut)
      window.addEventListener('resize', reposition)
      window.addEventListener('scroll', reposition, true)
      viewport?.addEventListener('resize', reposition)
      viewport?.addEventListener('scroll', reposition)
      render()
      return { update: render, destroy: detach }
    }
  })
  editor.registerPlugin(plugin, (newPlugin, plugins) => [newPlugin, ...plugins])
  return Object.assign(() => { detach(); editor.unregisterPlugin(key) }, { invalidate: close })
}
