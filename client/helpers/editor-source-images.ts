import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'
import type { EditorInsertPayload } from './editor-insert-events'
import { requestEditorImageProperties } from './editor-image-properties'
import { findSourceImage, serializeSourceImage, type SourceImage, type SourceImageMode } from './editor-image-source'
import { isAsciiDocLiteralPosition } from './editor-source-context'

export function createSourceImageAuthoring(
  mode: SourceImageMode,
  canEdit: () => boolean,
  owner: () => string
): {
  extension: Extension
  open: () => boolean
  insert: (payload: EditorInsertPayload) => boolean
  destroy: () => void
} {
  let view: EditorView | null = null
  const initialOwner = owner()
  let pending: { image: SourceImage; from: number; to: number; owner: string; abort: AbortController; conflicted: boolean } | null = null
  const open = (): boolean => {
    if (
      !view ||
      owner() !== initialOwner ||
      view.compositionStarted ||
      view.state.readOnly ||
      !view.state.facet(EditorView.editable) ||
      !canEdit() ||
      view.state.selection.ranges.length !== 1
    )
      return false
    const selection = view.state.selection.main
    if (mode !== 'asciidoc') {
      let node = syntaxTree(view.state).resolveInner(selection.head, -1)
      for (;;) {
        if (/^(?:FencedCode|CodeBlock|InlineCode|CommentBlock|Comment|Script|StyleSheet)$/.test(node.name)) return false
        if (!node.parent) break
        node = node.parent
      }
    }
    if (mode === 'asciidoc' && isAsciiDocLiteralPosition(view.state.doc.toString(), selection.from)) return false
    const image = findSourceImage(view.state.doc.toString(), selection.from, selection.to, mode)
    if (!image) return false
    pending?.abort.abort()
    const request = { image, from: image.from, to: image.to, owner: owner(), abort: new AbortController(), conflicted: false }
    pending = request
    requestEditorImageProperties({
      properties: image.properties,
      signal: request.abort.signal,
      apply(patch) {
        if (
          !view ||
          pending !== request ||
          request.conflicted ||
          request.abort.signal.aborted ||
          request.owner !== owner() ||
          !canEdit() ||
          view.compositionStarted ||
          view.state.readOnly ||
          !view.state.facet(EditorView.editable) ||
          view.state.sliceDoc(request.from, request.to) !== image.source
        )
          return false
        const replacement = image.patch(patch)
        if (replacement === null) return false
        // Retire before dispatch so our own transaction is not a conflict.
        pending = null
        if (replacement === image.source) {
          request.abort.abort()
          return true
        }
        view.dispatch({
          changes: { from: request.from, to: request.to, insert: replacement },
          selection: EditorSelection.cursor(request.from + replacement.length),
          userEvent: 'input.image-properties'
        })
        request.abort.abort()
        return true
      }
    })
    return true
  }
  return {
    extension: [
      ViewPlugin.define(editor => {
        view = editor
        return {
          update(update) {
            if (!pending) return
            const request = pending
            if (request.owner !== owner() || !canEdit()) {
              request.abort.abort()
              pending = null
              return
            }
            if (!update.docChanged) return
            let overlap = false
            update.changes.iterChangedRanges((from, to) => {
              if ((from < request.to && to > request.from) || (from === to && from > request.from && from < request.to)) overlap = true
            })
            if (overlap) request.conflicted = true
            request.from = update.changes.mapPos(request.from, 1)
            request.to = update.changes.mapPos(request.to, -1)
          },
          destroy() {
            pending?.abort.abort()
            pending = null
            view = null
          }
        }
      }),
      keymap.of([{ key: 'Mod-Shift-i', run: open }])
    ],
    open,
    insert(payload) {
      if (!view || owner() !== initialOwner || view.compositionStarted || view.state.readOnly || !view.state.facet(EditorView.editable) || !canEdit())
        return false
      const content = serializeSourceImage(mode, payload)
      if (content === null) return false
      view.dispatch(view.state.replaceSelection(content), { userEvent: 'input.image' })
      return true
    },
    destroy() {
      pending?.abort.abort()
      pending = null
      view = null
    }
  }
}
