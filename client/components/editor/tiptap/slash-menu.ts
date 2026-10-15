import type { ChainedCommands, Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'

interface SlashRange {
  from: number
  to: number
  query: string
}
interface SlashAction {
  id: string
  label: string
  keywords?: string
  run: (chain: ChainedCommands) => ChainedCommands
}

let menuSerial = 0

function candidate(state: EditorState): SlashRange | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null
  const { $from } = selection
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return null
  if ($from.parent.childCount !== 1 || !$from.parent.firstChild?.isText || $from.parent.firstChild.marks.length) return null
  const match = /^\/([\p{L}\p{M}\p{N} -]{0,48})$/u.exec($from.parent.textContent)
  return match ? { from: $from.start(), to: selection.from, query: match[1] ?? '' } : null
}

/** Private editor integration: the trigger stays in the document until a command succeeds. */
export function installTiptapSlashMenu(editor: Editor, actions: readonly SlashAction[], label: string, emptyLabel = 'No matching commands'): () => void {
  const key = new PluginKey<SlashRange | null>('wikiSlashMenu')
  const editorDOM = editor.view.dom
  const menu = document.createElement('div')
  menu.className = 'editor-tiptap-slash-menu'
  menu.id = `wiki-slash-${++menuSerial}`
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', label)
  menu.hidden = true
  let composing = false
  let localInput: { from: number; to: number; text: string } | null = null
  let localDeletion = false
  let selected = 0
  let choices: readonly SlashAction[] = []
  let lastQuery = ''
  const close = () => {
    if (!editor.isDestroyed && key.getState(editor.state)) editor.view.dispatch(editor.state.tr.setMeta(key, 'close'))
  }
  const current = () => {
    if (editor.isDestroyed || !editor.isEditable || editor.view.composing || composing) return null
    const range = key.getState(editor.state)
    const now = candidate(editor.state)
    return range && now && range.from === now.from && range.to === now.to && range.query === now.query ? now : null
  }
  const execute = (action: SlashAction) => {
    const range = current()
    if (!range || !choices.includes(action)) return
    if (!action.run(editor.can().chain().deleteRange({ from: range.from, to: range.to })).run()) return
    // Both edits belong to one native transaction, so Undo never leaves a half-applied command.
    const chain = editor.chain().deleteRange({ from: range.from, to: range.to })
    if (action.run(chain).run()) editor.commands.focus()
    close()
  }
  const render = () => {
    if (!editor.isEditable && key.getState(editor.state)) {
      close()
      return
    }
    const range = current()
    menu.hidden = !range
    editor.view.dom.removeAttribute('aria-activedescendant')
    if (!range) {
      editor.view.dom.removeAttribute('aria-controls')
      selected = 0
      lastQuery = ''
      choices = []
      return
    }
    editor.view.dom.setAttribute('aria-controls', menu.id)
    if (lastQuery !== range.query) selected = 0
    lastQuery = range.query
    const query = range.query.trim().toLocaleLowerCase()
    choices = actions.filter(action => `${action.label} ${action.keywords ?? ''}`.toLocaleLowerCase().includes(query))
    selected = Math.min(selected, Math.max(0, choices.length - 1))
    menu.replaceChildren()
    for (const [index, action] of choices.entries()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.id = `${menu.id}-${action.id}`
      button.textContent = action.label
      button.setAttribute('role', 'menuitem')
      button.tabIndex = index === selected ? 0 : -1
      button.classList.toggle('is-active', index === selected)
      if (index === selected) editor.view.dom.setAttribute('aria-activedescendant', button.id)
      button.addEventListener('pointerdown', event => event.preventDefault())
      button.addEventListener('click', () => execute(action))
      button.addEventListener('keydown', event => {
        if (handleKey(event)) event.preventDefault()
      })
      button.addEventListener('pointermove', () => {
        if (selected === index) return
        selected = index
        editor.view.dom.setAttribute('aria-activedescendant', button.id)
        for (const [otherIndex, other] of [...menu.querySelectorAll('button')].entries()) {
          other.classList.toggle('is-active', otherIndex === selected)
          other.tabIndex = otherIndex === selected ? 0 : -1
        }
      })
      menu.append(button)
    }
    if (!choices.length) {
      const empty = document.createElement('div')
      empty.textContent = emptyLabel
      empty.setAttribute('role', 'status')
      menu.append(empty)
    }
    const caret = editor.view.coordsAtPos(range.to)
    menu.style.left = `${Math.max(8, Math.min(caret.left, window.innerWidth - 288))}px`
    menu.style.top = `${caret.bottom + menu.offsetHeight + 4 > window.innerHeight ? Math.max(8, caret.top - menu.offsetHeight - 4) : caret.bottom + 4}px`
  }
  const handleKey = (event: KeyboardEvent): boolean => {
    if (event.isComposing || event.keyCode === 229 || !current()) return false
    if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) localDeletion = true
    if (event.key === 'Escape') {
      close()
      editor.commands.focus()
      return true
    }
    if (event.key === 'Tab') {
      close()
      return false
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && choices.length) {
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
      render()
      menu.querySelectorAll('button')[selected]?.scrollIntoView({ block: 'nearest' })
      return true
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && choices[selected]) {
      execute(choices[selected])
      return true
    }
    return false
  }
  const outside = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node) && !editor.view.dom.contains(event.target as Node)) close()
  }
  const focusOut = (event: FocusEvent) => {
    if (!menu.contains(event.relatedTarget as Node | null)) close()
  }
  const reposition = () => {
    if (!editor.isDestroyed) render()
  }
  const detach = () => {
    document.removeEventListener('pointerdown', outside, true)
    menu.removeEventListener('focusout', focusOut)
    window.removeEventListener('resize', reposition)
    window.removeEventListener('scroll', reposition, true)
    editorDOM.removeAttribute('aria-controls')
    editorDOM.removeAttribute('aria-activedescendant')
    menu.remove()
  }
  const plugin = new Plugin<SlashRange | null>({
    key,
    state: {
      init: () => null,
      apply: (transaction, previous, oldState, state) => {
        const input = localInput
        const deletion = localDeletion
        localInput = null
        localDeletion = false
        if (transaction.getMeta(key) === 'close' || composing || editor.view.composing || !editor.isEditable) return null
        const next = candidate(state)
        if (!next) return null
        if (previous) {
          const mapped = transaction.mapping.mapResult(previous.from, -1)
          if (mapped.deleted || next.from !== mapped.pos) return null
          // Remote changes may move the line, never alter/replace the active command query.
          if (transaction.docChanged && next.query !== previous.query) {
            const before = `/${previous.query}`
            const expected =
              input && input.from >= previous.from && input.to <= previous.to
                ? before.slice(0, input.from - previous.from) + input.text + before.slice(input.to - previous.from)
                : null
            if (`/${next.query}` !== expected && !(deletion && previous.query.startsWith(next.query) && next.query.length < previous.query.length)) return null
          }
          return next
        }
        const before = oldState.selection
        return transaction.docChanged &&
          input?.text === '/' &&
          input.from === before.from &&
          input.to === before.to &&
          before instanceof TextSelection &&
          before.empty &&
          before.$from.depth === 1 &&
          before.$from.parent.type.name === 'paragraph' &&
          before.$from.parent.content.size === 0 &&
          next.query === ''
          ? next
          : null
      }
    },
    props: {
      handleTextInput: (_view, from, to, text) => {
        localInput = { from, to, text }
        return false
      },
      handleKeyDown: (_view, event) => handleKey(event),
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          if (event.inputType === 'deleteContentBackward' && !event.isComposing) localDeletion = true
          return false
        },
        compositionstart: () => {
          composing = true
          close()
          return false
        },
        compositionend: () => {
          composing = false
          return false
        },
        blur: (_view, event) => {
          focusOut(event)
          return false
        }
      }
    },
    view: view => {
      const host = view.dom.closest('.editor-tiptap') ?? view.dom.parentElement
      host?.append(menu)
      document.addEventListener('pointerdown', outside, true)
      menu.addEventListener('focusout', focusOut)
      window.addEventListener('resize', reposition)
      window.addEventListener('scroll', reposition, true)
      render()
      return { update: render, destroy: detach }
    }
  })
  editor.registerPlugin(plugin, (newPlugin, plugins) => [newPlugin, ...plugins])
  return () => {
    detach()
    editor.unregisterPlugin(key)
  }
}
