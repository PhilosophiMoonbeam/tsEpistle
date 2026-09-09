
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'

const originalWIKI = global.WIKI
const uploadAuthority = { permissions: ['write:assets', 'manage:system'], groups: [], tagAliases: {} }

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

const makeMalformedMultipartBody = parts => {
  const boundary = `----wiki-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const buffers = []

  parts.forEach(part => {
    buffers.push(Buffer.from(`--${boundary}${CRLF}`))
    buffers.push(makePart(part))
  })
  buffers.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="unfinished"`))

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

const setupServer = async ({ maxFileSize = 1024 * 1024, maxFiles = 1, authorized = true } = {}) => {
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
      checkAccess: vi.fn().mockReturnValue(authorized),
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

  const app = express()

  app.use((req, res, next) => {
    req.user = {
      id: 7,
      permissions: ['write:assets']
    }
    next()
  })

  const createUploadController = (await vi.importFresh('../../controllers/upload.ts', import.meta.url)).default
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

const uploadDirectoryFiles = () => { const directory = path.join(tempRoot, 'data', 'uploads'); return fs.existsSync(directory) ? fs.readdirSync(directory) : [] }

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
  it('rejects guests before multer writes a file', async () => {
    const { wiki } = await setupServer({ authorized: false })
    expect(uploadDirectoryFiles()).toEqual([])

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'guest.png', value: Buffer.from('guest upload'), type: 'image/png' }
    ])

    expect(res.status).toBe(403)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'You are not authorized to upload files.'
    })
    expect(wiki.auth.checkAccess).toHaveBeenCalledTimes(1)
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it.each([
    ['metadata before file', [
      { value: JSON.stringify({ folderId: 0 }) },
      {
        filename: 'My File,Name;# V1.PNG',
        value: Buffer.from('hello upload'),
        type: 'image/png'
      }
    ]],
    ['file before metadata', [
      {
        filename: 'My File,Name;# V1.PNG',
        value: Buffer.from('hello upload'),
        type: 'image/png'
      },
      { value: JSON.stringify({ folderId: 0 }) }
    ]]
  ])('successfully uploads a single multipart file with %s', async (_order, parts) => {
    const { wiki, tempRoot } = await setupServer()
    wiki.models.assets.upload.mockImplementationOnce(async payload => {
      expect(fs.existsSync(payload.path)).toBe(true)
    })

    const res = await postMultipart(parts)

    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
    expect(wiki.models.assets.upload).toHaveBeenCalledTimes(1)
    expect(wiki.models.assetFolders.getHierarchy).not.toHaveBeenCalled()
    expect(wiki.auth.loadPageRuleAuthority).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
    expect(wiki.auth.checkPageAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), ['write:assets', 'manage:system'], {
      path: 'my_file_name_v1.png'
    }, uploadAuthority)
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

  it('removes a persisted file when its metadata is invalid', async () => {
    const { wiki } = await setupServer()
    expect(uploadDirectoryFiles()).toEqual([])

    const res = await postMultipart([
      { value: '{invalid-json' },
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
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('applies changed file limits to new requests without recreating the controller', async () => {
    const { wiki } = await setupServer({ maxFileSize: 4 })
    const payload = [{ value: JSON.stringify({ folderId: 0 }) }, { filename: 'policy.txt', value: Buffer.from('five!'), type: 'text/plain' }]
    const rejected = await postMultipart(payload)
    expect(rejected.status).toBe(413)
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    wiki.config.uploads.maxFileSize = 100
    const accepted = await postMultipart(payload)
    expect(accepted.status).toBe(200)
    expect(wiki.models.assets.upload).toHaveBeenCalledOnce()
  })

  it('accepts a file exactly at the configured byte limit', async () => {
    const { wiki } = await setupServer({ maxFileSize: 4 })

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'exact.txt', value: Buffer.from('four'), type: 'text/plain' }
    ])

    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
    expect(wiki.models.assets.upload).toHaveBeenCalledOnce()
  })

  it('rejects metadata over 1024 bytes without echoing it and cleans staging', async () => {
    const { wiki } = await setupServer()
    const marker = 'attacker-metadata-marker'

    const res = await postMultipart([
      { filename: 'metadata-too-large.txt', value: Buffer.from('staged file'), type: 'text/plain' },
      { value: JSON.stringify({ folderId: 0, marker, padding: 'x'.repeat(1100) }) }
    ])

    expect(res.status).toBe(413)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'Upload metadata exceeds the allowed size.'
    })
    expect(res.text).not.toContain(marker)
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('rejects a second text field with a bounded response and cleans staging', async () => {
    const { wiki } = await setupServer()
    const fieldName = 'extra'

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { name: fieldName, value: 'unexpected' },
      { filename: 'second-field.txt', value: Buffer.from('staged file'), type: 'text/plain' }
    ])

    expect(res.status).toBe(400)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'Invalid multipart upload. Submit one mediaUpload metadata field and one file.'
    })
    expect(res.text).not.toContain(fieldName)
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it.each([
    ['long', { name: 'mediaUploadExtra', value: 'unexpected' }],
    ['nested', { name: 'a[b]', value: 'unexpected' }],
    ['huge-index', { name: 'a[999999]', value: 'unexpected' }]
  ])('rejects %s field names with a bounded response', async (_label, field) => {
    const { wiki } = await setupServer()

    const res = await postMultipart([
      field,
      { filename: 'invalid-field.txt', value: Buffer.from('staged file'), type: 'text/plain' }
    ])

    expect(res.status).toBe(400)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'Invalid multipart upload. Submit one mediaUpload metadata field and one file.'
    })
    expect(res.text).not.toContain(field.name)
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('accepts a valid follow-up after rejecting a structural multipart error', async () => {
    const { wiki } = await setupServer()

    const rejected = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { name: 'extra', value: 'unexpected' },
      { filename: 'rejected.txt', value: Buffer.from('staged file'), type: 'text/plain' }
    ])
    expect(rejected.status).toBe(400)
    expect(uploadDirectoryFiles()).toEqual([])

    const accepted = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'follow-up.txt', value: Buffer.from('valid'), type: 'text/plain' }
    ])

    expect(accepted.status).toBe(200)
    expect(accepted.text).toBe('ok')
    expect(wiki.models.assets.upload).toHaveBeenCalledOnce()
  })

  it('blocks new uploads when file capacity is zero', async () => {
    const { wiki } = await setupServer({ maxFileSize: 0 })
    const res = await postMultipart([{ value: JSON.stringify({ folderId: 0 }) }, { filename: 'empty.txt', value: Buffer.alloc(0), type: 'text/plain' }])
    expect(res.status).toBe(403)
    expect(res.json.message).toBe('File uploads are disabled by workspace policy.')
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('blocks new uploads when file capacity is non-positive', async () => {
    const { wiki } = await setupServer({ maxFiles: 0 })
    const res = await postMultipart([{ value: JSON.stringify({ folderId: 0 }) }, { filename: 'disabled.txt', value: Buffer.alloc(0), type: 'text/plain' }])
    expect(res.status).toBe(403)
    expect(res.json.message).toBe('File uploads are disabled by workspace policy.')
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('rejects a second file at the parser cap', async () => {
    const { wiki } = await setupServer({ maxFiles: 3 })

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'one.png', value: Buffer.from('one'), type: 'image/png' },
      { filename: 'two.png', value: Buffer.from('two'), type: 'image/png' }
    ])

    expect(res.status).toBe(400)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'Invalid multipart upload. Submit one mediaUpload metadata field and one file.'
    })
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('removes a persisted file when folder lookup fails', async () => {
    const { wiki } = await setupServer()
    wiki.models.assetFolders.getHierarchy.mockRejectedValueOnce(new Error('db unavailable'))

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 42 }) },
      { filename: 'folder.png', value: Buffer.from('folder upload'), type: 'image/png' }
    ])

    expect(res.status).toBe(400)
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('removes a persisted file when path authorization fails', async () => {
    const { wiki } = await setupServer()
    wiki.auth.checkPageAccess.mockReturnValueOnce(false)

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'forbidden.png', value: Buffer.from('forbidden upload'), type: 'image/png' }
    ])

    expect(res.status).toBe(403)
    expect(res.json).toEqual({
      succeeded: false,
      message: 'You are not authorized to upload files to this folder.'
    })
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('removes a persisted file when the asset commit fails', async () => {
    const { wiki } = await setupServer()
    wiki.models.assets.upload.mockRejectedValueOnce(new Error('asset commit failed'))

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'failed.png', value: Buffer.from('failed upload'), type: 'image/png' }
    ])

    expect(res.status).toBe(599)
    expect(wiki.models.assets.upload).toHaveBeenCalledTimes(1)
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('removes persisted files when multipart parsing fails', async () => {
    const { port, wiki } = await setupServer()
    const malformed = makeMalformedMultipartBody([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'malformed.png', value: Buffer.from('malformed upload'), type: 'image/png' }
    ])

    const res = await request({ port, ...malformed })

    expect(res.status).toBe(599)
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('reports the workspace file-size limit and removes incomplete files', async () => {
    const { wiki } = await setupServer({ maxFileSize: 4 })

    const res = await postMultipart([
      { value: JSON.stringify({ folderId: 0 }) },
      { filename: 'too-big.png', value: Buffer.from('hello upload'), type: 'image/png' }
    ])

    expect(res.status).toBe(413)
    expect(res.json).toEqual({ succeeded: false, message: 'This file exceeds the workspace upload limit.' })
    expect(wiki.models.assets.upload).not.toHaveBeenCalled()
    expect(uploadDirectoryFiles()).toEqual([])
  })

  it('characterizes non-ASCII filename sanitization under multer 2.3.0', async () => {
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
