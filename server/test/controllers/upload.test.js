import path from 'node:path'

const uploadMocks = vi.hoisted(() => {
  const router = {
    get: vi.fn(),
    post: vi.fn(),
    use: vi.fn()
  }
  const arrayHandler = vi.fn((req, res, next) => next())
  const array = vi.fn(() => arrayHandler)
  const multer = vi.fn(() => ({ array }))

  return { router, arrayHandler, array, multer }
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
  const getCall = uploadMocks.router.get.mock.calls.find(([routePath]) => routePath === '/u')

  return {
    postCall,
    getCall,
    uploadMiddleware: postCall[1],
    uploadHandler: postCall[2],
    healthHandler: getCall[1]
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
        checkAccess: vi.fn().mockReturnValue(true)
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

  it('registers upload routes', async () => {
    const { postCall, getCall } = await loadHandlers()

    expect(postCall).toEqual(['/u', expect.any(Function), expect.any(Function)])
    expect(getCall).toEqual(['/u', expect.any(Function)])
  })

  it('returns the upload health response', async () => {
    const { healthHandler } = await loadHandlers()
    const res = makeRes()

    await healthHandler({}, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith({ ok: true })
  })

  it('configures multer with the upload directory, limits and media field', async () => {
    const { uploadMiddleware } = await loadHandlers()
    const req = {}
    const res = {}
    const next = vi.fn()

    uploadMiddleware(req, res, next)

    expect(uploadMocks.multer).toHaveBeenCalledWith({
      dest: path.resolve('/wiki/root', 'data', 'uploads'),
      limits: {
        fileSize: 12345,
        files: 7
      },
      defParamCharset: 'utf8'
    })
    expect(uploadMocks.array).toHaveBeenCalledWith('mediaUpload')
    expect(uploadMocks.arrayHandler).toHaveBeenCalledWith(req, res, expect.any(Function))
    expect(next).toHaveBeenCalledOnce()
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
    expect(global.WIKI.models.assetFolders.getHierarchy).not.toHaveBeenCalled()
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })

  it('rejects empty upload payloads', async () => {
    const { uploadHandler } = await loadHandlers()
    const req = makeReq({ files: [] })
    const res = makeRes()

    await uploadHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'Missing upload payload.'
    })
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })

  it('rejects multiple files in one request', async () => {
    const { uploadHandler } = await loadHandlers()
    const req = makeReq({
      files: [makeFile({ originalname: 'one.png' }), makeFile({ originalname: 'two.png' })]
    })
    const res = makeRes()

    await uploadHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'You cannot upload multiple files within the same request.'
    })
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })

  it.each([
    ['missing metadata', {}],
    ['invalid metadata json', { mediaUpload: 'not-json' }]
  ])('rejects %s', async (label, body) => {
    const { uploadHandler } = await loadHandlers()
    const req = makeReq({ body })
    const res = makeRes()

    await uploadHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'Missing upload folder metadata.'
    })
    expect(global.WIKI.models.assetFolders.getHierarchy).not.toHaveBeenCalled()
    expect(global.WIKI.auth.checkAccess).not.toHaveBeenCalled()
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })

  it('normalizes folderId 0 to root and uploads with sanitized filename', async () => {
    const { uploadHandler } = await loadHandlers()
    const req = makeReq({
      files: [makeFile({ originalname: 'My File,Name;# V1.PNG' })],
      body: {
        mediaUpload: JSON.stringify({ folderId: 0 })
      }
    })
    const res = makeRes()

    await uploadHandler(req, res, vi.fn())

    expect(global.WIKI.models.assetFolders.getHierarchy).not.toHaveBeenCalled()
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['write:assets', 'manage:system'], {
      path: 'my_file_name_v1.png'
    })
    expect(global.WIKI.models.assets.upload).toHaveBeenCalledWith(expect.objectContaining({
      originalname: 'my_file_name_v1.png',
      mode: 'upload',
      folderId: null,
      assetPath: 'my_file_name_v1.png',
      user: req.user
    }))
    expect(res.send).toHaveBeenCalledWith('ok')
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
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['write:assets', 'manage:system'], {
      path: 'docs/images/report_q1.pdf'
    })
    expect(global.WIKI.models.assets.upload).toHaveBeenCalledWith(expect.objectContaining({
      originalname: 'report_q1.pdf',
      mode: 'upload',
      folderId: 42,
      assetPath: 'docs/images/report_q1.pdf',
      user: req.user
    }))
    expect(res.send).toHaveBeenCalledWith('ok')
  })

  it('returns 400 when folder hierarchy lookup fails', async () => {
    global.WIKI.models.assetFolders.getHierarchy.mockRejectedValueOnce(new Error('db unavailable'))

    const { uploadHandler } = await loadHandlers()
    const req = makeReq({
      body: {
        mediaUpload: JSON.stringify({ folderId: 42 })
      }
    })
    const res = makeRes()

    await uploadHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'Failed to fetch folder hierarchy.'
    })
    expect(global.WIKI.auth.checkAccess).not.toHaveBeenCalled()
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })

  it('rejects uploads when path-level asset access fails', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)

    const { uploadHandler } = await loadHandlers()
    const req = makeReq()
    const res = makeRes()

    await uploadHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'You are not authorized to upload files to this folder.'
    })
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })
})
