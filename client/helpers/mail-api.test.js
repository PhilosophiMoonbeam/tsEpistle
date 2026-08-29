import { fetchMailConfig, saveMailConfig, sendMailTest } from './mail-api.ts'

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
  const mailConfig = {
    senderName: 'Wiki Admin',
    senderEmail: 'admin@example.test',
    host: 'smtp.example.test',
    port: 587,
    name: 'Example SMTP',
    secure: false,
    verifySSL: true,
    user: 'smtp-user',
    pass: '********',
    useDKIM: true,
    dkimDomainName: 'example.test',
    dkimKeySelector: 'mail',
    dkimPrivateKey: 'private-key'
  }

  test('fetches mail config with same-origin JSON options and sanitizes fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      ...mailConfig,
      privateField: 'do-not-return'
    }))

    expect(await fetchMailConfig(fetchImpl)).toEqual(mailConfig)
    expect(fetchImpl).toHaveBeenCalledWith('/_api/mail/config', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects invalid mail config responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ...mailConfig, port: '587' }))

    await expect(Promise.resolve(fetchMailConfig(fetchImpl, 'Bad config'))).rejects.toThrow('Bad config')
  })

  test('saves mail config with same-origin JSON POST options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Mail configuration updated successfully.' }))

    expect(await saveMailConfig(fetchImpl, mailConfig)).toEqual({ message: 'Mail configuration updated successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/mail/config', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mailConfig)
    })
  })

  test('surfaces JSON mail config REST error responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid mail config payload' }, false))

    await expect(Promise.resolve(saveMailConfig(fetchImpl, mailConfig, 'Mail save failed'))).rejects.toThrow('Invalid mail config payload')
  })

  test('sends mail test with same-origin JSON POST options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Test email sent successfully.' }))

    expect(await sendMailTest(fetchImpl, 'admin@example.test')).toEqual({ message: 'Test email sent successfully.' })

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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(Promise.resolve(sendMailTest(fetchImpl, 'admin@example.test', 'Bad mail response'))).rejects.toThrow('Bad mail response')
  })

  test('surfaces JSON REST error responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'smtp unavailable' }, false))

    await expect(Promise.resolve(sendMailTest(fetchImpl, 'admin@example.test', 'Mail test failed'))).rejects.toThrow('smtp unavailable')
  })

  test('uses fallback message for non-JSON failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(sendMailTest(fetchImpl, 'admin@example.test', 'Mail test failed'))).rejects.toThrow('Mail test failed')
  })
})
