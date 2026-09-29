import { open } from 'node:fs/promises'

export interface PdfStreamData {
  readonly byteLength: number
  chunks(): Iterable<Uint8Array>
}

type PdfStream = { dictionary: string; data: Buffer | PdfStreamData }
type PdfObject = string | PdfStream | undefined

const byteLengthOf = (value: PdfObject): number => {
  if (value === undefined) throw new Error('PDF fixture contains an unset object')
  if (typeof value === 'string') return Buffer.byteLength(value)
  return Buffer.byteLength(`<< ${value.dictionary} /Length ${value.data.byteLength} >>\nstream\n`) + value.data.byteLength + Buffer.byteLength('\nendstream')
}

/** Builds classic-xref fixtures without relying on a PDF implementation library. */
export class PdfFixtureDocument {
  private readonly objects: PdfObject[] = [undefined]

  reserveObject(): number {
    this.objects.push(undefined)
    return this.objects.length - 1
  }

  addStream(dictionary: string, data: Buffer | PdfStreamData): number {
    const id = this.reserveObject()
    this.setObject(id, { dictionary, data })
    return id
  }

  setObject(id: number, value: string | PdfStream): void {
    if (id < 1 || id >= this.objects.length || this.objects[id] !== undefined) throw new Error(`Invalid PDF fixture object ${id}`)
    this.objects[id] = value
  }

  toBuffer(rootObject: number, maximumBytes = 16 * 1024 * 1024): Buffer {
    const layout = this.layout(rootObject)
    if (layout.byteLength > maximumBytes) throw new Error(`PDF fixture exceeds in-memory limit (${layout.byteLength} bytes)`)
    const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n')]
    for (let id = 1; id < this.objects.length; id++) {
      const value = this.objects[id]
      if (value === undefined) throw new Error(`PDF fixture object ${id} was not set`)
      chunks.push(Buffer.from(`${id} 0 obj\n`))
      if (typeof value === 'string') chunks.push(Buffer.from(value))
      else {
        chunks.push(Buffer.from(`<< ${value.dictionary} /Length ${value.data.byteLength} >>\nstream\n`))
        if (Buffer.isBuffer(value.data)) chunks.push(value.data)
        else for (const chunk of value.data.chunks()) chunks.push(Buffer.from(chunk))
        chunks.push(Buffer.from('\nendstream'))
      }
      chunks.push(Buffer.from('\nendobj\n'))
    }
    chunks.push(Buffer.from(layout.trailer))
    return Buffer.concat(chunks)
  }

  async writeTo(path: string, rootObject: number, mode = 0o600): Promise<void> {
    const layout = this.layout(rootObject)
    const file = await open(path, 'wx', mode)
    try {
      await file.writeFile(Buffer.from('%PDF-1.7\n'))
      for (let id = 1; id < this.objects.length; id++) {
        const value = this.objects[id]
        if (value === undefined) throw new Error(`PDF fixture object ${id} was not set`)
        await file.writeFile(Buffer.from(`${id} 0 obj\n`))
        if (typeof value === 'string') await file.writeFile(Buffer.from(value))
        else {
          await file.writeFile(Buffer.from(`<< ${value.dictionary} /Length ${value.data.byteLength} >>\nstream\n`))
          if (Buffer.isBuffer(value.data)) await file.writeFile(value.data)
          else {
            let written = 0
            for (const chunk of value.data.chunks()) {
              written += chunk.byteLength
              if (written > value.data.byteLength) throw new Error(`PDF fixture stream ${id} exceeds its declared length`)
              await file.writeFile(chunk)
            }
            if (written !== value.data.byteLength) throw new Error(`PDF fixture stream ${id} does not match its declared length`)
          }
          await file.writeFile(Buffer.from('\nendstream'))
        }
        await file.writeFile(Buffer.from('\nendobj\n'))
      }
      await file.writeFile(Buffer.from(layout.trailer))
    } finally {
      await file.close()
    }
  }

  private layout(rootObject: number): { offsets: number[]; byteLength: number; trailer: string } {
    if (rootObject < 1 || rootObject >= this.objects.length) throw new Error(`Invalid PDF fixture root object ${rootObject}`)
    let offset = Buffer.byteLength('%PDF-1.7\n')
    const offsets: number[] = [0]
    for (let id = 1; id < this.objects.length; id++) {
      const value = this.objects[id]
      offsets.push(offset)
      offset += Buffer.byteLength(`${id} 0 obj\n`) + byteLengthOf(value) + Buffer.byteLength('\nendobj\n')
    }
    const trailer = this.xrefAndTrailer(offsets, rootObject, offset)
    return { offsets, byteLength: offset + Buffer.byteLength(trailer), trailer }
  }

  private xrefAndTrailer(offsets: number[], rootObject: number, xrefOffset: number): string {
    const entries = offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    return `xref\n0 ${offsets.length}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${offsets.length} /Root ${rootObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  }
}

export const repeatedPdfStream = (byteLength: number, byte = 0, chunkSize = 64 * 1024): PdfStreamData => ({
  byteLength,
  *chunks() {
    const chunk = Buffer.alloc(chunkSize, byte)
    let remaining = byteLength
    while (remaining > 0) {
      const length = Math.min(chunk.byteLength, remaining)
      yield chunk.subarray(0, length)
      remaining -= length
    }
  }
})
