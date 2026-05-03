const { sendMailTest } = require('./mail-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('mail api helper', () => {
  test('sends mail test with same-origin JSON POST options', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Test email sent successfully.' }))

    await expect(sendMailTest(fetchImpl, 'admin@example.test')).resolves.toEqual({ message: 'Test email sent successfully.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/mail/test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipientEmail: 'admin@example.test' })
    })
  })

  test('rejects invalid success responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(sendMailTest(fetchImpl, 'admin@example.test', 'Bad mail response')).rejects.toThrow('Bad mail response')
  })

  test('surfaces JSON REST error responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'smtp unavailable' }, false))

    await expect(sendMailTest(fetchImpl, 'admin@example.test', 'Mail test failed')).rejects.toThrow('smtp unavailable')
  })

  test('uses fallback message for non-JSON failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(sendMailTest(fetchImpl, 'admin@example.test', 'Mail test failed')).rejects.toThrow('Mail test failed')
  })
})
