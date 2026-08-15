/** @vitest-environment node */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'

const originalWIKI = global.WIKI

const CRLF = '\r\n'

let server
let tempRoot

const makePart = ({ name = 'mediaUpload', value, filename, type }) => {
  const headers = [`Content-Disposition: form-data; name="${name}"`]
  if (filename) {
    headers[0] += `; filename="${filename}"`
    headers.push(`Content-Type: ${type || 'application/octet-stream'}`)
  }

  return Buffer.concat([
    Buffer.from(headers.join(CRLF) + CRLF + CRLF),
    Buffer.isBuffer(value) ? value : Buffer.from(value || ''),
    Buffer.from(CRLF)
  ])
}

const makeMultipartBody = parts => {
  const boundary = `----wiki-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const buffers = []

  parts.forEach(part => {
    buffers.push(Buffer.from(`--${boundary}${CRLF}`))
    buffers.push(makePart(part))
  })
  buffers.push(Buffer.from(`--${boundary}--${CRLF}`))

  return {
    boundary,
    body: Buffer.concat(buffers)
  }
}

const request = ({ port, body, boundary }) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/u',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  }, res => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        // Non-JSON responses are exposed through the text field.
      }
      resolve({
        status: res.statusCode,
        text,
        json
      })
    })
  })
  req.on('error', reject)
  req.end(body)
})

const setupServer = async ({ maxFileSize = 1024 * 1024, maxFiles = 1 } = {}) => {
  vi.resetModules()

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-upload-integration-'))
  global.WIKI = {
    ROOTPATH: tempRoot,
    config: {
      dataPath: 'data',
      uploads: {
        maxFileSize,
        maxFiles
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

  const app = express()

  app.use((req, res, next) => {
    req.user = {
      id: 7,
      permissions: ['write:assets']
    }
    next()
  })

  const createUploadController = (await import('../../controllers/upload.ts')).default
  app.use(createUploadController(global.WIKI))
  app.use((err, req, res, next) => {
    void next
    res.status(599).json({
      name: err.name,
      code: err.code,
      message: err.message,
      field: err.field
    })
  })

  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    port: server.address().port,
    tempRoot,
    wiki: global.WIKI
  }
}

const postMultipart = async parts => {
  const { port } = server.address() ? { port: server.address().port } : await setupServer()
  return request({ port, ...makeMultipartBody(parts) })
}

afterEach(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    server = null
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
  if (originalWIKI === undefined) {
    delete global.WIKI
  } else {
    global.WIKI = originalWIKI
  }
})

describe('controllers/upload real multipart integration', () => {
  it('successfully uploads a single multipart file', async () => {
    const { wiki, tempRoot } = await setupServer()
    wiki.models.assets.upload.mockImplementationOnce(async payload => {
      expect(fs.existsSync(payload.path)).toBe(true)
    })

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      {
        filename: 'My File,Name;# V1.PNG',
        value: Buffer.from('hello upload'),
        type: 'image/png'
      }
    ])

    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
    expect(wiki.models.assets.upload).toHaveBeenCalledTimes(1)
    expect(wiki.models.assetFolders.getHierarchy).not.toHaveBeenCalled()
    expect(wiki.auth.checkAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), ['write:assets', 'manage:system'], {
      path: 'my_file_name_v1.png'
    })
    expect(wiki.models.assets.upload).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'upload',
      folderId: null,
      assetPath: 'my_file_name_v1.png',
      originalname: 'my_file_name_v1.png',
      user: expect.objectContaining({ id: 7 }),
      destination: path.join(tempRoot, 'data', 'uploads'),
      size: Buffer.byteLength('hello upload'),
      mimetype: 'image/png'
    }))
    expect(wiki.models.assets.upload.mock.calls[0][0].path).toEqual(expect.stringContaining(path.join(tempRoot, 'data', 'uploads')))
  })

  it('rejects metadata without a file', async () => {
    const { wiki } = await setupServer()

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) }
    ])

    expect(res.status).toBe(400)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'Missing upload payload.'
    })
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
  })

  it('rejects a file without metadata', async () => {
    const { wiki } = await setupServer()

    const res = await postMultipart([
      {
        filename: 'image.png',
        value: Buffer.from('hello upload'),
        type: 'image/png'
      }
    ])

    expect(res.status).toBe(400)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'Missing upload folder metadata.'
    })
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
  })

  it('rejects multiple files at the controller level when maxFiles allows them', async () => {
    const { wiki } = await setupServer({ maxFiles: 3 })

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'one.png', value: Buffer.from('one'), type: 'image/png' },
      { filename: 'two.png', value: Buffer.from('two'), type: 'image/png' }
    ])

    expect(res.status).toBe(400)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'You cannot upload multiple files within the same request.'
    })
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
  })

  it('surfaces multer file-size limit errors through the test error middleware', async () => {
    const { wiki } = await setupServer({ maxFileSize: 4 })

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'too-big.png', value: Buffer.from('hello upload'), type: 'image/png' }
    ])

    expect(res.status).toBe(599)
    expect(res.json).toEqual(expect.objectContaining({
      name: 'MulterError',
      code: 'LIMIT_FILE_SIZE',
      field: 'mediaUpload'
    }))
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
  })

  it('characterizes non-ASCII filename sanitization under multer 1.4.4', async () => {
    const { wiki } = await setupServer()

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'Résumé 2026.PNG', value: Buffer.from('hello'), type: 'image/png' }
    ])

    expect(res.status).toBe(200)
    expect(wiki.models.assets.upload).toHaveBeenCalledTimes(1)
    expect(wiki.models.assets.upload).toHaveBeenCalledWith(expect.objectContaining({
      originalname: 'résumé_2026.png',
      assetPath: 'résumé_2026.png'
    }))
  })
})
