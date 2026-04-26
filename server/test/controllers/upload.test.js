jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    post: jest.fn(),
    use: jest.fn()
  }

  return {
    Router: () => router,
    __router: router
  }
})

jest.mock('multer', () => {
  const arrayHandler = jest.fn((req, res, next) => next())
  const array = jest.fn(() => arrayHandler)
  const multer = jest.fn(() => ({ array }))

  multer.__array = array
  multer.__arrayHandler = arrayHandler

  return multer
})

const path = require('path')

const makeRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
  send: jest.fn()
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

const loadHandlers = () => {
  const express = require('express')
  require('../../controllers/upload')

  const postCall = express.__router.post.mock.calls.find(([routePath]) => routePath === '/u')
  const getCall = express.__router.get.mock.calls.find(([routePath]) => routePath === '/u')

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
    jest.resetModules()

    const express = require('express')
    express.__router.get.mockClear()
    express.__router.post.mockClear()
    express.__router.use.mockClear()

    const multer = require('multer')
    multer.mockClear()
    multer.__array.mockClear()
    multer.__arrayHandler.mockClear()
    multer.__arrayHandler.mockImplementation((req, res, next) => next())

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
        checkAccess: jest.fn().mockReturnValue(true)
      },
      models: {
        assetFolders: {
          getHierarchy: jest.fn()
        },
        assets: {
          upload: jest.fn().mockResolvedValue()
        }
      }
    }
  })

  it('registers upload routes', () => {
    const { postCall, getCall } = loadHandlers()

    expect(postCall).toEqual(['/u', expect.any(Function), expect.any(Function)])
    expect(getCall).toEqual(['/u', expect.any(Function)])
  })

  it('returns the upload health response', async () => {
    const { healthHandler } = loadHandlers()
    const res = makeRes()

    await healthHandler({}, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith({ ok: true })
  })

  it('configures multer with the upload directory, limits and media field', () => {
    const { uploadMiddleware } = loadHandlers()
    const multer = require('multer')
    const req = {}
    const res = {}
    const next = jest.fn()

    uploadMiddleware(req, res, next)

    expect(multer).toHaveBeenCalledWith({
      dest: path.resolve('/wiki/root', 'data', 'uploads'),
      limits: {
        fileSize: 12345,
        files: 7
      }
    })
    expect(multer.__array).toHaveBeenCalledWith('mediaUpload')
    expect(multer.__arrayHandler).toHaveBeenCalledWith(req, res, next)
  })

  it('rejects users without upload permissions before processing files', async () => {
    const { uploadHandler } = loadHandlers()
    const req = makeReq({
      user: {
        id: 7,
        permissions: ['read:pages']
      }
    })
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'You are not authorized to upload files.'
    })
    expect(global.WIKI.models.assetFolders.getHierarchy).not.toHaveBeenCalled()
    expect(global.WIKI.auth.checkAccess).not.toHaveBeenCalled()
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })

  it('rejects empty upload payloads', async () => {
    const { uploadHandler } = loadHandlers()
    const req = makeReq({ files: [] })
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'Missing upload payload.'
    })
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })

  it('rejects multiple files in one request', async () => {
    const { uploadHandler } = loadHandlers()
    const req = makeReq({
      files: [makeFile({ originalname: 'one.png' }), makeFile({ originalname: 'two.png' })]
    })
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

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
    const { uploadHandler } = loadHandlers()
    const req = makeReq({ body })
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

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
    const { uploadHandler } = loadHandlers()
    const req = makeReq({
      files: [makeFile({ originalname: 'My File,Name;# V1.PNG' })],
      body: {
        mediaUpload: JSON.stringify({ folderId: 0 })
      }
    })
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

    expect(global.WIKI.models.assetFolders.getHierarchy).not.toHaveBeenCalled()
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['write:assets'], {
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

    const { uploadHandler } = loadHandlers()
    const req = makeReq({
      body: {
        mediaUpload: JSON.stringify({ folderId: 42 })
      }
    })
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

    expect(global.WIKI.models.assetFolders.getHierarchy).toHaveBeenCalledWith(42)
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['write:assets'], {
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

    const { uploadHandler } = loadHandlers()
    const req = makeReq({
      body: {
        mediaUpload: JSON.stringify({ folderId: 42 })
      }
    })
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

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

    const { uploadHandler } = loadHandlers()
    const req = makeReq()
    const res = makeRes()

    await uploadHandler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({
      succeeded: false,
      message: 'You are not authorized to upload files to this folder.'
    })
    expect(global.WIKI.models.assets.upload).not.toHaveBeenCalled()
  })
})
