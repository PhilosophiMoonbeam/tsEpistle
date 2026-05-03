const { fetchRenderingRenderers, saveRenderingRenderers } = require('./rendering-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('rendering api helper', () => {
  test('requests rendering renderers with same-origin JSON options', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([]))

    await expect(fetchRenderingRenderers(fetchImpl)).resolves.toEqual([])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/rendering/renderers', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('validates, sanitizes, parses config JSON, sorts by parsed value order, and accepts dependsOn values', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: [
          {
            key: 'flavor',
            value: JSON.stringify({ type: 'string', title: 'Flavor', order: 2, value: 'commonmark' })
          },
          {
            key: 'safeMode',
            value: JSON.stringify({ type: 'boolean', title: 'Safe Mode', order: 1, value: true })
          },
          {
            key: 'label',
            value: JSON.stringify({ type: 'string', title: 'Label', value: 'compact' })
          }
        ],
        privateField: 'must-not-return'
      },
      {
        isEnabled: false,
        key: 'emojiRenderer',
        title: 'Emoji Renderer',
        description: 'Adds emoji rendering.',
        icon: 'mdi-emoticon-outline',
        dependsOn: 'markdownCore',
        input: null,
        output: null,
        config: []
      }
    ]))

    await expect(fetchRenderingRenderers(fetchImpl)).resolves.toEqual([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: [
          {
            key: 'safeMode',
            value: { type: 'boolean', title: 'Safe Mode', order: 1, value: true }
          },
          {
            key: 'flavor',
            value: { type: 'string', title: 'Flavor', order: 2, value: 'commonmark' }
          },
          {
            key: 'label',
            value: { type: 'string', title: 'Label', value: 'compact' }
          }
        ]
      },
      {
        isEnabled: false,
        key: 'emojiRenderer',
        title: 'Emoji Renderer',
        description: 'Adds emoji rendering.',
        icon: 'mdi-emoticon-outline',
        dependsOn: 'markdownCore',
        input: null,
        output: null,
        config: []
      }
    ])
  })

  test('strips extra renderer and config fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: false,
        key: 'emojiRenderer',
        title: 'Emoji Renderer',
        description: 'Adds emoji rendering.',
        icon: 'mdi-emoticon-outline',
        dependsOn: 'markdownCore',
        input: 'html',
        output: 'html',
        privateField: 'must-not-return',
        props: { raw: true },
        config: [
          {
            key: 'label',
            value: JSON.stringify({ type: 'string', title: 'Label', order: 1, value: 'compact' }),
            rawValue: 'must-not-return'
          }
        ]
      }
    ]))

    await expect(fetchRenderingRenderers(fetchImpl)).resolves.toEqual([
      {
        isEnabled: false,
        key: 'emojiRenderer',
        title: 'Emoji Renderer',
        description: 'Adds emoji rendering.',
        icon: 'mdi-emoticon-outline',
        dependsOn: 'markdownCore',
        input: 'html',
        output: 'html',
        config: [
          {
            key: 'label',
            value: { type: 'string', title: 'Label', order: 1, value: 'compact' }
          }
        ]
      }
    ])
  })

  test('rejects malformed root payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ renderers: [] }))

    await expect(fetchRenderingRenderers(fetchImpl, 'Bad rendering payload')).rejects.toThrow('Bad rendering payload')
  })

  test('rejects malformed renderer rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: 'yes',
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: []
      }
    ]))

    await expect(fetchRenderingRenderers(fetchImpl, 'Bad rendering row')).rejects.toThrow('Bad rendering row')
  })

  test('rejects malformed dependsOn values', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: false,
        input: 'markdown',
        output: 'html',
        config: []
      }
    ]))

    await expect(fetchRenderingRenderers(fetchImpl, 'Bad rendering dependency')).rejects.toThrow('Bad rendering dependency')
  })

  test('rejects malformed config rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: [{ key: 12, value: '{}' }]
      }
    ]))

    await expect(fetchRenderingRenderers(fetchImpl, 'Bad rendering config')).rejects.toThrow('Bad rendering config')
  })

  test('rejects malformed config JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: [{ key: 'label', value: '{not-json' }]
      }
    ]))

    await expect(fetchRenderingRenderers(fetchImpl, 'Bad rendering JSON')).rejects.toThrow('Bad rendering JSON')
  })

  test('propagates API JSON errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ message: 'manage:system is required' })
    })

    await expect(fetchRenderingRenderers(fetchImpl, 'Bad rendering load')).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchRenderingRenderers(fetchImpl, 'Bad rendering content type')).rejects.toThrow('Bad rendering content type')
  })

  test('saves rendering renderers with same-origin JSON POST options', async () => {
    const renderers = [{ key: 'markdownCore', isEnabled: true, config: [{ key: 'safeMode', value: JSON.stringify({ v: true }) }] }]
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Renderers updated successfully' }))

    await expect(saveRenderingRenderers(fetchImpl, renderers)).resolves.toEqual({ message: 'Renderers updated successfully' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/rendering/renderers', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ renderers })
    })
  })

  test('rejects malformed rendering save success responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(saveRenderingRenderers(fetchImpl, [], 'Bad rendering save')).rejects.toThrow('Bad rendering save')
  })

  test('surfaces JSON API error messages on rendering save failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid renderers payload' }, false))

    await expect(saveRenderingRenderers(fetchImpl, [], 'Bad rendering save')).rejects.toThrow('Invalid renderers payload')
  })
})
