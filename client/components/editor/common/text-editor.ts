import { basicSetup } from 'codemirror'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { foldEffect } from '@codemirror/language'

export type TextPosition = {
  line: number
  ch: number
}

export interface TextEditorHandle {
  destroy: () => void
  focus: () => void
  requestMeasure: () => void
  getValue: () => string
  setValue: (value: string) => void
  cursor: (which?: 'from' | 'to' | 'head') => TextPosition
  positionAt: (offset: number) => TextPosition
  offsetAt: (position: TextPosition) => number
  getLine: (line: number) => string
  readonly lineCount: number
  selectedLines: () => number[]
  hasSelection: () => boolean
  setSelection: (from: TextPosition, to?: TextPosition) => void
  selectedOffsets: () => Array<{ from: number; to: number }>
  slice: (from: number, to: number) => string
  replaceOffsets: (content: string, from: number, to: number) => void
  replaceRange: (content: string, from: TextPosition, to?: TextPosition) => void
  replaceSelection: (content: string) => void
  setMarkers: (markers: Array<{ from: TextPosition; to: TextPosition; text: string; action: EventListener }>) => void
  foldRange: (from: TextPosition, to: TextPosition) => void
}

class ActionWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly action: EventListener
  ) {
    super()
  }

  toDOM(): HTMLElement {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'cm-buttonmarker'
    element.textContent = this.text
    element.addEventListener('click', this.action)
    return element
  }
}

const setMarkers = StateEffect.define<DecorationSet>()
const markerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(markers, transaction) {
    markers = markers.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setMarkers)) markers = effect.value
    }
    return markers
  },
  provide: field => EditorView.decorations.from(field)
})

type TextEditorOptions = {
  parent: HTMLElement
  value: string
  language?: Extension
  direction?: 'ltr' | 'rtl'
  onChange?: (value: string) => void
  onCursor?: (position: TextPosition) => void
  extensions?: Extension[]
}

export class TextEditor implements TextEditorHandle {
  private readonly view: EditorView

  constructor({ parent, value, language, direction = 'ltr', onChange, onCursor, extensions = [] }: TextEditorOptions) {
    this.view = new EditorView({
      parent,
      doc: value,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ dir: direction }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChange?.(update.state.doc.toString())
          if (update.selectionSet) onCursor?.(this.cursor())
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            backgroundColor: '#1d1f21',
            color: '#e0e0e0',
            fontFamily: 'Roboto Mono, monospace',
            fontSize: '.9rem'
          },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { caretColor: '#b0b0b0' },
          '.cm-cursor': { borderLeftColor: '#b0b0b0' },
          '.cm-gutters': {
            backgroundColor: '#181a1b',
            color: '#616161',
            borderRight: '1px solid #212121'
          },
          '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#212121' },
          '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#1565c0' },
          '.cm-buttonmarker': {
            backgroundColor: 'rgba(33, 150, 243, .3)',
            border: '1px solid #2196f3',
            appearance: 'none',
            display: 'inline',
            cursor: 'pointer',
            color: 'inherit',
            font: 'inherit',
            lineHeight: 'inherit',
            margin: '0',
            verticalAlign: 'baseline',
            padding: '0 4px'
          }
        }),
        markerField,
        ...(language ? [language] : []),
        ...extensions
      ]
    })
  }

  destroy(): void {
    this.view.destroy()
  }

  focus(): void {
    this.view.focus()
  }

  requestMeasure(): void {
    this.view.requestMeasure()
  }

  getValue(): string {
    return this.view.state.doc.toString()
  }

  setValue(value: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } })
  }

  cursor(which: 'from' | 'to' | 'head' = 'head'): TextPosition {
    const selection = this.view.state.selection.main
    const offset = which === 'from' ? selection.from : which === 'to' ? selection.to : selection.head
    return this.positionAt(offset)
  }

  positionAt(offset: number): TextPosition {
    const line = this.view.state.doc.lineAt(offset)
    return { line: line.number - 1, ch: offset - line.from }
  }

  offsetAt({ line, ch }: TextPosition): number {
    const docLine = this.view.state.doc.line(Math.min(Math.max(line + 1, 1), this.view.state.doc.lines))
    return Math.min(docLine.from + ch, docLine.to)
  }

  getLine(line: number): string {
    return this.view.state.doc.line(line + 1).text
  }

  get lineCount(): number {
    return this.view.state.doc.lines
  }

  selectedLines(): number[] {
    const lines = new Set<number>()
    for (const range of this.view.state.selection.ranges) {
      const start = this.view.state.doc.lineAt(range.from).number - 1
      const end = this.view.state.doc.lineAt(range.to).number - 1
      for (let line = start; line <= end; line++) lines.add(line)
    }
    return [...lines]
  }

  hasSelection(): boolean {
    return this.view.state.selection.ranges.some(range => !range.empty)
  }

  setSelection(from: TextPosition, to: TextPosition = from): void {
    this.view.dispatch({
      selection: {
        anchor: this.offsetAt(from),
        head: this.offsetAt(to)
      }
    })
  }

  selectedOffsets(): Array<{ from: number; to: number }> {
    return this.view.state.selection.ranges.map(({ from, to }) => ({ from, to }))
  }

  slice(from: number, to: number): string {
    return this.view.state.doc.sliceString(from, to)
  }

  replaceOffsets(content: string, from: number, to: number): void {
    this.view.dispatch({ changes: { from, to, insert: content } })
  }

  replaceRange(content: string, from: TextPosition, to: TextPosition = from): void {
    this.view.dispatch({ changes: { from: this.offsetAt(from), to: this.offsetAt(to), insert: content } })
  }

  replaceSelection(content: string): void {
    this.view.dispatch(this.view.state.replaceSelection(content))
  }

  setMarkers(markers: Array<{ from: TextPosition; to: TextPosition; text: string; action: EventListener }>): void {
    const decorations = markers.map(marker =>
      Decoration.replace({
        widget: new ActionWidget(marker.text, marker.action)
      }).range(this.offsetAt(marker.from), this.offsetAt(marker.to))
    )
    this.view.dispatch({ effects: setMarkers.of(Decoration.set(decorations, true)) })
  }

  foldRange(from: TextPosition, to: TextPosition): void {
    this.view.dispatch({ effects: foldEffect.of({ from: this.offsetAt(from), to: this.offsetAt(to) }) })
  }
}
