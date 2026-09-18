import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from '../bun-test.mts'
import { AGENT_PDF_MAX_BYTES, AGENT_PDF_PART_MAX_BYTES, prepareAgentPdf } from '../../agents/pdf-preparation.ts'

const worker = fileURLToPath(new URL('../../agents/pdf-worker.py', import.meta.url))
const directories: string[] = []
const prepared: Awaited<ReturnType<typeof prepareAgentPdf>>[] = []
const python = (code: string, args: string[] = []) => {
  const result = spawnSync('python3', ['-I', '-B', '-c', code, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 })
  if (result.status !== 0) throw new Error(`PDF fixture failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout.trim()
}
const fixture = async (kind: 'plain' | 'empty' | 'encrypted' | 'compressible' | 'images' | 'many', pages = 4) => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-pdf-test-'))
  directories.push(directory)
  const path = join(directory, 'input.pdf')
  python(`
import pikepdf, sys, random
kind, path, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
pdf = pikepdf.Pdf.new()
for index in range(0 if kind == 'empty' else 1001 if kind == 'many' else count):
    page = pdf.add_blank_page()
    page.obj['/TestPageIndex'] = index + 1
    if kind == 'compressible':
        page.Contents = pdf.make_stream(b'0 0 m\\n' * 20000)
        page.obj['/Thumb'] = pdf.make_stream(b'unneeded thumbnail')
    if kind == 'images':
        image = pdf.make_stream(random.Random(index).randbytes(30000))
        image.Type = pikepdf.Name('/XObject')
        image.Subtype = pikepdf.Name('/Image')
        image.Width, image.Height = 100, 100
        image.ColorSpace = pikepdf.Name('/DeviceRGB')
        image.BitsPerComponent = 8
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im=image))
        page.Contents = pdf.make_stream(b'q 100 0 0 100 0 0 cm /Im Do Q\\n')
options = {'compress_streams': False}
if kind == 'encrypted':
    options['encryption'] = pikepdf.Encryption(owner='owner-password', user='user-password')
pdf.save(path, **options)
`, [kind, path, String(pages)])
  return { directory, path, payload: await readFile(path) }
}
const workerWithSmallParts = (path: string, threshold: number, outputLimit = 128 * 1024 * 1024) => JSON.parse(python(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('pdf_worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.OUTPUT_BYTES = int(sys.argv[4])
try:
    print(json.dumps(worker.prepare(sys.argv[2], int(sys.argv[3]))))
except worker.PreparationError as error:
    print(json.dumps({'error': str(error)}))
`, [worker, path, String(threshold), String(outputLimit)])) as { error?: string; pageCount: number; parts: { filename: string; startPage: number; endPage: number; byteLength: number }[] }

afterEach(async () => {
  await Promise.all(prepared.splice(0).map(result => result.cleanup()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Agent PDF preparation with the real parser', () => {
  it('structurally parses a normal PDF while retaining its exact bytes and private file permissions', async () => {
    const input = await fixture('plain', 3)
    const result = await prepareAgentPdf(input.payload, new AbortController().signal)
    prepared.push(result)
    expect(AGENT_PDF_PART_MAX_BYTES).toBe(48_000_000)
    expect(result.pageCount).toBe(3)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]).toMatchObject({ startPage: 1, endPage: 3, byteLength: input.payload.length })
    expect(await readFile(result.parts[0]!.path)).toEqual(input.payload)
    expect((await stat(result.parts[0]!.path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(result.parts[0]!.path, '..'))).mode & 0o777).toBe(0o700)
    await result.cleanup()
    await result.cleanup()
    expect(await stat(result.parts[0]!.path).catch(() => null)).toBeNull()
  })

  it('rejects malformed PDFs including plausible PDF headers', async () => {
    await expect(prepareAgentPdf(Buffer.from('%PDF-1.7\nnot a PDF\n%%EOF'), new AbortController().signal)).rejects.toMatchObject({ code: 'PDF_INVALID', status: 400 })
  })

  it('rejects encrypted, empty and over-1000-page PDFs before provider upload', async () => {
    for (const [kind, code] of [['encrypted', 'PDF_ENCRYPTED'], ['empty', 'PDF_EMPTY'], ['many', 'PDF_TOO_MANY_PAGES']] as const) {
      const input = await fixture(kind)
      await expect(prepareAgentPdf(input.payload, new AbortController().signal)).rejects.toMatchObject({ code })
    }
  })

  it('losslessly compresses oversized streams and removes thumbnails before deciding to split', async () => {
    const input = await fixture('compressible', 2)
    expect(input.payload.length).toBeGreaterThan(40_000)
    const result = workerWithSmallParts(input.path, 40_000)
    expect(result.error).toBeUndefined()
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]!.byteLength).toBeLessThan(40_000)
    const details = JSON.parse(python(`
import pikepdf, json, sys
with pikepdf.open(sys.argv[1]) as pdf:
    print(json.dumps({'pages': len(pdf.pages), 'contentBytes': [len(p.Contents.read_bytes()) for p in pdf.pages], 'thumbnails': any('/Thumb' in p.obj for p in pdf.pages)}))
`, [join(input.directory, result.parts[0]!.filename)]))
    expect(details).toEqual({ pages: 2, contentBytes: [120000, 120000], thumbnails: false })
  })

  it('splits image-heavy pages into contiguous bounded parts without changing image bytes', async () => {
    const input = await fixture('images', 4)
    const result = workerWithSmallParts(input.path, 40_000)
    expect(result.error).toBeUndefined()
    expect(result.pageCount).toBe(4)
    expect(result.parts.map(part => [part.startPage, part.endPage])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]])
    for (const part of result.parts) {
      expect(part.byteLength).toBeLessThanOrEqual(40_000)
      const verified = python(`
import pikepdf, sys
with pikepdf.open(sys.argv[1]) as original, pikepdf.open(sys.argv[2]) as partial:
    offset = int(sys.argv[3]) - 1
    assert partial.pages[0].obj['/TestPageIndex'] == offset + 1
    assert partial.pages[0].Resources.XObject.Im.read_bytes() == original.pages[offset].Resources.XObject.Im.read_bytes()
    print('verified')
`, [input.path, join(input.directory, part.filename), String(part.startPage)])
      expect(verified).toBe('verified')
    }
  })

  it('rejects a single oversized page and documents requiring more than eight parts', async () => {
    const single = await fixture('images', 1)
    expect(workerWithSmallParts(single.path, 20_000).error).toBe('PDF_PAGE_TOO_LARGE')
    const many = await fixture('images', 9)
    expect(workerWithSmallParts(many.path, 40_000).error).toBe('PDF_TOO_MANY_PARTS')
  })

  it('bounds the cumulative size of split outputs', async () => {
    const input = await fixture('images', 4)
    expect(workerWithSmallParts(input.path, 40_000, 80_000).error).toBe('PDF_OUTPUT_TOO_LARGE')
  })

  it('independently rejects worker path traversal and noncontiguous page manifests', async () => {
    const input = await fixture('plain', 3)
    const binaryDirectory = await mkdtemp(join(tmpdir(), 'wiki-pdf-worker-test-'))
    directories.push(binaryDirectory)
    const previousPath = process.env.PATH
    try {
      process.env.PATH = `${binaryDirectory}:${previousPath}`
      for (const part of [
        { filename: '../input.pdf', startPage: 1, endPage: 3, byteLength: input.payload.length },
        { filename: 'input.pdf', startPage: 2, endPage: 3, byteLength: input.payload.length },
        { filename: 'input.pdf', startPage: 1, endPage: 2, byteLength: input.payload.length },
        { filename: 'input.pdf', startPage: 1, endPage: 3, byteLength: input.payload.length + 1 }
      ]) {
        const manifest = JSON.stringify({ pageCount: 3, parts: [part] })
        await writeFile(join(binaryDirectory, 'python3'), `#!/bin/sh\nprintf '%s' '${manifest}'\n`, { mode: 0o700 })
        await expect(prepareAgentPdf(input.payload, new AbortController().signal)).rejects.toMatchObject({ code: 'PDF_PREPARATION_FAILED' })
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('rejects oversized input and aborts before allocation', async () => {
    await expect(prepareAgentPdf(Buffer.alloc(AGENT_PDF_MAX_BYTES + 1), new AbortController().signal)).rejects.toMatchObject({ code: 'PDF_TOO_LARGE', status: 413 })
    const controller = new AbortController()
    controller.abort()
    await expect(prepareAgentPdf(Buffer.from('pdf'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds concurrency and releases the worker slot and temporary files after cancellation', async () => {
    const input = await fixture('plain', 3)
    const before = (await readdir(tmpdir())).filter(name => name.startsWith('wiki-agent-pdf-')).sort()
    const controller = new AbortController()
    const first = prepareAgentPdf(input.payload, controller.signal)
    await expect(prepareAgentPdf(input.payload, new AbortController().signal)).rejects.toMatchObject({ code: 'PDF_PREPARATION_BUSY', status: 503 })
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect((await readdir(tmpdir())).filter(name => name.startsWith('wiki-agent-pdf-')).sort()).toEqual(before)
    prepared.push(await prepareAgentPdf(input.payload, new AbortController().signal))
  })
})
