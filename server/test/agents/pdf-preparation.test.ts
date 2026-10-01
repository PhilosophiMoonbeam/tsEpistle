import { spawnSync } from 'node:child_process'
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from '../bun-test.mts'
import { AGENT_PDF_MAX_BYTES, AGENT_PDF_PART_MAX_BYTES, prepareAgentPdf, prepareAgentPdfFromPath, type PreparedAgentPdf } from '../../agents/pdf-preparation.ts'
import { preparePdfWorker } from '../../agents/pdf-worker.ts'
import { PdfFixtureDocument, repeatedPdfStream, type PdfStreamData } from './pdf-fixture.ts'

const directories: string[] = []
const prepared: PreparedAgentPdf[] = []
const qpdfMaxBuffer = 4 * 1024 * 1024

interface ImageFixture {
  data: Buffer | PdfStreamData
  filter?: string
  width?: number
  height?: number
}

interface PageFixture {
  content?: Buffer | PdfStreamData
  image?: ImageFixture
  entries?: string
}

interface PdfFixtureOptions {
  inheritedImage?: ImageFixture
  inheritMediaBox?: boolean
  sharedThumbnail?: Buffer
}

const makePdf = (pageFixtures: PageFixture[], options: PdfFixtureOptions = {}) => {
  const pdf = new PdfFixtureDocument()
  const catalogId = pdf.reserveObject()
  const pagesId = pdf.reserveObject()
  const pageIds = pageFixtures.map(() => pdf.reserveObject())
  const imageObject = (image: ImageFixture): number => pdf.addStream(
    `/Type /XObject /Subtype /Image /Width ${image.width ?? 100} /Height ${image.height ?? 100} /ColorSpace /DeviceRGB /BitsPerComponent 8${image.filter ? ` /Filter ${image.filter}` : ''}`,
    image.data
  )
  const inheritedImageId = options.inheritedImage ? imageObject(options.inheritedImage) : undefined
  const sharedThumbnailId = options.sharedThumbnail
    ? pdf.addStream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', options.sharedThumbnail)
    : undefined

  pageFixtures.forEach((page, index) => {
    const contentId = pdf.addStream('', page.content ?? Buffer.alloc(0))
    const imageId = page.image ? imageObject(page.image) : undefined
    const thumbnailId = sharedThumbnailId
    const resources = imageId === undefined ? '' : ` /Resources << /XObject << /Im ${imageId} 0 R >> >>`
    const mediaBox = options.inheritMediaBox ? '' : ' /MediaBox [0 0 612 792]'
    const thumbnail = thumbnailId === undefined ? '' : ` /Thumb ${thumbnailId} 0 R`
    pdf.setObject(
      pageIds[index]!,
      `<< /Type /Page /Parent ${pagesId} 0 R${mediaBox}${resources} /Contents ${contentId} 0 R /TestPageIndex ${index + 1}${thumbnail}${page.entries ? ` ${page.entries}` : ''} >>`
    )
  })

  const inheritedEntries = [
    options.inheritMediaBox ? '/MediaBox [0 0 612 792]' : '',
    inheritedImageId === undefined ? '' : `/Resources << /XObject << /Im ${inheritedImageId} 0 R >> >>`
  ].filter(Boolean).join(' ')
  pdf.setObject(pagesId, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length}${inheritedEntries ? ` ${inheritedEntries}` : ''} >>`)
  pdf.setObject(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  return { pdf, root: catalogId }
}

const newDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-pdf-test-'))
  directories.push(directory)
  return directory
}

const fixture = async (pages: PageFixture[], options: PdfFixtureOptions = {}) => {
  const directory = await newDirectory()
  const path = join(directory, 'input.pdf')
  const document = makePdf(pages, options)
  const payload = document.pdf.toBuffer(document.root)
  await writeFile(path, payload, { mode: 0o600 })
  return { directory, path, payload }
}

const deterministicBytes = (length: number, seed: number): Buffer => {
  const bytes = Buffer.allocUnsafe(length)
  let state = seed >>> 0
  for (let index = 0; index < length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state & 0xff
  }
  return bytes
}

const runQpdf = (args: string[], maxBuffer = qpdfMaxBuffer): Buffer => {
  const result = spawnSync('qpdf', args, { encoding: null, timeout: 30_000, maxBuffer })
  if (result.error) throw result.error
  if (result.status !== 0 && result.status !== 3) {
    const stderr = Buffer.from(result.stderr ?? '').toString('utf8')
    throw new Error(`qpdf command failed (${result.status}): ${stderr}`)
  }
  return Buffer.from(result.stdout ?? '')
}

const inspectPdf = (path: string): QpdfDocument => JSON.parse(
  runQpdf(['--json', '--json-stream-data=inline', path]).toString('utf8')
) as QpdfDocument

const qpdfPageCount = (path: string): number => Number(runQpdf(['--show-npages', path], 64 * 1024).toString('ascii').trim())

interface QpdfIndirectObject {
  value?: unknown
  stream?: { dict: Record<string, unknown>; data?: string }
}

interface QpdfDocument {
  pages: { object: string }[]
  qpdf: [Record<string, unknown>, Record<string, QpdfIndirectObject>]
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Unexpected qpdf JSON object')
  return value as Record<string, unknown>
}

const indirectObject = (document: QpdfDocument, reference: string): QpdfIndirectObject => {
  const object = document.qpdf[1][`obj:${reference}`]
  if (!object) throw new Error(`qpdf JSON omitted ${reference}`)
  return object
}

const resolveValue = (document: QpdfDocument, value: unknown): unknown => {
  if (typeof value !== 'string' || !/^\d+ \d+ R$/.test(value)) return value
  const object = indirectObject(document, value)
  if (object.value === undefined) throw new Error(`${value} is not a dictionary object`)
  return object.value
}

const pageDictionary = (document: QpdfDocument, index: number): Record<string, unknown> => {
  const page = document.pages[index]
  if (!page) throw new Error(`PDF is missing page ${index + 1}`)
  return asRecord(resolveValue(document, page.object))
}

const inheritedValue = (document: QpdfDocument, pageIndex: number, key: string): unknown => {
  let dictionary = pageDictionary(document, pageIndex)
  for (let depth = 0; depth < 100; depth++) {
    if (dictionary[key] !== undefined) return dictionary[key]
    const parent = dictionary['/Parent']
    if (typeof parent !== 'string') break
    dictionary = asRecord(resolveValue(document, parent))
  }
  return undefined
}

const streamBytes = (document: QpdfDocument, reference: string): Buffer => {
  const stream = indirectObject(document, reference).stream
  if (stream?.data === undefined) throw new Error(`${reference} is not an inline qpdf stream`)
  let data = Buffer.from(stream.data, 'base64')
  const filter = stream.dict['/Filter']
  const filters = Array.isArray(filter) ? filter : filter === undefined ? [] : [filter]
  for (const item of filters) {
    if (item === '/FlateDecode') data = inflateSync(data)
    else if (item !== '/DCTDecode') throw new Error(`Unsupported fixture inspection filter ${String(item)}`)
  }
  return data
}

const pageContents = (document: QpdfDocument, index: number): Buffer => {
  const contents = pageDictionary(document, index)['/Contents']
  const references = Array.isArray(contents) ? contents : [contents]
  return Buffer.concat(references.map(reference => {
    if (typeof reference !== 'string') throw new Error('Page content is not an indirect stream')
    return streamBytes(document, reference)
  }))
}

const pageImageBytes = (document: QpdfDocument, index: number): Buffer => {
  const resources = asRecord(resolveValue(document, inheritedValue(document, index, '/Resources')))
  const xobjects = asRecord(resolveValue(document, resources['/XObject']))
  const image = xobjects['/Im']
  if (typeof image !== 'string') throw new Error(`Page ${index + 1} has no /Im image`)
  return streamBytes(document, image)
}

const expectWorkerCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code })
}

afterEach(async () => {
  await Promise.all(prepared.splice(0).map(result => result.cleanup()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Agent PDF preparation with the real parser', () => {
  it('passes through a structurally parsed PDF byte-for-byte with private temporary files', async () => {
    const input = await fixture([{}, {}, {}])
    const result = await prepareAgentPdf(input.payload, new AbortController().signal)
    prepared.push(result)
    expect(result.pageCount).toBe(3)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]).toMatchObject({ startPage: 1, endPage: 3, byteLength: input.payload.length })
    expect(await readFile(result.parts[0]!.path)).toEqual(input.payload)
    expect(qpdfPageCount(result.parts[0]!.path)).toBe(3)
    expect((await stat(result.parts[0]!.path)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(result.parts[0]!.path))).mode & 0o777).toBe(0o700)
    await result.cleanup()
    await result.cleanup()
    expect(await stat(result.parts[0]!.path).catch(() => null)).toBeNull()
  })

  it('prepares a real near-249-MiB disk input into provider-sized output', async () => {
    const directory = await newDirectory()
    const path = join(directory, 'large.pdf')
    const input = makePdf([{
      content: Buffer.from('q 1024 0 0 84992 0 0 cm /Im Do Q\n'),
      image: {
        data: repeatedPdfStream(249 * 1024 * 1024),
        width: 1024,
        height: 84992
      }
    }])
    await input.pdf.writeTo(path, input.root)
    const inputBytes = (await stat(path)).size
    expect(inputBytes).toBeGreaterThan(249 * 1024 * 1024)
    expect(inputBytes).toBeLessThanOrEqual(AGENT_PDF_MAX_BYTES)
    const result = await prepareAgentPdfFromPath(path, new AbortController().signal)
    prepared.push(result)
    expect(result.pageCount).toBe(1)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]!.byteLength).toBeLessThan(AGENT_PDF_PART_MAX_BYTES)
    expect(qpdfPageCount(result.parts[0]!.path)).toBe(1)
  }, 60_000)

  it('rejects malformed PDFs and xref corruption instead of recovering their structure', async () => {
    const directory = await newDirectory()
    const malformedPath = join(directory, 'malformed.pdf')
    await writeFile(malformedPath, Buffer.from('%PDF-1.7\nnot a PDF\n%%EOF\n'), { mode: 0o600 })
    await expectWorkerCode(preparePdfWorker(malformedPath, new AbortController().signal), 'PDF_INVALID')

    const valid = await fixture([{}])
    const corrupted = Buffer.from(valid.payload)
    const xrefStart = corrupted.lastIndexOf(Buffer.from('\nxref\n')) + 1
    const subsectionLineEnd = corrupted.indexOf(0x0a, xrefStart + Buffer.byteLength('xref\n'))
    const freeEntryLineEnd = corrupted.indexOf(0x0a, subsectionLineEnd + 1)
    const firstObjectEntry = freeEntryLineEnd + 1
    corrupted.write('0000000000', firstObjectEntry, 10, 'ascii')
    const corruptedPath = join(valid.directory, 'corrupt-xref.pdf')
    await writeFile(corruptedPath, corrupted, { mode: 0o600 })
    await expectWorkerCode(preparePdfWorker(corruptedPath, new AbortController().signal), 'PDF_INVALID')
  })

  it('retains exact bytes for a structurally valid PDF with undecodable DCT data', async () => {
    const dctBytes = Buffer.from([0xff, 0xd8, 0x00, 0x19, 0xff, 0x00, 0x3a, 0xd9])
    const input = await fixture([
      { content: Buffer.from('q 100 0 0 100 0 0 cm /Im Do Q\n'), image: { data: dctBytes, filter: '/DCTDecode' } },
      {}
    ])
    const independentlyParsed = inspectPdf(input.path)
    expect(qpdfPageCount(input.path)).toBe(2)
    expect(pageImageBytes(independentlyParsed, 0)).toEqual(dctBytes)

    const result = await prepareAgentPdf(input.payload, new AbortController().signal)
    prepared.push(result)
    expect(result.pageCount).toBe(2)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]!.byteLength).toBe(input.payload.length)
    expect(await readFile(result.parts[0]!.path)).toEqual(input.payload)
  })

  it('rejects encrypted, empty, and over-1000-page inputs before they can be uploaded', async () => {
    const encryptedSource = await fixture([{}])
    const encryptedPath = join(encryptedSource.directory, 'encrypted.pdf')
    runQpdf(['--encrypt', 'user-password', 'owner-password', '256', '--', encryptedSource.path, encryptedPath], 64 * 1024)
    await expectWorkerCode(preparePdfWorker(encryptedPath, new AbortController().signal), 'PDF_ENCRYPTED')

    const empty = await fixture([])
    await expectWorkerCode(preparePdfWorker(empty.path, new AbortController().signal), 'PDF_EMPTY')

    const tooMany = await fixture(Array.from({ length: 1001 }, () => ({})))
    await expectWorkerCode(preparePdfWorker(tooMany.path, new AbortController().signal), 'PDF_TOO_MANY_PAGES')
  })

  it('losslessly compresses page content and removes a shared thumbnail before sizing output', async () => {
    const content = Buffer.from('0 0 m\n'.repeat(20_000))
    const thumbnail = deterministicBytes(64_000, 0x5a5a)
    const input = await fixture([{ content }, { content }], { sharedThumbnail: thumbnail })
    const original = inspectPdf(input.path)
    const originalThumbnails = [0, 1].map(index => pageDictionary(original, index)['/Thumb'])
    expect(originalThumbnails[0]).toBe(originalThumbnails[1])
    expect((await stat(input.path)).size).toBeGreaterThan(40_000)

    const result = await preparePdfWorker(input.path, new AbortController().signal, { partLimitBytes: 40_000 })
    expect(result.pageCount).toBe(2)
    expect(result.parts.map(part => [part.startPage, part.endPage])).toEqual([[1, 2]])
    const outputPath = join(input.directory, result.parts[0]!.filename)
    expect(result.parts[0]!.byteLength).toBeLessThan(40_000)
    const optimized = inspectPdf(outputPath)
    expect(optimized.pages).toHaveLength(2)
    for (const index of [0, 1]) {
      expect(pageContents(optimized, index)).toEqual(content)
      expect(pageDictionary(optimized, index)['/Thumb']).toBeUndefined()
      expect(pageDictionary(optimized, index)['/TestPageIndex']).toBe(index + 1)
    }
  })

  it('splits at page boundaries while preserving inherited resources, high-precision content, and image bytes', async () => {
    const image = { data: deterministicBytes(2_048, 0x12345678) }
    const pageContentsExpected = Array.from({ length: 4 }, (_, index) => Buffer.from(
      `0.12345678901234567890123456789 0 0 1 0 0 cm /Im Do Q\n% ${deterministicBytes(28_000, index + 1).toString('base64')}\n`
    ))
    const input = await fixture(
      pageContentsExpected.map(content => ({ content })),
      { inheritedImage: image, inheritMediaBox: true }
    )
    const originalBytes = await readFile(input.path)
    const result = await preparePdfWorker(input.path, new AbortController().signal, { partLimitBytes: 40_000 })
    expect(result.pageCount).toBe(4)
    expect(result.parts.map(part => [part.startPage, part.endPage])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]])

    for (const part of result.parts) {
      const outputPath = join(input.directory, part.filename)
      expect(part.byteLength).toBeLessThanOrEqual(40_000)
      expect((await stat(outputPath)).size).toBe(part.byteLength)
      expect(dirname(resolve(outputPath))).toBe(resolve(input.directory))
      const output = inspectPdf(outputPath)
      expect(output.pages).toHaveLength(1)
      const pageIndex = part.startPage - 1
      expect(pageDictionary(output, 0)['/TestPageIndex']).toBe(pageIndex + 1)
      expect(pageContents(output, 0)).toEqual(pageContentsExpected[pageIndex])
      expect(pageImageBytes(output, 0)).toEqual(image.data)
      expect(resolveValue(output, inheritedValue(output, 0, '/MediaBox'))).toEqual([0, 0, 612, 792])
    }
    expect(await readFile(input.path)).toEqual(originalBytes)
  })

  it('rejects an oversized single page, a ninth output part, and excessive cumulative output', async () => {
    const imagePages = (count: number) => Array.from({ length: count }, (_, index) => ({
      content: Buffer.from(`q 100 0 0 100 0 0 cm /Im Do Q\n% ${index}\n`),
      image: { data: deterministicBytes(30_000, index + 100) }
    }))
    const single = await fixture(imagePages(1))
    await expectWorkerCode(
      preparePdfWorker(single.path, new AbortController().signal, { partLimitBytes: 20_000 }),
      'PDF_PAGE_TOO_LARGE'
    )

    const nine = await fixture(imagePages(9))
    await expectWorkerCode(
      preparePdfWorker(nine.path, new AbortController().signal, { partLimitBytes: 40_000 }),
      'PDF_TOO_MANY_PARTS'
    )

    const four = await fixture(imagePages(4))
    await expectWorkerCode(
      preparePdfWorker(four.path, new AbortController().signal, { partLimitBytes: 40_000, outputLimitBytes: 80_000 }),
      'PDF_OUTPUT_TOO_LARGE'
    )
  })

  it('rejects oversized disk inputs and observes cancellation before starting work', async () => {
    const directory = await newDirectory()
    const oversizedPath = join(directory, 'oversized.pdf')
    const oversizedFile = await open(oversizedPath, 'w', 0o600)
    await oversizedFile.truncate(AGENT_PDF_MAX_BYTES + 1)
    await oversizedFile.close()
    await expect(prepareAgentPdfFromPath(oversizedPath, new AbortController().signal)).rejects.toMatchObject({ code: 'PDF_TOO_LARGE', status: 413 })

    const controller = new AbortController()
    controller.abort()
    await expect(preparePdfWorker(oversizedPath, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds public preparation concurrency and releases the worker slot and temporary files after cancellation', async () => {
    const input = await fixture([{}, {}, {}])
    const before = (await readdir(tmpdir())).filter(name => name.startsWith('wiki-agent-pdf-')).sort()
    const controller = new AbortController()
    const first = prepareAgentPdf(input.payload, controller.signal)
    await expect(prepareAgentPdf(input.payload, new AbortController().signal)).rejects.toMatchObject({ code: 'PDF_PREPARATION_BUSY', status: 503 })
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect((await readdir(tmpdir())).filter(name => name.startsWith('wiki-agent-pdf-')).sort()).toEqual(before)
    const result = await prepareAgentPdf(input.payload, new AbortController().signal)
    prepared.push(result)
    expect(result.pageCount).toBe(3)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]).toMatchObject({ startPage: 1, endPage: 3, byteLength: input.payload.length })
    expect(await readFile(result.parts[0]!.path)).toEqual(input.payload)
  })
})
