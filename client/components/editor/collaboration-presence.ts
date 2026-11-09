import { StateEffect, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, showPanel, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { ySync } from 'y-codemirror.next'
import * as Y from 'yjs'

import {
  COLLABORATION_MAX_RECENT_LENGTH,
  COLLABORATION_MAX_RECENT_RANGES,
  COLLABORATION_PRESENCE_INTERVAL_MS,
  COLLABORATION_PRESENCE_TTL_MS,
  COLLABORATION_RECENT_TTL_MS,
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborationRange,
  resolveCollaborationRange,
  resolveCollaborationRecent,
  type CollaborationAwareness,
  type CollaborationParticipant,
  type CollaborationRange
} from '../../../shared/collaboration'

const refreshPresence = StateEffect.define<void>()

class ParticipantCaret extends WidgetType {
  constructor(private readonly label: string) { super() }
  eq(other: ParticipantCaret): boolean { return other.label === this.label }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-participant-caret'
    span.textContent = `│ ${this.label}`
    span.setAttribute('aria-hidden', 'true')
    return span
  }
}

// Deliberately separate from Y.Text, Awareness, undo, offline drafts and source.
export class CollaborationPresence {
  private view: EditorView | null = null
  private ready = false
  private enabled = false
  private self: string | null = null
  private selfExpiresAt = 0
  private readonly peerRecentExpiry = new Map<string, { key: string; expiresAt: number }>()
  private peers: CollaborationParticipant[] = []
  private requestedDisable = false
  private recent: Array<{ range: CollaborationRange; expiresAt: number }> = []
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private refreshQueued = false
  private disposed = false
  private lastSend = 0
  readonly extension: Extension

  constructor(
    private readonly text: Y.Text,
    private readonly generation: number,
    private readonly send: (message: CollaborationAwareness) => boolean
  ) {
    const owner = this
    const decorations = ViewPlugin.fromClass(class {
      decorations: DecorationSet = Decoration.none

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshPresence)))) return
        // ySync writes local changes to Y.Text in its view update, after state fields.
        // Requesting it here resolves positions after sync regardless of extension order.
        if (update.docChanged) update.view.plugin(ySync)
        const marks = []
        for (const peer of owner.peers) {
          const selection = peer.selection && resolveCollaborationRange(owner.text, peer.selection)
          if (selection && selection.to <= update.state.doc.length) {
            if (selection.from < selection.to) marks.push(Decoration.mark({ class: 'cm-participant-selection' }).range(selection.from, selection.to))
            marks.push(Decoration.widget({ widget: new ParticipantCaret(peer.label), side: 1 }).range(selection.to))
          }
          for (const range of peer.recent) {
            for (const recent of resolveCollaborationRecent(owner.text, range)) {
              if (recent.to <= update.state.doc.length) marks.push(Decoration.mark({ class: 'cm-participant-recent' }).range(recent.from, recent.to))
            }
          }
        }
        this.decorations = Decoration.set(marks, true)
      }
    }, { decorations: plugin => plugin.decorations })
    this.extension = [
      decorations,
      EditorView.updateListener.of(update => {
        if (update.docChanged || update.selectionSet) this.scheduleSend()
      }),
      showPanel.of(view => {
        this.view = view
        const dom = document.createElement('section')
        dom.className = 'cm-collaboration-presence'
        dom.setAttribute('aria-label', 'Live edit presence')
        const label = document.createElement('label')
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        const copy = document.createTextNode(' Share cursor and recent edits for this live session')
        label.append(checkbox, copy)
        const status = document.createElement('p')
        status.setAttribute('role', 'status')
        status.setAttribute('aria-live', 'polite')
        const list = document.createElement('ul')
        list.setAttribute('aria-label', 'Participants and locations')
        const buttons = new Map<string, { item: HTMLLIElement; button: HTMLButtonElement }>()
        checkbox.addEventListener('change', () => {
          this.enabled = checkbox.checked && this.ready
          this.requestedDisable = !this.enabled
          this.self = null
          this.peers = []
          this.recent = []
          this.scheduleSend()
          this.refresh()
        })
        dom.append(label, status, list)
        const update = (): void => {
          checkbox.checked = this.enabled
          checkbox.disabled = !this.ready
          const summary = !this.ready ? 'Presence unavailable. Durable editing is unchanged.' : !this.enabled
            ? 'Off. No cursor or session label is shared.' : this.self
              ? `You are Participant ${this.self.slice(0, 8)}. ${this.peers.length} other sharing participants.`
              : 'Starting private session presence…'
          if (status.textContent !== summary) status.textContent = summary
          for (const [token, entry] of buttons) {
            if (!this.peers.some(peer => peer.token === token)) { entry.item.remove(); buttons.delete(token) }
          }
          for (const peer of this.peers) {
            let entry = buttons.get(peer.token)
            if (!entry) {
              const item = document.createElement('li'), button = document.createElement('button')
              button.type = 'button'
              button.addEventListener('click', () => {
                const current = this.peers.find(candidate => candidate.token === peer.token)
                const range = current?.selection && resolveCollaborationRange(this.text, current.selection)
                if (!range || range.to > view.state.doc.length) return
                view.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true })
                view.focus()
              })
              item.append(button)
              list.append(item)
              entry = { item, button }
              buttons.set(peer.token, entry)
            }
            const range = peer.selection && resolveCollaborationRange(this.text, peer.selection)
            const hasRecent = peer.recent.some(recent => resolveCollaborationRecent(this.text, recent).length > 0)
            const line = range && range.to <= view.state.doc.length ? view.state.doc.lineAt(range.to) : null
            entry.button.disabled = !line
            entry.button.textContent = line && range
              ? `${peer.label}: ${range.from === range.to ? 'caret' : 'selection'}, line ${line.number}, column ${range.to - line.from + 1}${hasRecent ? '; recent edits underlined' : ''}. Go to location`
              : `${peer.label}: no shared location${hasRecent ? '; recent edits underlined' : ''}`
          }
        }
        update()
        return { dom, top: true, update, destroy: () => { this.view = null } }
      }),
      EditorView.baseTheme({
        '.cm-collaboration-presence': { padding: '0.5rem', fontFamily: 'system-ui, sans-serif', fontSize: '0.8rem', whiteSpace: 'normal' },
        '.cm-collaboration-presence label': { display: 'inline-flex', alignItems: 'center', gap: '0.4rem' },
        '.cm-collaboration-presence input': { minWidth: '1.1rem', minHeight: '1.1rem' },
        '.cm-collaboration-presence p': { margin: '0.25rem 0' },
        '.cm-collaboration-presence ul': { margin: '0', paddingInlineStart: '1.3rem', maxHeight: '8rem', overflowY: 'auto' },
        '.cm-collaboration-presence button': { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid currentColor', padding: '0.25rem', margin: '0.15rem', textAlign: 'start', cursor: 'pointer' },
        '.cm-collaboration-presence button:focus-visible, .cm-collaboration-presence input:focus-visible': { outline: '2px solid currentColor', outlineOffset: '2px' },
        '.cm-participant-caret': { borderInlineStart: '2px solid currentColor', fontSize: '0.7em', fontFamily: 'system-ui, sans-serif', paddingInline: '2px', opacity: '0.9' },
        '.cm-participant-selection': { textDecoration: 'underline dashed', textUnderlineOffset: '3px' },
        '.cm-participant-recent': { textDecoration: 'underline double', textUnderlineOffset: '4px' }
      })
    ]
    this.text.observe(this.observeText)
  }

  private readonly observeText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (!transaction.local || !this.ready || !this.enabled) return
    let index = 0
    const expiresAt = Date.now() + COLLABORATION_RECENT_TTL_MS
    for (const change of event.delta) {
      if (change.retain) index += change.retain
      if (typeof change.insert === 'string') {
        const length = Math.min(change.insert.length, COLLABORATION_MAX_RECENT_LENGTH)
        if (length) this.recent.push({ range: createCollaborationRange(this.text, index, index + length), expiresAt })
        index += change.insert.length
      }
    }
    this.recent = this.recent.filter(recent => recent.expiresAt > Date.now()).slice(-COLLABORATION_MAX_RECENT_RANGES)
    this.scheduleSend()
  }

  setReady(ready: boolean): void {
    if (this.ready === ready) return
    this.ready = ready
    if (!ready) {
      this.enabled = false
      this.requestedDisable = false
      this.self = null
      this.selfExpiresAt = 0
      this.peerRecentExpiry.clear()
      this.peers = []
      this.recent = []
      clearTimeout(this.sendTimer ?? undefined)
      clearTimeout(this.expiryTimer ?? undefined)
      this.sendTimer = this.expiryTimer = null
    }
    this.refresh()
  }

  clearRecent(): void {
    this.recent = []
    this.peers = this.peers.map(peer => ({ ...peer, recent: [] }))
    this.refresh()
  }

  receive(message: { generation: number; self: string | null; peers: CollaborationParticipant[] }): void {
    if (!this.ready || !this.enabled || message.generation !== this.generation) return
    this.self = message.self
    this.selfExpiresAt = message.self ? Date.now() + COLLABORATION_PRESENCE_TTL_MS : 0
    this.peers = message.self ? message.peers.filter(peer => peer.expiresAt > Date.now()) : []
    const tokens = new Set(this.peers.map(peer => peer.token))
    for (const token of this.peerRecentExpiry.keys()) if (!tokens.has(token)) this.peerRecentExpiry.delete(token)
    this.peers = this.peers.map(peer => {
      const key = JSON.stringify(peer.recent)
      let expiry = this.peerRecentExpiry.get(peer.token)
      if (!expiry || expiry.key !== key) {
        expiry = { key, expiresAt: Date.now() + COLLABORATION_RECENT_TTL_MS }
        this.peerRecentExpiry.set(peer.token, expiry)
      }
      return expiry.expiresAt <= Date.now() ? { ...peer, recent: [] } : peer
    })
    if (!message.self) { this.enabled = false; this.recent = [] }
    this.armExpiry()
    this.refresh()
  }

  scheduleSend(): void {
    if (this.disposed || !this.ready || !this.view || this.sendTimer || (!this.enabled && !this.requestedDisable)) return
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null
      if (!this.ready || !this.view) return
      const now = Date.now()
      this.recent = this.recent.filter(recent => recent.expiresAt > now && resolveCollaborationRecent(this.text, recent.range).length)
      const selection = this.view.state.selection.main
      const message: CollaborationAwareness = {
        type: 'awareness', protocolVersion: COLLABORATION_PROTOCOL_VERSION, generation: this.generation,
        enabled: this.enabled,
        selection: this.enabled ? createCollaborationRange(this.text, selection.from, selection.to) : null,
        recent: this.enabled ? this.recent.map(recent => recent.range) : []
      }
      if (this.send(message)) {
        this.lastSend = now
        this.requestedDisable = false
      }
    }, Math.max(0, COLLABORATION_PRESENCE_INTERVAL_MS - (Date.now() - this.lastSend)))
  }

  private armExpiry(): void {
    clearTimeout(this.expiryTimer ?? undefined)
    const deadlines = this.peers.map(peer => peer.expiresAt)
    if (this.selfExpiresAt) deadlines.push(this.selfExpiresAt)
    for (const expiry of this.peerRecentExpiry.values()) if (expiry.expiresAt > Date.now()) deadlines.push(expiry.expiresAt)
    if (!deadlines.length) return
    this.expiryTimer = setTimeout(() => {
      const now = Date.now()
      this.peers = this.peers.filter(peer => peer.expiresAt > now).map(peer =>
        (this.peerRecentExpiry.get(peer.token)?.expiresAt ?? 0) <= now ? { ...peer, recent: [] } : peer)
      if (this.selfExpiresAt && this.selfExpiresAt <= now) {
        this.selfExpiresAt = 0
        this.self = null
        this.peers = []
        this.enabled = false
        this.recent = []
        this.peerRecentExpiry.clear()
      }
      this.armExpiry()
      this.refresh()
    }, Math.max(1, Math.min(...deadlines) - Date.now()))
  }

  private refresh(): void {
    if (this.refreshQueued || this.disposed) return
    this.refreshQueued = true
    queueMicrotask(() => {
      this.refreshQueued = false
      this.view?.dispatch({ effects: refreshPresence.of() })
    })
  }

  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    this.selfExpiresAt = 0
    this.peerRecentExpiry.clear()
    this.text.unobserve(this.observeText)
    clearTimeout(this.sendTimer ?? undefined)
    clearTimeout(this.expiryTimer ?? undefined)
    this.peers = []
    this.recent = []
    this.self = null
    this.enabled = false
    this.ready = false
    this.view?.dispatch({ effects: refreshPresence.of() })
    this.view = null
  }
}
