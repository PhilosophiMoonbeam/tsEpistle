import { EventEmitter } from 'node:events'
import * as cheerio from 'cheerio'
import MarkdownIt from 'markdown-it'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'


const { requestMock, requestState, resolveState, resolveUrlMock } = vi.hoisted(() => {
  const requestState = { implementation: null }
  const resolveState = { implementation: null }
  return {
    requestState,
    resolveState,
    resolveUrlMock: vi.fn((...args) => {
      if (!resolveState.implementation) throw new Error('URL resolver fake is not configured')
      return resolveState.implementation(...args)
    }),
    requestMock: vi.fn((...args) => {
      if (!requestState.implementation) throw new Error('HTTPS request fake is not configured')
      return requestState.implementation(...args)
    })
  }
})
vi.mockModule('../../core/webhooks.ts', import.meta.url, () => ({ resolveWebhookUrl: resolveUrlMock }))
vi.mockModule('node:https', import.meta.url, () => ({ request: requestMock }))
// The renderer captures WIKI during module initialization, so install its runtime dependency first.
const loggerWarn = vi.fn()
vi.stubGlobal('WIKI', { logger: { warn: loggerWarn } })

const { default: renderer, imagePrefetchLimits } = await vi.importFresh('../../modules/rendering/html-image-prefetch/renderer.ts', import.meta.url)
const { default: plantUmlRenderer } = await import('../../modules/rendering/markdown-plantuml/renderer.ts')

class MockResponse extends EventEmitter {
  constructor (statusCode, headers = {}) {
    super()
    this.statusCode = statusCode
    this.headers = headers
    this.destroyed = false
    this.resumed = false
  }

  destroy () {
    this.destroyed = true
    return this
  }

  resume () {
    this.resumed = true
    return this
  }
}

const diagram = (source, server = 'https://diagram.example') => {
  const markdown = new MarkdownIt()
  plantUmlRenderer.init(markdown, { server, imageFormat: 'svg' })
  return markdown.render(`\`\`\`plantuml\n${source}\n\`\`\``)
}

const render = async html => {
  const $ = cheerio.load(html, null, false)
  await renderer.init($)
  return $
}

const respond = implementation => {
  requestState.implementation = (url, options, callback) => {
    const request = new EventEmitter()
    request.end = () => queueMicrotask(() => implementation({ callback, options, request, url }))
    return request
  }
}

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('HTML diagram image prefetch security', () => {
  beforeEach(() => {
    resolveUrlMock.mockClear()
    requestMock.mockClear()
    loggerWarn.mockClear()
    resolveState.implementation = async value => ({
      url: new URL(value),
      address: '93.184.216.34',
      family: 4
    })
    requestState.implementation = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores author-tagged arbitrary loopback, metadata, and private-network images', async () => {
    const $ = await render(
      '<img class="prefetch-candidate" src="http://127.0.0.1/admin">' +
      '<img class="prefetch-candidate" src="http://169.254.169.254/latest/meta-data/">' +
      '<img data-diagram-prefetch="forged" src="https://10.0.0.2/private">'
    )

    expect(requestMock).not.toHaveBeenCalled()
    expect(resolveUrlMock).not.toHaveBeenCalled()
    expect($('img').eq(0).attr('src')).toBe('http://127.0.0.1/admin')
    expect($('img').eq(1).attr('src')).toBe('http://169.254.169.254/latest/meta-data/')
    expect($('img').eq(2).attr('src')).toBe('https://10.0.0.2/private')
    expect($('img').eq(2).attr('data-diagram-prefetch')).toBeUndefined()
  })

  it('rejects a configured diagram host when DNS resolves it to a private address', async () => {
    resolveState.implementation = async () => {
      throw new TypeError('Webhook URL must resolve to a public network address')
    }
    const $ = cheerio.load(diagram('private DNS'), null, false)
    const url = $('img').attr('src')
    expect(url).toBeDefined()
    await renderer.init($)

    expect(resolveUrlMock).toHaveBeenCalledTimes(1)
    expect(requestMock).not.toHaveBeenCalled()
    expect($('img').attr('src')).toBe(url)
  })

  it('pins public DNS on every same-origin redirect and embeds an accepted bounded image', async () => {
    const $ = cheerio.load(diagram('Alice -> Bob'), null, false)
    expect($('img').attr('src')?.startsWith('https://diagram.example/svg/')).toBe(true)
    expect($('img').attr('data-diagram-prefetch')).toBeDefined()
    const redirect = new MockResponse(302, { location: '/rendered/value' })
    const rendered = new MockResponse(200, { 'content-type': 'image/svg+xml; charset=utf-8' })
    let requestNumber = 0
    respond(({ callback }) => {
      requestNumber += 1
      if (requestNumber === 1) {
        callback(redirect)
      } else {
        callback(rendered)
        queueMicrotask(() => queueMicrotask(() => {
          rendered.emit('data', Buffer.from('<svg/>'))
          rendered.emit('end')
        }))
      }
    })

    await renderer.init($)

    expect(resolveUrlMock).toHaveBeenCalledTimes(2)
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(redirect.resumed).toBe(true)
    expect($('img').attr('src')).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)
    const lookup = requestMock.mock.calls[0][1].lookup
    const { promise, resolve, reject } = Promise.withResolvers()
    lookup('diagram.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family }))
    await expect(promise).resolves.toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('does not resolve or request redirects that change scheme, host, or port', async () => {
    const $ = cheerio.load([
      diagram('scheme redirect'),
      diagram('host redirect'),
      diagram('port redirect')
    ].join(''), null, false)
    const urls = $('img').toArray().map(element => $(element).attr('src'))
    const locations = new Map([
      [new URL(urls[0]).pathname, 'http://diagram.example/internal'],
      [new URL(urls[1]).pathname, 'https://169.254.169.254/latest/meta-data/'],
      [new URL(urls[2]).pathname, 'https://diagram.example:444/internal']
    ])
    respond(({ callback, url }) => callback(new MockResponse(302, { location: locations.get(url.pathname) })))

    await renderer.init($)

    expect(requestMock).toHaveBeenCalledTimes(3)
    expect(resolveUrlMock).toHaveBeenCalledTimes(3)
    expect($('img').toArray().map(element => $(element).attr('src'))).toEqual(urls)
  })

  it('rejects unsupported and oversized responses without embedding their bodies', async () => {
    const $ = cheerio.load(diagram('unsupported type') + diagram('oversized response'), null, false)
    const [unsupportedUrl, oversizedUrl] = $('img').toArray().map(element => $(element).attr('src'))
    const unsupported = new MockResponse(200, { 'content-type': 'application/octet-stream' })
    const oversized = new MockResponse(200, {
      'content-type': 'image/png',
      'content-length': String(imagePrefetchLimits.responseBytes + 1)
    })
    let responseNumber = 0
    respond(({ callback }) => {
      responseNumber += 1
      callback(responseNumber === 1 ? unsupported : oversized)
    })

    await renderer.init($)

    expect(unsupported.resumed).toBe(true)
    expect(oversized.destroyed).toBe(true)
    expect($('img').eq(0).attr('src')).toBe(unsupportedUrl)
    expect($('img').eq(1).attr('src')).toBe(oversizedUrl)
  })

  it('bounds concurrent requests and releases each worker after completion', async () => {
    const $ = cheerio.load(Array.from(
      { length: imagePrefetchLimits.concurrency + 2 },
      (_, index) => diagram(`concurrency ${index}`)
    ).join(''), null, false)
    const urls = $('img').toArray().map(element => $(element).attr('src'))
    const completions = []
    let active = 0
    let maximumActive = 0
    respond(({ callback }) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const response = new MockResponse(200, { 'content-type': 'image/png' })
      callback(response)
      completions.push(() => {
        active -= 1
        response.emit('data', Buffer.from('png'))
        response.emit('end')
      })
    })

    const rendering = renderer.init($)
    await vi.waitFor(() => expect(completions).toHaveLength(imagePrefetchLimits.concurrency))
    while (completions.length > 0) {
      completions.shift()()
      await Promise.resolve()
    }
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(urls.length))
    while (completions.length > 0) completions.shift()()
    await rendering

    expect(maximumActive).toBe(imagePrefetchLimits.concurrency)
    expect(active).toBe(0)
  })

  it('aborts a stalled request at the timeout and completes the bounded worker', async () => {
    vi.useFakeTimers()
    const $ = cheerio.load(diagram('stalled response'), null, false)
    const url = $('img').attr('src')
    expect(url).toBeDefined()
    let requestSignal
    requestState.implementation = (_url, options) => {
      requestSignal = options.signal
      const request = new EventEmitter()
      request.end = () => {
        options.signal.addEventListener('abort', () => request.emit('error', options.signal.reason), { once: true })
      }
      return request
    }

    const rendering = renderer.init($)
    await vi.advanceTimersByTimeAsync(0)
    expect(requestMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(imagePrefetchLimits.timeoutMs)
    await rendering

    expect(requestSignal.aborted).toBe(true)
    expect($('img').attr('src')).toBe(url)
    expect($('img').attr('data-diagram-prefetch')).toBeUndefined()
  })
})
