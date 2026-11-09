import { describe, expect, it } from '../bun-test.mts'
import * as Y from 'yjs'
import {
  COLLABORATION_MAX_PRESENCE_PARTICIPANTS,
  COLLABORATION_MAX_RECENT_LENGTH,
  COLLABORATION_TEXT_KEY,
  createCollaborationRange,
  parseCollaborationClientMessage,
  parseCollaborationServerMessage,
  resolveCollaborationRange,
  resolveCollaborationRecent
} from '../../../shared/collaboration.ts'

const awareness = () => ({ type: 'awareness', protocolVersion: 1, generation: 1, enabled: true, selection: null, recent: [] })

describe('ephemeral collaboration protocol', () => {
  it('accepts opt-in and opt-out but refuses client-selected participant identity', () => {
    expect(parseCollaborationClientMessage(awareness())).toEqual(awareness())
    expect(parseCollaborationClientMessage({ ...awareness(), enabled: false })).toMatchObject({ enabled: false })
    for (const extra of [{ token: 'someone-else' }, { label: 'Account owner' }, { userId: 1 }, { peers: [] }]) {
      expect(() => parseCollaborationClientMessage({ ...awareness(), ...extra })).toThrow()
    }
  })

  it('refuses malformed, unbounded, cross-type and nonfinite relative ranges', () => {
    const doc = new Y.Doc(), text = doc.getText(COLLABORATION_TEXT_KEY)
    text.insert(0, 'example')
    const range = createCollaborationRange(text, 1, 4)
    const valid = { ...awareness(), selection: range, recent: [range] }
    expect(parseCollaborationClientMessage(valid)).toMatchObject({ recent: [range] })
    for (const message of [
      { ...valid, enabled: false },
      { ...valid, recent: Array(5).fill(range) },
      { ...valid, selection: { ...range, start: { ...range.start, tname: 'other-room' } } },
      { ...valid, selection: { ...range, start: { ...range.start, item: { client: Infinity, clock: 0 } } } },
      { ...valid, selection: { ...range, start: { ...range.start, type: { client: 1, clock: 0 } } } },
      { ...valid, recent: [{ ...range, end: { ...range.end, item: { ...range.start.item!, clock: range.start.item!.clock + COLLABORATION_MAX_RECENT_LENGTH } } }] },
      { ...valid, recent: [{ ...range, end: { ...range.end, assoc: 0 } }] }
    ]) expect(() => parseCollaborationClientMessage(message)).toThrow()
    doc.destroy()
  })

  it('bounds server rosters and requires unique opaque identities and nonidentifying labels', () => {
    const peer = { token: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Participant aaaaaaaa', selection: null, recent: [], expiresAt: Date.now() + 30_000 }
    const message = { type: 'awareness', generation: 1, self: null, peers: [peer] }
    expect(parseCollaborationServerMessage(message)).toEqual(message)
    for (const peers of [[peer, peer], [{ ...peer, label: 'person@example.com' }], Array(COLLABORATION_MAX_PRESENCE_PARTICIPANTS + 1).fill(peer)]) {
      expect(() => parseCollaborationServerMessage({ ...message, peers })).toThrow()
    }
  })
})

describe('presence ranges over concurrent source edits', () => {
  it('tracks surviving original characters while excluding adjacent and interleaved other-client inserts', () => {
    const author = new Y.Doc(), peer = new Y.Doc()
    const text = author.getText(COLLABORATION_TEXT_KEY)
    text.insert(0, 'abcd')
    const range = createCollaborationRange(text, 0, 4)
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(author))
    const other = peer.getText(COLLABORATION_TEXT_KEY)
    other.insert(2, 'X')
    other.insert(0, 'L')
    other.insert(other.length, 'R')
    text.delete(1, 1)
    Y.applyUpdate(author, Y.encodeStateAsUpdate(peer))
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(author))
    expect(text.toString()).toBe('LaXcdR')
    expect(other.toString()).toBe(text.toString())
    expect(resolveCollaborationRange(text, range)).toEqual({ from: 1, to: 5 })
    expect(resolveCollaborationRecent(text, range)).toEqual([{ from: 1, to: 2 }, { from: 3, to: 5 }])
    expect(resolveCollaborationRecent(other, range)).toEqual([{ from: 1, to: 2 }, { from: 3, to: 5 }])
    author.destroy(); peer.destroy()
  })

  it('discards deleted ranges and foreign-document anchors rather than guessing a location', () => {
    const doc = new Y.Doc(), foreign = new Y.Doc()
    const text = doc.getText(COLLABORATION_TEXT_KEY), other = foreign.getText(COLLABORATION_TEXT_KEY)
    text.insert(0, 'abc'); other.insert(0, 'abc')
    const range = createCollaborationRange(text, 0, 3)
    expect(resolveCollaborationRange(other, range)).toBeNull()
    text.delete(0, 3)
    expect(resolveCollaborationRange(text, range)).toBeNull()
    expect(resolveCollaborationRecent(text, range)).toEqual([])
    doc.destroy(); foreign.destroy()
  })

  it('does not turn range resolution into an undoable or serializable source mutation', () => {
    const doc = new Y.Doc(), text = doc.getText(COLLABORATION_TEXT_KEY)
    text.insert(0, 'source')
    const undo = new Y.UndoManager(text), before = Y.encodeStateAsUpdate(doc)
    const range = createCollaborationRange(text, 0, 6)
    expect(resolveCollaborationRecent(text, range)).toEqual([{ from: 0, to: 6 }])
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect(undo.undoStack).toHaveLength(0)
    undo.destroy(); doc.destroy()
  })
})

it('bounds selection spans and drops a caret whose associated character was deleted', () => {
  const doc = new Y.Doc(), text = doc.getText(COLLABORATION_TEXT_KEY)
  text.insert(0, 'x'.repeat(8193))
  expect(resolveCollaborationRange(text, createCollaborationRange(text, 0, 8193))).toBeNull()
  const caret = createCollaborationRange(text, 4)
  text.delete(4, 1)
  expect(resolveCollaborationRange(text, caret)).toBeNull()
  doc.destroy()
})
