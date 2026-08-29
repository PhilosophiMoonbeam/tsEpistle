import { fetchCommentProviders, fetchComments, saveCommentProviders } from './comments-api.ts'

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('comments api helper', () => {
  test('requests comment providers with same-origin JSON options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))

    expect(await fetchCommentProviders(fetchImpl)).toEqual([])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/comments/providers', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('scopes comment listing to an unambiguous page identifier', async () => {
    const comments = [{
      id: 31,
      render: '<p>Owner comment</p>',
      authorName: 'Owner',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }]
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(comments))

    expect(await fetchComments(fetchImpl, 17)).toEqual(comments)
    expect(fetchImpl).toHaveBeenCalledWith('/_api/comments?pageId=17', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
  })

  test('validates, sanitizes, parses config JSON, and sorts by parsed value order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'default',
        title: 'Default Comments',
        description: 'Built-in comments provider.',
        logo: '/_assets/comments/default.svg',
        website: 'https://example.invalid/comments/default',
        isAvailable: true,
        config: [
          {
            key: 'displayMode',
            value: JSON.stringify({ type: 'string', title: 'Display Mode', order: 2, value: 'compact' })
          },
          {
            key: 'requireApproval',
            value: JSON.stringify({ type: 'boolean', title: 'Require Approval', order: 1, value: true })
          },
          {
            key: 'label',
            value: JSON.stringify({ type: 'string', title: 'Label', value: 'Public' })
          }
        ],
        privateField: 'must-not-return'
      }
    ]))

    expect(await fetchCommentProviders(fetchImpl)).toEqual([
      {
        isEnabled: true,
        key: 'default',
        title: 'Default Comments',
        description: 'Built-in comments provider.',
        logo: '/_assets/comments/default.svg',
        website: 'https://example.invalid/comments/default',
        isAvailable: true,
        config: [
          {
            key: 'requireApproval',
            value: { type: 'boolean', title: 'Require Approval', order: 1, value: true }
          },
          {
            key: 'displayMode',
            value: { type: 'string', title: 'Display Mode', order: 2, value: 'compact' }
          },
          {
            key: 'label',
            value: { type: 'string', title: 'Label', value: 'Public' }
          }
        ]
      }
    ])
  })

  test('strips extra provider and config fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: false,
        key: 'external',
        title: 'External Comments',
        description: 'External comments provider.',
        logo: '/_assets/comments/external.svg',
        website: 'https://example.invalid/comments/external',
        isAvailable: false,
        privateField: 'must-not-return',
        props: { raw: true },
        config: [
          {
            key: 'label',
            value: JSON.stringify({ type: 'string', title: 'Label', order: 1, value: 'Public' }),
            rawValue: 'must-not-return'
          }
        ]
      }
    ]))

    expect(await fetchCommentProviders(fetchImpl)).toEqual([
      {
        isEnabled: false,
        key: 'external',
        title: 'External Comments',
        description: 'External comments provider.',
        logo: '/_assets/comments/external.svg',
        website: 'https://example.invalid/comments/external',
        isAvailable: false,
        config: [
          {
            key: 'label',
            value: { type: 'string', title: 'Label', order: 1, value: 'Public' }
          }
        ]
      }
    ])
  })

  test('rejects malformed root payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ providers: [] }))

    await expect(Promise.resolve(fetchCommentProviders(fetchImpl, 'Bad comments payload'))).rejects.toThrow('Bad comments payload')
  })

  test('rejects malformed provider rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: 'yes',
        key: 'default',
        title: 'Default Comments',
        description: 'Built-in comments provider.',
        logo: '/_assets/comments/default.svg',
        website: 'https://example.invalid/comments/default',
        isAvailable: true,
        config: []
      }
    ]))

    await expect(Promise.resolve(fetchCommentProviders(fetchImpl, 'Bad comments row'))).rejects.toThrow('Bad comments row')
  })

  test('rejects malformed config rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'default',
        title: 'Default Comments',
        description: 'Built-in comments provider.',
        logo: '/_assets/comments/default.svg',
        website: 'https://example.invalid/comments/default',
        isAvailable: true,
        config: [{ key: 12, value: '{}' }]
      }
    ]))

    await expect(Promise.resolve(fetchCommentProviders(fetchImpl, 'Bad comments config'))).rejects.toThrow('Bad comments config')
  })

  test('rejects malformed config JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'default',
        title: 'Default Comments',
        description: 'Built-in comments provider.',
        logo: '/_assets/comments/default.svg',
        website: 'https://example.invalid/comments/default',
        isAvailable: true,
        config: [{ key: 'label', value: '{not-json' }]
      }
    ]))

    await expect(Promise.resolve(fetchCommentProviders(fetchImpl, 'Bad comments JSON'))).rejects.toThrow('Bad comments JSON')
  })

  test('propagates API JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system is required' })
    })

    await expect(Promise.resolve(fetchCommentProviders(fetchImpl, 'Bad comments load'))).rejects.toThrow('manage:system is required')
  })

  test('saves comment providers with same-origin JSON POST options', async () => {
    const providers = [{ key: 'default', isEnabled: true, config: [] }]
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Comment Providers updated successfully' }))

    expect(await saveCommentProviders(fetchImpl, providers)).toEqual({ message: 'Comment Providers updated successfully' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/comments/providers', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ providers })
    })
  })

  test('rejects malformed successful comment provider save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(Promise.resolve(saveCommentProviders(fetchImpl, [], 'Bad save payload'))).rejects.toThrow('Bad save payload')
  })

  test('propagates API JSON errors for comment provider saves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid comment providers payload' }, false))

    await expect(Promise.resolve(saveCommentProviders(fetchImpl, [], 'Bad save'))).rejects.toThrow('Invalid comment providers payload')
  })

  test('rejects non-JSON successful comment provider save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(saveCommentProviders(fetchImpl, [], 'Bad save content type'))).rejects.toThrow('Bad save content type')
  })

  test('rejects non-JSON successful responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(fetchCommentProviders(fetchImpl, 'Bad comments content type'))).rejects.toThrow('Bad comments content type')
  })
})
