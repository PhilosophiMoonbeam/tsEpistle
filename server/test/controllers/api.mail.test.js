vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = {
    Router: () => {
      const router = {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        use: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: express, ...express }
})

const { default: express } = await import('express')

const API_CONTROLLER_NAMES = [
  'analytics',
  'assets',
  'auth',
  'comments',
  'groups',
  'locales',
  'logging',
  'mail',
  'navigation',
  'pages',
  'rendering',
  'search',
  'site',
  'storage',
  'system',
  'theming',
  'users'
]

const loadApiIndexRouter = async () => {
  const subrouters = Object.fromEntries(API_CONTROLLER_NAMES.map(name => [name, {}]))

  for (const name of API_CONTROLLER_NAMES) {
    vi.mockModule(`../../controllers/api/${name}.ts`, import.meta.url, () => ({
      default: subrouters[name]
    }))
  }

  try {
    expect(await vi.importFresh('../../controllers/api/index.ts', import.meta.url)).toBeDefined()
  } finally {
    for (const name of API_CONTROLLER_NAMES) {
      vi.unmockModule(`../../controllers/api/${name}.ts`, import.meta.url)
    }
  }

  return { apiRouter: express.__routers.at(-1), subrouters }
}

describe('controllers/api mail endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn()
      },
      mail: {
        send: vi.fn().mockResolvedValue(undefined),
        init: vi.fn()
      },
      config: {
        mail: {
          senderName: 'Wiki Admin',
          senderEmail: 'admin@example.test',
          host: 'smtp.example.test',
          port: 587,
          name: 'Example SMTP',
          secure: false,
          verifySSL: true,
          user: 'smtp-user',
          pass: 'existing-secret',
          useDKIM: true,
          dkimDomainName: 'example.test',
          dkimKeySelector: 'mail',
          dkimPrivateKey: 'existing-key',
          privateField: 'do-not-return'
        }
      },
      configSvc: {
        saveToDb: vi.fn().mockResolvedValue(undefined)
      },
      models: {
        knex: {}
      }
    }
  })

  const loadMailRouter = async () => {
    await vi.importFresh('../../controllers/api/mail.ts', import.meta.url)
    return express.__routers[0]
  }

  const loadMailConfigHandler = async () => {
    const router = await loadMailRouter()
    return router.get.mock.calls.find(([path]) => path === '/config')[1]
  }

  const saveMailConfigHandler = async () => {
    const router = await loadMailRouter()
    return router.post.mock.calls.find(([path]) => path === '/config')[1]
  }

  const loadSendTestHandler = async () => {
    const router = await loadMailRouter()
    return router.post.mock.calls.find(([path]) => path === '/test')[1]
  }

  it('registers mail test route', async () => { const handler = await loadSendTestHandler()

  expect(typeof handler).toBe('function') })


  it('registers mail config routes', async () => { expect(typeof await loadMailConfigHandler()).toBe('function')
  expect(typeof await saveMailConfigHandler()).toBe('function') })

  it('returns JSON 403 for unauthorized mail config requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadMailConfigHandler()
    const req = { user: { permissions: [] } }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
  })

  it('returns allowlisted mail config and masks stored password', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadMailConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {} }, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
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
      dkimPrivateKey: 'existing-key'
    })
  })

  it('returns an empty password mask when no mail password is stored', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.mail.pass = ''
    const handler = await loadMailConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {} }, res)

    expect(res.json.mock.calls[0][0].pass).toBe('')
  })

  it('rejects invalid mail config payloads with JSON error', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await saveMailConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { senderName: 'Missing required fields' } }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid mail config payload' })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(global.WIKI.mail.init).not.toHaveBeenCalled()
  })

  it('saves mail config while preserving masked existing password', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await saveMailConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const body = {
      senderName: 'Updated Admin',
      senderEmail: 'updated@example.test',
      host: 'smtp2.example.test',
      port: 465,
      name: 'Updated SMTP',
      secure: true,
      verifySSL: false,
      user: 'updated-user',
      pass: '********',
      useDKIM: false,
      dkimDomainName: '',
      dkimKeySelector: '',
      dkimPrivateKey: ''
    }

    await handler({ user: {}, body }, res)

    expect(global.WIKI.config.mail).toEqual({
      ...body,
      pass: 'existing-secret'
    })
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['mail'])
    expect(global.WIKI.mail.init).toHaveBeenCalledWith()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Mail configuration updated successfully.' })
  })

  it('saves replacement mail password when it is not masked', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await saveMailConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const body = {
      senderName: '',
      senderEmail: '',
      host: '',
      port: 0,
      name: '',
      secure: false,
      verifySSL: false,
      user: '',
      pass: 'new-secret',
      useDKIM: false,
      dkimDomainName: '',
      dkimKeySelector: '',
      dkimPrivateKey: ''
    }

    await handler({ user: {}, body }, res)

    expect(global.WIKI.config.mail.pass).toBe('new-secret')
  })

  it('returns JSON error when mail config save fails', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('db unavailable'))
    const handler = await saveMailConfigHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const body = {
      senderName: '',
      senderEmail: '',
      host: '',
      port: 0,
      name: '',
      secure: false,
      verifySSL: false,
      user: '',
      pass: '',
      useDKIM: false,
      dkimDomainName: '',
      dkimKeySelector: '',
      dkimPrivateKey: ''
    }

    await handler({ user: {}, body }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'db unavailable' })
  })

  it('returns JSON 403 for unauthorized mail test requests without sending mail', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadSendTestHandler()
    const req = { user: { permissions: [] }, body: { recipientEmail: 'admin@example.test' } }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.mail.send).not.toHaveBeenCalled()
  })

  it('rejects missing or short recipient email with JSON error', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSendTestHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { recipientEmail: 'a@b' } }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid mail recipient' })
    expect(global.WIKI.mail.send).not.toHaveBeenCalled()
  })

  it('sends test email using resolver-compatible payload', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadSendTestHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { recipientEmail: 'admin@example.test' } }, res)

    expect(global.WIKI.mail.send).toHaveBeenCalledWith({
      template: 'test',
      to: 'admin@example.test',
      subject: 'A test email from your wiki',
      text: 'This is a test email sent from your wiki.',
      data: {
        preheadertext: 'This is a test email sent from your wiki.'
      }
    })
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Test email sent successfully.' })
  })

  it('returns JSON error when test mail send fails', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.mail.send.mockRejectedValueOnce(new Error('smtp unavailable'))
    const handler = await loadSendTestHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { recipientEmail: 'admin@example.test' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'smtp unavailable' })
  })
  it('is mounted by the API index router', async () => {
    const { apiRouter, subrouters } = await loadApiIndexRouter()

    expect(apiRouter.use).toHaveBeenCalledWith('/mail', subrouters.mail)
  })
})
