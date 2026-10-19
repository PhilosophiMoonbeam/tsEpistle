import { emitEditorInsert, onEditorInsert, offEditorInsert, emitEditorImagePropertiesRequest, subscribeEditorImageProperties } from './editor-insert-events.ts'

describe('editor insert events', () => {
  test('emitEditorInsert emits the shared editor insert event with the original payload', () => {
    const handler = vi.fn()
    const propertiesHandler = vi.fn()
    const unsubscribeProperties = subscribeEditorImageProperties(propertiesHandler)
    const opts = {
      kind: 'IMAGE',
      path: '/asset.png',
      text: 'asset.png',
      align: 'center'
    }

    onEditorInsert(handler)
    try {
      emitEditorInsert(opts)
      expect(handler.mock.calls).toEqual([[opts]])
      expect(handler.mock.calls[0][0]).toBe(opts)
      expect(propertiesHandler).not.toHaveBeenCalled()

      const request = {
        signal: new AbortController().signal,
        properties: { src: '/asset.png', alt: '', width: '', height: '', align: '', styles: [] },
        apply: () => true
      }
      emitEditorImagePropertiesRequest(request)
      expect(propertiesHandler.mock.calls).toEqual([[request]])
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      offEditorInsert(handler)
      unsubscribeProperties()
    }
  })

  test('offEditorInsert unsubscribes from the shared editor insert event with the same handler', () => {
    const handler = vi.fn()
    const sibling = vi.fn()
    const payload = { kind: 'IMAGE', path: '/asset.png' }

    onEditorInsert(handler)
    onEditorInsert(sibling)
    try {
      offEditorInsert(handler)
      emitEditorInsert(payload)
      expect(handler).not.toHaveBeenCalled()
      expect(sibling.mock.calls).toEqual([[payload]])
    } finally {
      offEditorInsert(handler)
      offEditorInsert(sibling)
    }
  })

  test('offEditorInsert does not broadly unsubscribe without a handler', () => {
    const handler = vi.fn()
    const sibling = vi.fn()
    const payload = { kind: 'IMAGE', path: '/asset.png' }
    onEditorInsert(handler)
    onEditorInsert(sibling)
    try {
      offEditorInsert()
      emitEditorInsert(payload)
      expect(handler.mock.calls).toEqual([[payload]])
      expect(sibling.mock.calls).toEqual([[payload]])
    } finally {
      offEditorInsert(handler)
      offEditorInsert(sibling)
    }
  })
})
