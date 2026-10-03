import {
  searchUsers,
  fetchLastLogins,
  updateProfilePreferences,
  uploadProfileAvatar,
  removeProfileAvatar
} from './users-api.ts'

function createJsonResponse(payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('users api helper', () => {
  test('returns an empty array without fetching for short queries', async () => {
    const fetchImpl = vi.fn()

    expect(await searchUsers(fetchImpl, ' a ')).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('fetches and validates user search results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        { id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' },
        { id: 77, name: 'Bob', email: 'bob@example.com', providerKey: 'ldap' }
      ])
    )

    expect(await searchUsers(fetchImpl, ' alice ')).toEqual([
      { id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' },
      { id: 77, name: 'Bob', email: 'bob@example.com', providerKey: 'ldap' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/search?query=alice', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed user search rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ id: '42', name: 'Alice', email: 'alice@example.com', providerKey: 'local' }]))

    await expect(Promise.resolve(searchUsers(fetchImpl, 'alice', 'Bad user search payload'))).rejects.toThrow('Bad user search payload')
  })

  test('fetches and validates dashboard last-logins payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        { id: 42, name: 'Alice', lastLoginAt: '2026-01-03T00:00:00.000Z', email: 'hidden@example.com' },
        { id: 77, name: 'Bob', lastLoginAt: '2026-01-02T00:00:00.000Z' }
      ])
    )

    expect(await fetchLastLogins(fetchImpl)).toEqual([
      { id: 42, name: 'Alice', lastLoginAt: '2026-01-03T00:00:00.000Z' },
      { id: 77, name: 'Bob', lastLoginAt: '2026-01-02T00:00:00.000Z' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/last-logins', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed dashboard last-logins payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ id: 42, name: 'Alice', lastLoginAt: null }]))

    await expect(Promise.resolve(fetchLastLogins(fetchImpl, 'Bad last logins payload'))).rejects.toThrow('Bad last logins payload')
  })

  test.each([{ appearance: 'dark' }, { fontFamily: 'roboto-flex' }, { appearance: 'system', fontFamily: 'newsreader' }])(
    'updates profile preferences with the exact REST payload: %o',
    async input => {
      const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Profile preferences updated successfully.' }))

      await expect(updateProfilePreferences(fetchImpl, 42, input)).resolves.toBe('Profile preferences updated successfully.')

      expect(fetchImpl).toHaveBeenCalledWith('/_api/users/profile/preferences', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-TsEpistle-Profile-Account': '42'
        },
        body: JSON.stringify(input)
      })
    }
  )

  test('rejects malformed profile preference responses with the provided fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ token: '' }))

    await expect(updateProfilePreferences(fetchImpl, 42, { appearance: 'system' }, 'Bad preferences response')).rejects.toThrow('Bad preferences response')
  })

  test.each(['token', 'jwt'])('rejects otherwise-valid profile preference responses containing %s', async credential => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({ message: 'Profile preferences updated successfully.', [credential]: 'unexpected' })
    )

    await expect(updateProfilePreferences(fetchImpl, 42, { appearance: 'system' }, 'Bad preferences response')).rejects.toThrow('Bad preferences response')
  })

  test('surfaces API errors from profile preference updates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Profile preferences could not be saved' }, false))

    await expect(updateProfilePreferences(fetchImpl, 42, { fontFamily: 'newsreader' })).rejects.toThrow('Profile preferences could not be saved')
  })

  test('surfaces API error messages for failed searches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'a user search admin permission is required' })
    })

    await expect(Promise.resolve(searchUsers(fetchImpl, 'alice', 'Bad user search'))).rejects.toThrow('a user search admin permission is required')
  })
  test('uploads a profile avatar as multipart form data without overriding the browser content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        message: 'Profile avatar updated successfully.',
        pictureUrl: 'internal'
      })
    )
    const file = new File([Buffer.from('avatar')], 'avatar.png', { type: 'image/png' })

    await expect(uploadProfileAvatar(fetchImpl, 42, file)).resolves.toEqual({
      message: 'Profile avatar updated successfully.',
      pictureUrl: 'internal'
    })

    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('/_api/users/profile/avatar')
    expect(options).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-TsEpistle-Profile-Account': '42' }
    })
    expect(options.headers).not.toHaveProperty('Content-Type')
    expect(options.body).toBeInstanceOf(FormData)
    const uploadedImage = options.body.get('image')
    expect(uploadedImage).toBeInstanceOf(File)
    expect(uploadedImage).toMatchObject({
      name: 'avatar.png',
      type: 'image/png',
      size: Buffer.byteLength('avatar')
    })
    expect(Buffer.from(await uploadedImage.arrayBuffer())).toEqual(Buffer.from('avatar'))
  })

  test('removes a profile avatar with the authenticated same-origin DELETE request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        message: 'Profile avatar removed successfully.',
        pictureUrl: null
      })
    )

    await expect(removeProfileAvatar(fetchImpl, 42)).resolves.toEqual({
      message: 'Profile avatar removed successfully.',
      pictureUrl: null
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/profile/avatar', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-TsEpistle-Profile-Account': '42' }
    })
  })

  test('rejects malformed avatar mutation responses and preserves API errors', async () => {
    const malformed = vi.fn().mockResolvedValue(createJsonResponse({ message: 'done', pictureUrl: 'internal', token: 'unexpected' }))
    await expect(uploadProfileAvatar(malformed, 42, new File([Buffer.from('avatar')], 'avatar.png'), 'Bad avatar response')).rejects.toThrow('Bad avatar response')

    const failed = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Avatar image is invalid or could not be decoded.' }, false))
    await expect(removeProfileAvatar(failed, 42)).rejects.toThrow('Avatar image is invalid or could not be decoded.')
  })
})
