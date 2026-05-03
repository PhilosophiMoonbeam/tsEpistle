jest.mock('express', () => {
  const routers = []

  return {
    Router: () => {
      const router = {
        get: jest.fn(),
        post: jest.fn(),
        patch: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        use: jest.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }
})

describe('controllers/api mail endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn()
      },
      mail: {
        send: jest.fn().mockResolvedValue(undefined)
      },
      models: {
        knex: {}
      }
    }
  })

  const loadMailRouter = () => {
    const express = require('express')
    require('../../controllers/api/mail')
    return express.__routers[0]
  }

  const loadSendTestHandler = () => {
    const router = loadMailRouter()
    return router.post.mock.calls.find(([path]) => path === '/test')[1]
  }

  it('registers mail test route', () => {
    const handler = loadSendTestHandler()

    expect(typeof handler).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const apiIndexSource = require('fs').readFileSync(require('path').join(__dirname, '../../controllers/api/index.js'), 'utf8')

    expect(apiIndexSource).toContain("router.use('/mail', require('./mail'))")
  })

  it('returns JSON 403 for unauthorized mail test requests without sending mail', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadSendTestHandler()
    const req = { user: { permissions: [] }, body: { recipientEmail: 'admin@example.test' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await handler(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.mail.send).not.toHaveBeenCalled()
  })

  it('rejects missing or short recipient email with JSON error', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadSendTestHandler()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await handler({ user: {}, body: { recipientEmail: 'a@b' } }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid mail recipient' })
    expect(global.WIKI.mail.send).not.toHaveBeenCalled()
  })

  it('sends test email using resolver-compatible payload', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadSendTestHandler()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

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
    const handler = loadSendTestHandler()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await handler({ user: {}, body: { recipientEmail: 'admin@example.test' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'smtp unavailable' })
  })
})
