import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it } from '../bun-test.mts'
import { decodeAgentAudioVideo } from '../../agents/media-decoding.ts'
import { validateAgentMedia } from '../../agents/media.ts'

const directories: string[] = []
const newDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-media-decoding-test-'))
  directories.push(directory)
  return directory
}
const runFixtureEncoder = (args: readonly string[], maxBuffer = 64 * 1024): Buffer => {
  const child = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args], {
    timeout: 20_000,
    maxBuffer,
    killSignal: 'SIGKILL'
  })
  if (child.error || child.status !== 0) throw new Error(`Media fixture encoding failed: ${child.error?.message ?? child.stderr.toString()}`)
  return child.stdout
}
const audioInput = (duration = 0.5, rate = 16000): string => `sine=frequency=440:sample_rate=${rate}:duration=${duration}`
const videoInput = (duration = 0.5, size = '16x16', rate = 4): string => `color=c=blue:s=${size}:r=${rate}:d=${duration}`
const fixture = async (
  extension: string,
  input: string,
  options: readonly string[],
  output: 'seekable' | 'streaming' = 'seekable'
): Promise<{ payload: Buffer; path: string; directory: string }> => {
  const directory = await newDirectory()
  const path = join(directory, `input.${extension}`)
  if (output === 'streaming') {
    // Explicit live muxing prevents Duration/Cues backpatching even when Bun's
    // spawnSync captures stdout in a seekable fd rather than an OS pipe.
    const payload = runFixtureEncoder(['-f', 'lavfi', '-i', input, '-threads', '1', ...options, '-f', 'webm', '-live', '1', 'pipe:1'], 8 * 1024 * 1024)
    await writeFile(path, payload, { mode: 0o600 })
    return { payload, path, directory }
  }
  runFixtureEncoder(['-f', 'lavfi', '-i', input, '-threads', '1', ...options, path])
  return { payload: await readFile(path), path, directory }
}
type FixtureEbmlElement = { id: number; start: number; end: number; unknownSize: boolean }
const fixtureEbmlElements = function* (payload: Buffer, start: number, end: number): Generator<FixtureEbmlElement> {
  while (start < end) {
    let idWidth = 1
    while (idWidth <= 4 && !(payload[start]! & (0x80 >>> (idWidth - 1)))) idWidth++
    if (idWidth > 4 || start + idWidth >= end) throw new Error('Incomplete fixture EBML ID')
    const id = payload.readUIntBE(start, idWidth)
    const sizeOffset = start + idWidth
    let sizeWidth = 1
    while (sizeWidth <= 8 && !(payload[sizeOffset]! & (0x80 >>> (sizeWidth - 1)))) sizeWidth++
    if (sizeWidth > 8 || sizeOffset + sizeWidth > end) throw new Error('Incomplete fixture EBML size')
    let size = BigInt(payload[sizeOffset]! & ((0x80 >>> (sizeWidth - 1)) - 1))
    for (let index = 1; index < sizeWidth; index++) size = (size << 8n) | BigInt(payload[sizeOffset + index]!)
    const unknownSize = size === (1n << BigInt(7 * sizeWidth)) - 1n
    const contentStart = sizeOffset + sizeWidth
    if (!unknownSize && size > BigInt(end - contentStart)) throw new Error('Incomplete fixture EBML payload')
    const contentEnd = unknownSize ? end : contentStart + Number(size)
    yield { id, start: contentStart, end: contentEnd, unknownSize }
    start = contentEnd
  }
}
const webmHeader = (payload: Buffer): { duration: FixtureEbmlElement | undefined; opus: boolean } => {
  for (const root of fixtureEbmlElements(payload, 0, payload.length)) {
    if (root.id !== 0x18538067) continue
    let duration: FixtureEbmlElement | undefined
    let info = false
    let opus = false
    for (const element of fixtureEbmlElements(payload, root.start, root.end)) {
      if (element.id === 0x1f43b675) break
      if (element.unknownSize) throw new Error('Unknown-size fixture metadata')
      if (element.id === 0x1549a966) {
        info = true
        for (const field of fixtureEbmlElements(payload, element.start, element.end)) {
          if (field.id !== 0x4489) continue
          if (field.unknownSize || duration) throw new Error('Invalid fixture Duration framing')
          duration = field
        }
      } else if (element.id === 0x1654ae6b) {
        for (const entry of fixtureEbmlElements(payload, element.start, element.end)) {
          if (entry.id !== 0xae) continue
          for (const field of fixtureEbmlElements(payload, entry.start, entry.end)) {
            if (field.id === 0x86 && payload.toString('utf8', field.start, field.end) === 'A_OPUS') opus = true
          }
        }
      }
    }
    if (!info) throw new Error('Fixture Segment has no Info')
    return { duration, opus }
  }
  throw new Error('Fixture has no Matroska Segment')
}

const webmOpusPackets = (payload: Buffer, path: string): { start: number; end: number }[] => {
  const child = spawnSync(
    'ffprobe',
    ['-v', 'error', '-fflags', '+noparse+nofillin', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=pos,size', '-of', 'json', path],
    { timeout: 20_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }
  )
  if (child.error || child.status !== 0 || child.stderr.length) throw new Error('Could not locate fixture Opus packets')
  const probe = JSON.parse(child.stdout.toString()) as { packets: { pos: string; size: string }[] }
  if (probe.packets.length < 2) throw new Error('Expected multiple fixture Opus packets')
  return probe.packets.map(packet => {
    const pos = Number(packet.pos)
    const size = Number(packet.size)
    // FFprobe's Matroska packet position is the Block binary payload: the
    // single-track fixture has a one-byte track VINT, timestamp and flags.
    if (
      !Number.isSafeInteger(pos) ||
      pos < 0 ||
      !Number.isSafeInteger(size) ||
      size < 2 ||
      pos + 4 + size > payload.length ||
      payload[pos] !== 0x81 ||
      (payload[pos + 3]! & 0x06) !== 0
    )
      throw new Error('Expected complete unlaced single-track Matroska blocks')
    return { start: pos + 4, end: pos + 4 + size }
  })
}
const webmAudioMetadata = (payload: Buffer, path: string): unknown => {
  // ffprobe runs avformat_find_stream_info, including the same empty Opus
  // parser EOF flush as ffmpeg 8.0.1. Identify A_OPUS in actual Tracks before
  // bypassing this parser; do not suppress stderr or change live fixture bytes.
  const child = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      ...(webmHeader(payload).opus ? ['-fflags', '+noparse+nofillin'] : []),
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,sample_rate,channels,duration',
      '-of',
      'json',
      path
    ],
    { timeout: 20_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }
  )
  if (child.error || child.status !== 0 || child.stderr.length)
    throw new Error(`Fixture metadata probing failed: ${child.error?.message ?? child.stderr.toString()}`)
  return JSON.parse(child.stdout.toString())
}
const withWebmDuration = (payload: Buffer, seconds: number): Buffer => {
  // Change the real Info/Duration field, never a matching byte sequence inside
  // an encoded packet. TimestampScale in these fixtures is one millisecond.
  const duration = webmHeader(payload).duration
  if (!duration || duration.end - duration.start !== 8) throw new Error('Fixture has no eight-byte Matroska Duration')
  const changed = Buffer.from(payload)
  changed.writeDoubleBE(seconds * 1000, duration.start)
  return changed
}
const formats = [
  { mimeType: 'audio/wav', extension: 'wav', input: audioInput(), options: ['-c:a', 'pcm_s16le'] },
  { mimeType: 'audio/mpeg', extension: 'mp3', input: audioInput(), options: ['-c:a', 'libmp3lame', '-b:a', '32k'] },
  { mimeType: 'audio/webm', extension: 'webm', input: audioInput(0.5, 48000), options: ['-c:a', 'libopus'] },
  { mimeType: 'audio/aac', extension: 'aac', input: audioInput(), options: ['-c:a', 'aac', '-f', 'adts'] },
  { mimeType: 'audio/flac', extension: 'flac', input: audioInput(), options: ['-c:a', 'flac'] },
  { mimeType: 'video/webm', extension: 'webm', input: videoInput(), options: ['-c:v', 'libvpx', '-pix_fmt', 'yuv420p'] },
  { mimeType: 'video/mp4', extension: 'mp4', input: videoInput(), options: ['-c:v', 'mpeg4', '-pix_fmt', 'yuv420p'] }
] as const

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** Replace the self-contained MOV data reference with a real external media file. */
const externalMov = (payload: Buffer, externalPath: string): Buffer => {
  const containers: Readonly<Record<string, true>> = { moov: true, trak: true, mdia: true, minf: true, dinf: true, dref: true }
  let replaced = false
  const rewrite = (start: number, end: number): Buffer => {
    const output: Buffer[] = []
    for (let offset = start; offset < end; ) {
      const size = payload.readUInt32BE(offset)
      if (size < 8 || offset + size > end) throw new Error('Invalid fixture MOV atom')
      const type = payload.toString('ascii', offset + 4, offset + 8)
      if (type === 'url ') {
        // Macintosh alias records are the external references actually followed by FFmpeg.
        const path = Buffer.from(externalPath)
        const paddedPath = Buffer.alloc(path.length + (path.length % 2))
        path.copy(paddedPath)
        const alias = Buffer.alloc(150)
        const pathEntry = Buffer.alloc(4)
        pathEntry.writeUInt16BE(2)
        pathEntry.writeUInt16BE(path.length, 2)
        const endEntry = Buffer.from([255, 255, 0, 0])
        const header = Buffer.alloc(12)
        header.writeUInt32BE(header.length + alias.length + pathEntry.length + paddedPath.length + endEntry.length)
        header.write('alis', 4, 'ascii')
        output.push(header, alias, pathEntry, paddedPath, endEntry)
        replaced = true
      } else if (containers[type]) {
        const prefixSize = type === 'dref' ? 16 : 8
        const children = rewrite(offset + prefixSize, offset + size)
        const header = Buffer.from(payload.subarray(offset, offset + prefixSize))
        header.writeUInt32BE(header.length + children.length)
        output.push(header, children)
      } else if (type !== 'mdat') {
        output.push(payload.subarray(offset, offset + size))
      }
      offset += size
    }
    return Buffer.concat(output)
  }
  const result = rewrite(0, payload.length)
  if (!replaced) throw new Error('MOV fixture has no data reference')
  return result
}

describe('bounded complete Agent audio/video decoding', () => {
  it('honors an already-cancelled request without consuming decoder capacity', async () => {
    const input = await fixture('wav', audioInput(), ['-c:a', 'pcm_s16le'])
    const controller = new AbortController()
    const reason = new Error('cancel before decoding')
    controller.abort(reason)
    await expect(decodeAgentAudioVideo(input.payload, 'audio/wav', controller.signal)).rejects.toBe(reason)
    const decoded = await decodeAgentAudioVideo(input.payload, 'audio/wav')
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(0.49)
  })

  it.each(formats)('decodes a complete playable $mimeType through EOF', async format => {
    const input = await fixture(format.extension, format.input, format.options)
    const decoded = await decodeAgentAudioVideo(input.payload, format.mimeType)
    expect(validateAgentMedia(input.payload, format.mimeType)).toBe(format.mimeType)
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(0.49)
    expect(decoded.durationSeconds).toBeLessThan(0.7)
  })

  it('decodes the exact 200 ms 16 kHz sine Opus/WebM reproducer through EOF and rejects container and packet truncation', async () => {
    // Keep the reproducer's input rate and output-side duration: filter-side
    // duration or a 48 kHz input can miss the FFmpeg 8.0.1 parser regression.
    const input = await fixture('webm', 'sine=frequency=440:sample_rate=16000', ['-t', '0.2', '-c:a', 'libopus', '-f', 'webm'])
    expect(validateAgentMedia(input.payload, 'audio/webm')).toBe('audio/webm')
    const decoded = await decodeAgentAudioVideo(input.payload, 'audio/webm')
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(0.19)
    expect(decoded.durationSeconds).toBeLessThan(0.25)
    const lastPacket = webmOpusPackets(input.payload, input.path).at(-1)!
    for (const end of [input.payload.length - 7, lastPacket.end - 1]) {
      await expect(decodeAgentAudioVideo(input.payload.subarray(0, end), 'audio/webm')).rejects.toMatchObject({
        code: 'INVALID_AGENT_MEDIA'
      })
    }
  })

  it.each([
    { name: 'zero frame count', count: 0 },
    { name: 'over 120 ms of frames', count: 63 }
  ])('rejects a malformed final Opus packet with $name despite valid unchanged WebM metadata', async ({ count }) => {
    const input = await fixture('webm', 'sine=frequency=440:sample_rate=16000', ['-t', '0.2', '-c:a', 'libopus', '-f', 'webm'])
    const lastPacket = webmOpusPackets(input.payload, input.path).at(-1)!
    const malformed = Buffer.from(input.payload)
    // RFC 6716 §3.2.5/R5: a code-3 Opus packet must have a nonzero frame
    // count and at most 120 ms of audio. Alter no EBML sizes or timestamps,
    // and keep earlier valid packets so partial decoding cannot imply success.
    malformed[lastPacket.start] = (malformed[lastPacket.start]! & 0xfc) | 3
    malformed[lastPacket.start + 1] = count
    const path = join(input.directory, 'malformed.webm')
    await writeFile(path, malformed, { mode: 0o600 })
    expect(webmAudioMetadata(malformed, path)).toEqual(webmAudioMetadata(input.payload, input.path))
    // Independent control: disabling the AVParser does not hide this fault.
    // The reference decoder must reject the packet contents themselves.
    const reference = spawnSync(
      'ffmpeg',
      ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-fflags', '+noparse+nofillin', '-c:a', 'libopus', '-i', path, '-f', 'null', '-'],
      { timeout: 20_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }
    )
    expect(reference.error).toBeUndefined()
    expect(reference.status).not.toBeNull()
    expect(reference.status).not.toBe(0)
    expect(reference.stderr.toString()).toContain('Decoding error:')
    await expect(decodeAgentAudioVideo(malformed, 'audio/webm')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
  })

  it.each([
    { mimeType: 'audio/webm', input: 'sine=frequency=440:sample_rate=16000', options: ['-t', '0.2', '-c:a', 'libopus'], minimum: 0.2, maximum: 0.25 },
    { mimeType: 'video/webm', input: videoInput(), options: ['-c:v', 'libvpx', '-pix_fmt', 'yuv420p'], minimum: 0.5, maximum: 0.7 }
  ])('derives $mimeType duration from complete decoding of a real nonseekable recording with no declared duration', async format => {
    const input = await fixture('webm', format.input, format.options, 'streaming')
    // ffprobe may estimate format.duration from packet timing even though the
    // nonseekable muxer emitted no Info/Duration. Prove the raw declaration is
    // absent at its EBML path instead of assuming a probe inference is absent.
    expect(webmHeader(input.payload).duration).toBeUndefined()
    const decoded = await decodeAgentAudioVideo(input.payload, format.mimeType)
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(format.minimum)
    expect(decoded.durationSeconds).toBeLessThan(format.maximum)
    await expect(decodeAgentAudioVideo(input.payload.subarray(0, input.payload.length - 7), format.mimeType)).rejects.toMatchObject({
      code: 'INVALID_AGENT_MEDIA'
    })
  })

  it('retains the longer decoded stream duration when a live WebM video ends before its audio', async () => {
    const directory = await newDirectory()
    const path = join(directory, 'live-audio-video.webm')
    const payload = runFixtureEncoder(
      [
        '-f',
        'lavfi',
        '-i',
        videoInput(),
        '-f',
        'lavfi',
        '-i',
        audioInput(2, 48000),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-threads',
        '1',
        '-c:v',
        'libvpx',
        '-c:a',
        'libopus',
        '-f',
        'webm',
        '-live',
        '1',
        'pipe:1'
      ],
      8 * 1024 * 1024
    )
    await writeFile(path, payload, { mode: 0o600 })
    expect(webmHeader(payload).duration).toBeUndefined()
    const decoded = await decodeAgentAudioVideo(payload, 'video/webm')
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(2)
    expect(decoded.durationSeconds).toBeLessThan(2.1)
  })

  it('does not understate decoded samples when WebM duration and monotonic packet timestamps are forged short', async () => {
    const input = await fixture('webm', audioInput(0.5, 48000), ['-c:a', 'libopus'])
    const changed = withWebmDuration(input.payload, 0.01)
    // This short fixture has one zero-timestamp Cluster. Compress only each
    // Block's relative timestamp, retaining every actual encoded Opus sample.
    for (const packet of webmOpusPackets(input.payload, input.path)) {
      const timestamp = input.payload.readInt16BE(packet.start - 3)
      changed.writeInt16BE(Math.floor(timestamp / 10), packet.start - 3)
    }
    const path = join(input.directory, 'short-duration.webm')
    await writeFile(path, changed, { mode: 0o600 })
    expect(webmAudioMetadata(changed, path)).toMatchObject({ format: { duration: '0.010000' } })
    const decoded = await decodeAgentAudioVideo(changed, 'audio/webm')
    expect(decoded.durationSeconds).toBeGreaterThanOrEqual(0.5)
    expect(decoded.durationSeconds).toBeLessThan(0.7)
  })

  it.each([
    { name: 'audio sample duration', input: audioInput(1801, 8000), options: ['-c:a', 'libopus', '-b:a', '8k'], mimeType: 'audio/webm' },
    { name: 'video duration', input: videoInput(301, '16x16', 1), options: ['-c:v', 'libvpx'], mimeType: 'video/webm' },
    { name: 'video frame work', input: videoInput(151, '16x16', 120), options: ['-c:v', 'libvpx'], mimeType: 'video/webm' }
  ])(
    'rejects actual decoded $name above the ceiling even when the live header has no duration',
    async format => {
      const input = await fixture('webm', format.input, format.options, 'streaming')
      expect(webmHeader(input.payload).duration).toBeUndefined()
      await expect(decodeAgentAudioVideo(input.payload, format.mimeType)).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    },
    30_000
  )

  it('rejects a video longer than the ceiling even when its declared WebM duration is forged short', async () => {
    const input = await fixture('webm', videoInput(301, '16x16', 1), ['-c:v', 'libvpx'])
    const changed = withWebmDuration(input.payload, 0.01)
    const path = join(input.directory, 'short-duration.webm')
    await writeFile(path, changed, { mode: 0o600 })
    expect(webmAudioMetadata(changed, path)).toMatchObject({ format: { duration: '0.010000' } })
    await expect(decodeAgentAudioVideo(changed, 'video/webm')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
  }, 30_000)

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'rejects a present corrupt Matroska duration %s rather than treating it as an omitted live-header field',
    async seconds => {
      const input = await fixture('webm', audioInput(0.5, 48000), ['-c:a', 'libopus'])
      await expect(decodeAgentAudioVideo(withWebmDuration(input.payload, seconds), 'audio/webm')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    }
  )

  it.each(formats)('rejects header-only and truncated $mimeType instead of accepting a signature', async format => {
    const input = await fixture(format.extension, format.input, format.options)
    await expect(decodeAgentAudioVideo(input.payload.subarray(0, 12), format.mimeType)).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await expect(decodeAgentAudioVideo(input.payload.subarray(0, input.payload.length - 7), format.mimeType)).rejects.toMatchObject({
      code: 'INVALID_AGENT_MEDIA'
    })
  })

  it('requires complete normal, extended and UUID MP4 metadata boxes even after every media sample is available', async () => {
    const input = await fixture('mp4', videoInput(), ['-c:v', 'mpeg4'])
    const ordinary = Buffer.alloc(24)
    ordinary.writeUInt32BE(ordinary.length)
    ordinary.write('free', 4, 'ascii')
    const extended = Buffer.alloc(32)
    extended.writeUInt32BE(1)
    extended.write('free', 4, 'ascii')
    extended.writeBigUInt64BE(BigInt(extended.length), 8)
    const uuid = Buffer.alloc(32)
    uuid.writeUInt32BE(uuid.length)
    uuid.write('uuid', 4, 'ascii')
    const extendedUuid = Buffer.alloc(40)
    extendedUuid.writeUInt32BE(1)
    extendedUuid.write('uuid', 4, 'ascii')
    extendedUuid.writeBigUInt64BE(BigInt(extendedUuid.length), 8)
    const toEof = Buffer.from(ordinary)
    toEof.writeUInt32BE(0)
    for (const complete of [ordinary, extended, uuid, extendedUuid, toEof]) {
      expect((await decodeAgentAudioVideo(Buffer.concat([input.payload, complete]), 'video/mp4')).durationSeconds).toBeGreaterThanOrEqual(0.49)
    }
    // Metadata beyond playable samples must not turn malformed EOF into success.
    for (const complete of [ordinary, extended, uuid, extendedUuid]) {
      await expect(decodeAgentAudioVideo(Buffer.concat([input.payload, complete.subarray(0, complete.length - 7)]), 'video/mp4')).rejects.toMatchObject({
        code: 'INVALID_AGENT_MEDIA'
      })
    }
    const undersized = Buffer.from(ordinary.subarray(0, 8))
    undersized.writeUInt32BE(7)
    const undersizedUuid = Buffer.from(uuid.subarray(0, 16))
    undersizedUuid.writeUInt32BE(undersizedUuid.length)
    const undersizedExtendedUuid = Buffer.from(extendedUuid.subarray(0, 24))
    undersizedExtendedUuid.writeBigUInt64BE(BigInt(undersizedExtendedUuid.length), 8)
    const unknown = Buffer.from(ordinary.subarray(0, 16))
    unknown.write('zzzz', 4, 'ascii')
    const oversized = Buffer.from(extended)
    oversized.writeBigUInt64BE(1n << 63n, 8)
    const undersizedExtended = Buffer.from(extended.subarray(0, 16))
    undersizedExtended.writeBigUInt64BE(15n, 8)
    for (const malformed of [
      ordinary.subarray(0, 7),
      extended.subarray(0, 12),
      undersized,
      undersizedUuid,
      undersizedExtendedUuid,
      unknown,
      oversized,
      undersizedExtended
    ]) {
      await expect(decodeAgentAudioVideo(Buffer.concat([input.payload, malformed]), 'video/mp4')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    }
  })

  it('decodes faststart MP4 with a final size-zero mdat through EOF but rejects a truncated media packet', async () => {
    const input = await fixture('mp4', videoInput(), ['-c:v', 'mpeg4', '-movflags', '+faststart'])
    const changed = Buffer.from(input.payload)
    let mdat: number | undefined
    for (let offset = 0; offset < changed.length; ) {
      const size = changed.readUInt32BE(offset)
      if (size < 8 || offset + size > changed.length) throw new Error('Invalid fixture MP4 box')
      if (changed.toString('ascii', offset + 4, offset + 8) === 'mdat') {
        if (offset + size !== changed.length) throw new Error('Expected final fixture mdat')
        mdat = offset
      }
      offset += size
    }
    if (mdat === undefined) throw new Error('Fixture has no mdat')
    const packets = spawnSync(
      'ffprobe',
      ['-v', 'error', '-fflags', '+noparse+nofillin', '-show_packets', '-show_entries', 'packet=pos,size', '-of', 'json', input.path],
      { timeout: 20_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }
    )
    if (packets.error || packets.status !== 0 || packets.stderr.length) throw new Error(`Fixture packet probing failed: ${packets.stderr.toString()}`)
    const packetProbe = z
      .object({
        packets: z.array(z.object({ pos: z.coerce.number().int().nonnegative(), size: z.coerce.number().int().positive() })).min(1)
      })
      .parse(JSON.parse(packets.stdout.toString()))
    const last = packetProbe.packets.at(-1)!
    const sampleStart = last.pos
    const sampleSize = last.size
    expect(sampleStart + sampleSize).toBe(input.payload.length)
    changed.writeUInt32BE(0, mdat)
    expect((await decodeAgentAudioVideo(changed, 'video/mp4')).durationSeconds).toBeGreaterThanOrEqual(0.49)
    for (const payload of [input.payload, changed]) {
      // The native packet extent proves both cuts remove declared sample
      // bytes, not optional padding after the final sample.
      for (const end of [payload.length - 7, sampleStart + Math.floor(sampleSize / 2)]) {
        await expect(decodeAgentAudioVideo(payload.subarray(0, end), 'video/mp4')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
      }
    }
  })

  it.each([
    { declared: ' Audio/MP3; codecs=mp3 ', canonical: 'audio/mpeg', extension: 'mp3', options: ['-c:a', 'libmp3lame', '-b:a', '32k'] },
    { declared: 'audio/x-wav', canonical: 'audio/wav', extension: 'wav', options: ['-c:a', 'pcm_s16le'] },
    { declared: 'audio/m4a', canonical: 'audio/mp4', extension: 'm4a', options: ['-c:a', 'aac'] }
  ])('accepts and canonicalizes a playable $declared at storage and decoding boundaries', async format => {
    const input = await fixture(format.extension, audioInput(), format.options)
    expect(validateAgentMedia(input.payload, format.declared)).toBe(format.canonical)
    expect((await decodeAgentAudioVideo(input.payload, format.declared)).durationSeconds).toBeGreaterThanOrEqual(0.49)
  })

  it('accepts complete optional MP3 metadata but rejects an incomplete declared frame before it', async () => {
    const input = await fixture('mp3', audioInput(), ['-c:a', 'libmp3lame', '-b:a', '32k'])
    const tag = Buffer.alloc(128)
    tag.write('TAG')
    expect((await decodeAgentAudioVideo(Buffer.concat([input.payload, tag]), 'audio/mpeg')).durationSeconds).toBeGreaterThanOrEqual(0.49)
    const ape = Buffer.alloc(32)
    ape.write('APETAGEX')
    ape.writeUInt32LE(2000, 8)
    ape.writeUInt32LE(32, 12)
    expect((await decodeAgentAudioVideo(Buffer.concat([input.payload, ape, tag]), 'audio/mpeg')).durationSeconds).toBeGreaterThanOrEqual(0.49)
    await expect(decodeAgentAudioVideo(Buffer.concat([input.payload.subarray(0, input.payload.length - 7), tag]), 'audio/mpeg')).rejects.toMatchObject({
      code: 'INVALID_AGENT_MEDIA'
    })
  })

  it('rejects declared containers and modalities that do not match the decoded streams', async () => {
    const wav = await fixture('wav', audioInput(), ['-c:a', 'pcm_s16le'])
    const mp4 = await fixture('mp4', videoInput(), ['-c:v', 'mpeg4', '-movflags', '+faststart'])
    const webmAudio = await fixture('webm', audioInput(0.5, 48000), ['-c:a', 'libopus'])
    await expect(decodeAgentAudioVideo(wav.payload, 'audio/mpeg')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await expect(decodeAgentAudioVideo(mp4.payload, 'video/webm')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await expect(decodeAgentAudioVideo(mp4.payload, 'audio/mp4')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    await expect(decodeAgentAudioVideo(webmAudio.payload, 'video/webm')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
  })

  it('rejects excess streams, including multiple playable video tracks', async () => {
    const directory = await newDirectory()
    for (const twoVideos of [false, true]) {
      const path = join(directory, twoVideos ? 'two-videos.mp4' : 'three-streams.mp4')
      runFixtureEncoder([
        '-f',
        'lavfi',
        '-i',
        videoInput(),
        '-f',
        'lavfi',
        '-i',
        twoVideos ? videoInput() : audioInput(),
        ...(twoVideos ? [] : ['-f', 'lavfi', '-i', audioInput(0.5, 48000)]),
        '-map',
        '0',
        '-map',
        '1',
        ...(twoVideos ? [] : ['-map', '2']),
        '-threads',
        '1',
        '-c:v',
        'mpeg4',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        path
      ])
      await expect(decodeAgentAudioVideo(await readFile(path), 'video/mp4')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    }
  })

  it.each([
    { name: 'audio duration', extension: 'mp3', input: audioInput(1801, 8000), options: ['-c:a', 'libmp3lame', '-b:a', '8k'], mimeType: 'audio/mpeg' },
    { name: 'video duration', extension: 'mp4', input: videoInput(301, '16x16', 1), options: ['-c:v', 'mpeg4'], mimeType: 'video/mp4' },
    { name: 'video width', extension: 'mp4', input: videoInput(0.25, '4098x16', 4), options: ['-c:v', 'mpeg4'], mimeType: 'video/mp4' },
    { name: 'video pixel budget', extension: 'mp4', input: videoInput(0.25, '4096x2162', 4), options: ['-c:v', 'mpeg4'], mimeType: 'video/mp4' },
    { name: 'video frame rate', extension: 'mp4', input: videoInput(0.25, '16x16', 121), options: ['-c:v', 'mpeg4'], mimeType: 'video/mp4' },
    { name: 'total frame work', extension: 'mp4', input: videoInput(151, '16x16', 120), options: ['-c:v', 'mpeg4'], mimeType: 'video/mp4' },
    { name: 'audio sample rate', extension: 'wav', input: audioInput(0.5, 4000), options: ['-c:a', 'pcm_s16le'], mimeType: 'audio/wav' }
  ])(
    'rejects a fully encoded file exceeding the $name bound',
    async format => {
      const input = await fixture(format.extension, format.input, format.options)
      await expect(decodeAgentAudioVideo(input.payload, format.mimeType)).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
    },
    30_000
  )

  it('denies a real MOV external data reference even when its referenced media is locally available', async () => {
    const input = await fixture('mp4', videoInput(), ['-c:v', 'mpeg4', '-movflags', '+faststart'])
    const reference = externalMov(input.payload, input.path)
    const path = join(input.directory, 'reference.mov')
    await writeFile(path, reference, { mode: 0o600 })
    // Independent control proves this is a decodable external-reference file, not just malformed bytes.
    runFixtureEncoder(['-enable_drefs', '1', '-use_absolute_path', '1', '-i', path, '-f', 'null', '-'])
    await expect(decodeAgentAudioVideo(reference, 'video/mp4')).rejects.toMatchObject({ code: 'INVALID_AGENT_MEDIA' })
  })

  it('cancels an active real decoder, reaps its child, removes private files and releases capacity within a wall-clock bound', async () => {
    const input = await fixture('wav', audioInput(), ['-c:a', 'pcm_s16le'])
    const driver = join(input.directory, 'cancel.ts')
    await writeFile(
      driver,
      `
import assert from 'node:assert/strict'
import { readFile, readlink, stat } from 'node:fs/promises'
import { decodeAgentAudioVideo } from ${JSON.stringify(new URL('../../agents/media-decoding.ts', import.meta.url).href)}
const payload = await readFile(${JSON.stringify(input.path)})
const originalSpawn = Bun.spawn
const started = Promise.withResolvers()
Bun.spawn = new Proxy(originalSpawn, {
  apply(target, receiver, args) {
    const child = Reflect.apply(target, receiver, args)
    child.kill('SIGSTOP')
    started.resolve(child)
    return child
  }
})
const controller = new AbortController()
const reason = new Error('cancel bounded decoding')
const decoding = decodeAgentAudioVideo(payload, 'audio/wav', controller.signal)
let child
let timer
try {
  child = await started.promise
  const directory = await readlink('/proc/' + child.pid + '/cwd')
  controller.abort(reason)
  // Real children require a platform-clock deadline; fake timers cannot bound an OS process.
  const timeout = Promise.withResolvers()
  timer = setTimeout(() => timeout.reject(new Error('Decoder did not cancel within 2000ms')), 2000)
  await Promise.race([assert.rejects(decoding, error => error === reason), timeout.promise])
  await child.exited
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH')
  await assert.rejects(stat(directory), error => error.code === 'ENOENT')
  Bun.spawn = originalSpawn
  const recovered = await Promise.all([decodeAgentAudioVideo(payload, 'audio/wav'), decodeAgentAudioVideo(payload, 'audio/wav')])
  assert.ok(recovered.every(result => result.durationSeconds >= 0.49))
} finally {
  clearTimeout(timer)
  controller.abort(reason)
  Bun.spawn = originalSpawn
  if (child && child.exitCode === null) child.kill('SIGKILL')
  await child?.exited
  await decoding.catch(() => {})
}
`,
      { mode: 0o600 }
    )
    const child = spawnSync(process.execPath, [driver], { timeout: 10_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', detached: true })
    let assertionFailed = false
    let assertionError: unknown
    let cleanupError: unknown
    try {
      expect(child.error).toBeUndefined()
      expect(child.stderr.toString()).toBe('')
      expect(child.status).toBe(0)
    } catch (error) {
      assertionFailed = true
      assertionError = error
    } finally {
      // Also reap an orphan decoder if the outer helper deadline ever terminates its parent.
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupError = error
        }
      }
    }
    if (assertionFailed) {
      if (cleanupError !== undefined) throw new AggregateError([assertionError, cleanupError], 'Decoder assertion and orphan cleanup failed')
      throw assertionError
    }
    expect(cleanupError).toBeUndefined()
  }, 15_000)
})
