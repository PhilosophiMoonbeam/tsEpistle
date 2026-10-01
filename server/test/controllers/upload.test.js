const uploadMocks = vi.hoisted(() => {
  const router = {
    get: vi.fn(),
    post: vi.fn(),
    use: vi.fn()
  }
  const arrayHandler = vi.fn((req, res, next) => next())
  const array = vi.fn(() => arrayHandler)
  class MulterError extends Error {
    constructor(code, field) {
      super(code)
      this.name = 'MulterError'
      this.code = code
      this.field = field
    }
  }
  const multer = vi.fn(() => ({ array }))
  multer.MulterError = MulterError

  return { router, arrayHandler, array, multer, MulterError }
})

vi.mockModule('express', import.meta.url, () => {
  const express = {
    Router: () => uploadMocks.router
  }
  return { default: express }
})

vi.mockModule('multer', import.meta.url, () => ({
  default: uploadMocks.multer
}))

const originalWIKI = global.WIKI
const uploadAuthority = { permissions: ['write:assets', 'manage:system'], groups: [], tagAliases: {} }

const makeRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
  send: vi.fn()
})

const makeFile = overrides => ({
  originalname: 'Report Q1.PDF',
  path: '/tmp/wiki-upload',
  mimetype: 'application/pdf',
  size: 100,
  ...overrides
})

const makeReq = overrides => ({
  user: {
    id: 7,
    permissions: ['write:assets']
  },
  files: [makeFile()],
  body: {
    mediaUpload: JSON.stringify({ folderId: 0 })
  },
  ...overrides
})

const loadHandlers = async () => {
  const { default: createUploadController } = await vi.importFresh('../../controllers/upload.ts', import.meta.url)
  createUploadController(global.WIKI)
  const postCall = uploadMocks.router.post.mock.calls.find(([routePath]) => routePath === '/u')

  return {
    uploadMiddleware: postCall[1],
    uploadHandler: postCall[2]
  }
}

describe('controllers/upload endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    uploadMocks.router.get.mockClear()
    uploadMocks.router.post.mockClear()
    uploadMocks.router.use.mockClear()
    uploadMocks.multer.mockClear()
    uploadMocks.array.mockClear()
    uploadMocks.arrayHandler.mockClear()
    uploadMocks.arrayHandler.mockImplementation((req, res, next) => next())

    global.WIKI = {
      ROOTPATH: '/wiki/root',
      config: {
        dataPath: 'data',
        uploads: {
          maxFileSize: 12345,
          maxFiles: 7
        }
      },
      auth: {
        checkAccess: vi.fn().mockReturnValue(true),
        checkPageAccess: vi.fn().mockReturnValue(true),
        loadPageRuleAuthority: vi.fn().mockResolvedValue(uploadAuthority)
      },
      models: {
        assetFolders: {
          getHierarchy: vi.fn()
        },
        assets: {
          upload: vi.fn().mockResolvedValue()
        }
      }
    }
  })

  afterEach(() => {
    if (originalWIKI === undefined) {
      delete global.WIKI
    } else {
      global.WIKI = originalWIKI
    }
  })

  it('rejects users without upload permissions before invoking multer', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { uploadMiddleware } = await loadHandlers()
    const req = makeReq({
      user: {
        id: 7,
        permissions: ['read:pages']
      }
    })
    const res = makeRes()
    const next = vi.fn()

    await uploadMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'You are not authorized to upload files.'
    })
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['write:assets', 'manage:system'])
    expect(uploadMocks.arrayHandler).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects non-positive file capacity before invoking multer', async () => {
    global.WIKI.config.uploads.maxFiles = 0
    const { uploadMiddleware } = await loadHandlers()
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn()

    await uploadMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'File uploads are disabled by workspace policy.'
    })
    expect(uploadMocks.arrayHandler).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('uses folder hierarchy to build the asset path before upload', async () => {
    global.WIKI.models.assetFolders.getHierarchy.mockResolvedValueOnce([
      { slug: 'docs' },
      { slug: 'images' }
    ])

    const { uploadHandler } = await loadHandlers()
    const req = makeReq({
      body: {
        mediaUpload: JSON.stringify({ folderId: 42 })
      }
    })
    const res = makeRes()

    await uploadHandler(req, res, vi.fn())

    expect(global.WIKI.models.assetFolders.getHierarchy).toHaveBeenCalledWith(42)
    expect(global.WIKI.auth.checkPageAccess).toHaveBeenCalledWith(req.user, ['write:assets', 'manage:system'], {
      path: 'docs/images/report_q1.pdf'
    }, uploadAuthority)
    expect(global.WIKI.models.assets.upload).toHaveBeenCalledWith(expect.objectContaining({
      originalname: 'report_q1.pdf',
      mode: 'upload',
      folderId: 42,
      assetPath: 'docs/images/report_q1.pdf',
      user: req.user
    }))
    expect(res.send).toHaveBeenCalledWith('ok')
  })

})
