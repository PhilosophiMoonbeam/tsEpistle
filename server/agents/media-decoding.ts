import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRepositoryError } from './repository.ts'
import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_GENERATED_AUDIO_MAX_BYTES, AGENT_GENERATED_VIDEO_MAX_BYTES } from '../../shared/agents/media-limits.ts'
import { normalizeAgentMediaMimeType } from '../../shared/agents/media-providers.ts'

const DEMUXERS: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'matroska',
  'audio/mp4': 'mov',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'video/mp4': 'mov',
  'video/webm': 'matroska'
}
// Static shell source only applies kernel limits; all commands/paths are positional arguments.
const LAUNCH = 'umask 077; ulimit -HSv 1048576 && ulimit -HSf 1024 && ulimit -HSn 64 && ulimit -HSc 0 && ulimit -HSt "$1" || exit 126; shift; exec "$@"'
const AUDIO_FRAME_STATS = /^agent_audio=(\d+):(-?\d+):(\d+)\/(\d+)$/u
const VIDEO_FRAME_STATS = /^agent_video=(-?\d+):(\d+)\/(\d+)$/u
const invalid = (): never => {
  throw new AgentRepositoryError('INVALID_AGENT_MEDIA', 'The media file failed bounded complete decoding.', 400)
}

// A missing duration is normal for a completed nonseekable WebM recording,
// but a present invalid/over-limit declaration must not become "unknown".
const declaredDurationSeconds = (value: unknown, limit: number): number => {
  if (value === undefined) return 0
  if (typeof value !== 'string' || value.trim() === '') return invalid()
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > limit) return invalid()
  return seconds
}
// MOV demuxing can tolerate an incomplete trailing moov/metadata box after
// finding playable samples. Decode-to-EOF therefore also needs complete outer
// framing: sizes include the header, size 1 adds a uint64 size, and size 0
// consumes the rest of the file as the last top-level box. Unknown box payloads
// stay opaque, but their declared bytes must exist; uuid includes a 16-byte ID.
// https://developer.apple.com/documentation/quicktime-file-format/atoms
type MovBox = { type: number; start: number; end: number }
const readMovBox = (payload: Buffer, offset: number, parentEnd: number, topLevel = false): MovBox => {
  const remaining = parentEnd - offset
  if (remaining < 8) return invalid()
  let size = payload.readUInt32BE(offset)
  let headerSize = 8
  if (size === 1) {
    if (remaining < 16) return invalid()
    const extendedSize = payload.readBigUInt64BE(offset + 8)
    if (extendedSize > BigInt(remaining)) return invalid()
    size = Number(extendedSize)
    headerSize = 16
  } else if (size === 0) {
    if (!topLevel) return invalid()
    size = remaining
  }
  const type = payload.readUInt32BE(offset + 4)
  if (type === 0x75756964) headerSize += 16 // uuid
  if (size < headerSize || size > remaining) return invalid()
  return { type, start: offset + headerSize, end: offset + size }
}

// MOV's native sample index knows the original stsz/stz2 lengths, but FFmpeg
// mov_read_packet can clamp a sample to next_root_atom before av_get_packet.
// A size-zero mdat ending early can therefore lose bytes without a CORRUPT
// packet flag or decode error. Prove every declared chunk's sample extent fits
// the real file before decoding; encoded padding is still part of its sample.
const validateMovSampleTable = (payload: Buffer, start: number, end: number): void => {
  let sizes: MovBox | undefined
  let chunks: MovBox | undefined
  let mapping: MovBox | undefined
  for (let offset = start; offset < end; ) {
    const box = readMovBox(payload, offset, end)
    if (box.type === 0x7374737a || box.type === 0x73747a32) {
      // stsz/stz2
      if (sizes) return invalid()
      sizes = box
    } else if (box.type === 0x7374636f || box.type === 0x636f3634) {
      // stco/co64
      if (chunks) return invalid()
      chunks = box
    } else if (box.type === 0x73747363) {
      // stsc
      if (mapping) return invalid()
      mapping = box
    }
    offset = box.end
  }
  if (!sizes || !chunks || !mapping || sizes.end - sizes.start < 12 || chunks.end - chunks.start < 8 || mapping.end - mapping.start < 8) return invalid()
  const sampleCount = payload.readUInt32BE(sizes.start + 8)
  const compact = sizes.type === 0x73747a32
  const fixedSize = compact ? 0 : payload.readUInt32BE(sizes.start + 4)
  const bits = compact ? payload[sizes.start + 7]! : 32
  if ((bits !== 4 && bits !== 8 && bits !== 16 && bits !== 32) || (compact && bits === 32)) return invalid()
  if (!fixedSize && Math.ceil((sampleCount * bits) / 8) > sizes.end - sizes.start - 12) return invalid()
  const chunkCount = payload.readUInt32BE(chunks.start + 4)
  const chunkWidth = chunks.type === 0x636f3634 ? 8 : 4
  const mappingCount = payload.readUInt32BE(mapping.start + 4)
  if (chunkCount * chunkWidth > chunks.end - chunks.start - 8 || mappingCount * 12 > mapping.end - mapping.start - 8) return invalid()
  // Fragmented MP4 uses an empty initial sample table; native fragment parsing
  // and the complete decoder remain responsible for its actual samples.
  if (sampleCount === 0) {
    if (chunkCount || mappingCount) return invalid()
    return
  }
  if (chunkCount === 0 || mappingCount === 0) return invalid()
  let previousChunk = 0
  for (let index = 0; index < mappingCount; index++) {
    const entry = mapping.start + 8 + index * 12
    const firstChunk = payload.readUInt32BE(entry)
    if (
      firstChunk <= previousChunk ||
      firstChunk > chunkCount ||
      (index === 0 && firstChunk !== 1) ||
      payload.readUInt32BE(entry + 4) === 0 ||
      payload.readUInt32BE(entry + 8) === 0
    )
      return invalid()
    previousChunk = firstChunk
  }
  let mappingIndex = 0
  let sampleIndex = 0
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    while (mappingIndex + 1 < mappingCount && payload.readUInt32BE(mapping.start + 8 + (mappingIndex + 1) * 12) <= chunk + 1) mappingIndex++
    const count = payload.readUInt32BE(mapping.start + 12 + mappingIndex * 12)
    if (count > sampleCount - sampleIndex) return invalid()
    let bytes = fixedSize * count
    if (!fixedSize) {
      for (let index = sampleIndex; index < sampleIndex + count; index++) {
        const position = sizes.start + 12 + Math.floor((index * bits) / 8)
        bytes += bits === 4 ? (payload[position]! >>> (index % 2 === 0 ? 4 : 0)) & 15 : payload.readUIntBE(position, bits / 8)
      }
    }
    const position = chunks.start + 8 + chunk * chunkWidth
    const offset = chunkWidth === 8 ? payload.readBigUInt64BE(position) : BigInt(payload.readUInt32BE(position))
    if (offset > BigInt(payload.length) || !Number.isSafeInteger(bytes) || bytes > payload.length - Number(offset)) return invalid()
    sampleIndex += count
  }
  if (sampleIndex !== sampleCount) return invalid()
}

const MOV_SAMPLE_PATH = [0x7472616b, 0x6d646961, 0x6d696e66, 0x7374626c] as const // trak/mdia/minf/stbl
const validateMovSampleContainers = (payload: Buffer, start: number, end: number, level = 0): void => {
  for (let offset = start; offset < end; ) {
    const box = readMovBox(payload, offset, end)
    if (box.type === MOV_SAMPLE_PATH[level]) {
      if (level === MOV_SAMPLE_PATH.length - 1) validateMovSampleTable(payload, box.start, box.end)
      else validateMovSampleContainers(payload, box.start, box.end, level + 1)
    }
    offset = box.end
  }
}

const validateMovBoxes = (payload: Buffer): void => {
  for (let offset = 0; offset < payload.length; ) {
    const box = readMovBox(payload, offset, payload.length, true)
    if (box.type === 0x6d6f6f76) validateMovSampleContainers(payload, box.start, box.end) // moov
    offset = box.end
  }
}

const readEbmlElement = (payload: Buffer, offset: number, parentEnd: number): { id: number; start: number; end: number; unknownSize: boolean } => {
  let marker = 0x80
  let width = 1
  while (marker && !(payload[offset]! & marker)) {
    marker >>>= 1
    width++
  }
  if (width > 4 || offset + width > parentEnd) return invalid()
  const id = payload.readUIntBE(offset, width)
  offset += width
  marker = 0x80
  width = 1
  while (marker && !(payload[offset]! & marker)) {
    marker >>>= 1
    width++
  }
  if (width > 8 || offset + width > parentEnd) return invalid()
  let size = payload[offset]! & (marker - 1)
  let unknownSize = size === marker - 1
  for (let index = 1; index < width; index++) {
    const byte = payload[offset + index]!
    size = size * 256 + byte
    unknownSize &&= byte === 255
  }
  const start = offset + width
  if (!unknownSize && (!Number.isSafeInteger(size) || size > parentEnd - start)) return invalid()
  return { id, start, end: unknownSize ? parentEnd : start + size, unknownSize }
}

const matroskaTracks = (payload: Buffer, start: number, end: number): { opus: boolean; audio: boolean; video: boolean } => {
  let opus = false
  let audio = false
  let video = false
  for (let offset = start; offset < end; ) {
    const entry = readEbmlElement(payload, offset, end)
    if (entry.unknownSize) return invalid()
    if (entry.id === 0xae) {
      let codec: string | undefined
      let type: number | undefined
      for (let cursor = entry.start; cursor < entry.end; ) {
        const field = readEbmlElement(payload, cursor, entry.end)
        if (field.unknownSize) return invalid()
        if (field.id === 0x86) {
          if (codec !== undefined) return invalid()
          codec = field.end - field.start === 6 ? payload.toString('utf8', field.start, field.end) : ''
        } else if (field.id === 0x83) {
          const size = field.end - field.start
          if (type !== undefined || size < 1 || size > 8) return invalid()
          type = 0
          for (let index = field.start; index < field.end; index++) type = type * 256 + payload[index]!
          if (!Number.isSafeInteger(type)) return invalid()
        }
        cursor = field.end
      }
      opus ||= type === 2 && codec === 'A_OPUS'
      audio ||= type === 2
      video ||= type === 1
    }
    offset = entry.end
  }
  return { opus, audio, video }
}

// FFmpeg silently turns a NaN Matroska Duration into an omitted duration.
// Inspect actual pre-Cluster Info/Tracks framing, not ffprobe's inferred
// duration. Tracks also identifies packet-framed Opus before metadata probing,
// where FFmpeg 8.0 can otherwise mistake its empty parser EOF flush for damage.
const matroskaHeader = (payload: Buffer, limit: number): { durationSeconds: number; opus: boolean; audio: boolean; video: boolean } => {
  for (let offset = 0; offset < payload.length; ) {
    const root = readEbmlElement(payload, offset, payload.length)
    if (root.id !== 0x18538067) {
      if (root.unknownSize) return invalid()
      offset = root.end
      continue
    }
    let seconds = 0
    let opus = false
    let audio = false
    let video = false
    for (let cursor = root.start; cursor < root.end; ) {
      const element = readEbmlElement(payload, cursor, root.end)
      if (element.id === 0x1f43b675) return { durationSeconds: seconds, opus, audio, video }
      if (element.unknownSize) return invalid()
      if (element.id === 0x1654ae6b) {
        const tracks = matroskaTracks(payload, element.start, element.end)
        opus ||= tracks.opus
        audio ||= tracks.audio
        video ||= tracks.video
      }
      if (element.id === 0x1549a966) {
        let scale = 1_000_000
        let ticks: number | undefined
        for (let child = element.start; child < element.end; ) {
          const field = readEbmlElement(payload, child, element.end)
          if (field.unknownSize) return invalid()
          const size = field.end - field.start
          if (field.id === 0x4489) {
            if (ticks !== undefined || (size !== 4 && size !== 8)) return invalid()
            ticks = size === 4 ? payload.readFloatBE(field.start) : payload.readDoubleBE(field.start)
            if (!Number.isFinite(ticks) || ticks <= 0) return invalid()
          } else if (field.id === 0x2ad7b1) {
            if (size < 1 || size > 8) return invalid()
            scale = 0
            for (let index = field.start; index < field.end; index++) scale = scale * 256 + payload[index]!
            if (!Number.isSafeInteger(scale) || scale <= 0) return invalid()
          }
          child = field.end
        }
        const declared = ticks === undefined ? 0 : (ticks * scale) / 1_000_000_000
        if (!Number.isFinite(declared) || declared > limit) return invalid()
        seconds = Math.max(seconds, declared)
      }
      cursor = element.end
    }
    return { durationSeconds: seconds, opus, audio, video }
  }
  return invalid()
}

/** Resolve ambiguous Wiki container extensions from bounded native track metadata.
 * This is not media validation: the existing full decoder still validates all stored bytes.
 */
export const agentMediaContainerMimeType = (payload: Buffer, container: 'mp4' | 'webm'): string => {
  if (payload.length < 1 || payload.length > AGENT_ATTACHMENT_MAX_BYTES) return invalid()
  let audio = false
  let video = false
  if (container === 'webm') {
    const tracks = matroskaHeader(payload, Infinity)
    audio = tracks.audio
    video = tracks.video
  } else {
    const path = [0x6d6f6f76, 0x7472616b, 0x6d646961, 0x68646c72] as const // moov/trak/mdia/hdlr
    const visit = (start: number, end: number, level: number): void => {
      for (let offset = start; offset < end; ) {
        const box = readMovBox(payload, offset, end, level === 0)
        if (box.type === path[level]) {
          if (level < path.length - 1) visit(box.start, box.end, level + 1)
          else {
            if (box.end - box.start < 12) return invalid()
            const handler = payload.readUInt32BE(box.start + 8)
            audio ||= handler === 0x736f756e // soun
            video ||= handler === 0x76696465 // vide
          }
        }
        offset = box.end
      }
    }
    visit(0, payload.length, 0)
  }
  if (!audio && !video) return invalid()
  return `${video ? 'video' : 'audio'}/${container}`
}

const MPEG1_BITRATES = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
] as const
const MPEG_LOW_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] as const
const MPEG_LOW_LAYER1_BITRATES = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256] as const
const MPEG_SAMPLE_RATES = [44100, 48000, 32000] as const

// FFmpeg's MP3 demuxer may discard an incomplete last frame without reporting an
// error. Walk declared frame lengths, not decoded duration or fixture-specific sizes.
const validateMp3Frames = (payload: Buffer): void => {
  let start = 0
  let end = payload.length
  while (payload.toString('ascii', start, start + 3) === 'ID3') {
    if (start + 10 > end) return invalid()
    const version = payload[start + 3]!
    if (version < 2 || version > 4 || payload[start + 4] === 255) return invalid()
    let size = 0
    for (let index = start + 6; index < start + 10; index++) {
      if (payload[index]! & 128) return invalid()
      size = size * 128 + payload[index]!
    }
    const footer = version === 4 && (payload[start + 5]! & 16) !== 0 ? 10 : 0
    const next = start + 10 + size + footer
    if (next > end || (footer && payload.toString('ascii', next - 10, next - 7) !== '3DI')) return invalid()
    start = next
  }
  // ID3v1 and APEv2 are optional metadata, not MPEG frames.
  if (end - start >= 128 && payload.toString('ascii', end - 128, end - 125) === 'TAG') end -= 128
  if (end - start >= 32 && payload.toString('ascii', end - 32, end - 24) === 'APETAGEX') {
    const size = payload.readUInt32LE(end - 20)
    const flags = payload.readUInt32LE(end - 12)
    if (size < 32 || size > end - start) return invalid()
    end -= size
    if (flags & 0x80000000) {
      if (end - start < 32 || payload.toString('ascii', end - 32, end - 24) !== 'APETAGEX') return invalid()
      end -= 32
    }
  }
  let frames = 0
  while (start < end) {
    if (end - start < 4) return invalid()
    const header = payload.readUInt32BE(start)
    const version = (header >>> 19) & 3
    const layer = (header >>> 17) & 3
    const bitrateIndex = (header >>> 12) & 15
    const rateIndex = (header >>> 10) & 3
    if (header >>> 21 !== 0x7ff || version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return invalid()
    const bitrate =
      (version === 3 ? MPEG1_BITRATES[3 - layer]![bitrateIndex]! : layer === 3 ? MPEG_LOW_LAYER1_BITRATES[bitrateIndex]! : MPEG_LOW_BITRATES[bitrateIndex]!) *
      1000
    const rate = MPEG_SAMPLE_RATES[rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const padding = (header >>> 9) & 1
    const size =
      layer === 3 ? (Math.floor((12 * bitrate) / rate) + padding) * 4 : Math.floor(((layer === 1 && version !== 3 ? 72 : 144) * bitrate) / rate) + padding
    if (size < 4 || size > end - start) return invalid()
    start += size
    frames++
  }
  if (frames === 0) return invalid()
}

const validateAdtsFrames = (payload: Buffer): void => {
  let offset = 0
  while (offset < payload.length) {
    if (payload.length - offset < 7 || payload[offset] !== 255 || (payload[offset + 1]! & 246) !== 240) return invalid()
    const headerSize = payload[offset + 1]! & 1 ? 7 : 9
    const frameSize = ((payload[offset + 3]! & 3) << 11) | (payload[offset + 4]! << 3) | (payload[offset + 5]! >>> 5)
    if (frameSize < headerSize || frameSize > payload.length - offset) return invalid()
    offset += frameSize
  }
}
let activeDecoders = 0
const collect = async (stream: ReadableStream<Uint8Array>, limit: number, overflow: () => void, onLine?: (line: string) => boolean): Promise<string> => {
  const chunks: Buffer[] = []
  let size = 0
  let pending = ''
  for await (const chunk of stream) {
    if (onLine) {
      pending += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line.length > 512) {
          overflow()
          continue
        }
        if (!onLine(line)) continue
        if (size + line.length + 1 > limit) {
          overflow()
          continue
        }
        chunks.push(Buffer.from(`${line}\n`))
        size += line.length + 1
      }
      if (pending.length > 512) {
        overflow()
        pending = ''
      }
      continue
    }
    if (size + chunk.byteLength > limit) {
      overflow()
      continue
    }
    chunks.push(Buffer.from(chunk))
    size += chunk.byteLength
  }
  if (pending) overflow()
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Decode the entire private file, never URLs, playlists, MOV references or external resources. */
export const decodeAgentAudioVideo = async (
  payload: Buffer,
  mimeType: string,
  signal: AbortSignal = AbortSignal.timeout(45_000)
): Promise<{ durationSeconds: number }> => {
  mimeType = normalizeAgentMediaMimeType(mimeType)
  const demuxer = DEMUXERS[mimeType]
  if (!demuxer || payload.length === 0 || payload.length > (mimeType.startsWith('video/') ? AGENT_GENERATED_VIDEO_MAX_BYTES : AGENT_GENERATED_AUDIO_MAX_BYTES))
    return invalid()
  signal.throwIfAborted()
  if (
    mimeType === 'audio/wav' &&
    (payload.length < 12 ||
      payload.toString('ascii', 0, 4) !== 'RIFF' ||
      payload.toString('ascii', 8, 12) !== 'WAVE' ||
      payload.readUInt32LE(4) + 8 !== payload.length)
  )
    return invalid()
  if (mimeType === 'audio/mpeg') validateMp3Frames(payload)
  if (mimeType === 'audio/aac') validateAdtsFrames(payload)
  const video = mimeType.startsWith('video/')
  const durationLimit = video ? 300 : 1_800
  if (activeDecoders >= 2) throw new AgentRepositoryError('AGENT_MEDIA_BUSY', 'Media validation is busy. Try again shortly.', 503)
  activeDecoders++
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'wiki-agent-media-'))
    await chmod(directory, 0o700)
  } catch (error) {
    activeDecoders--
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
  const path = join(directory, 'input')
  const deadline = Date.now() + 45_000
  let cpuUsed = 0
  const run = async (command: string, args: readonly string[], stdoutLimit: number, onLine?: (line: string) => boolean): Promise<string> => {
    signal.throwIfAborted()
    const remaining = Math.floor((30_000_000 - cpuUsed) / 1_000_000)
    const timeLeft = deadline - Date.now()
    if (remaining < 1 || timeLeft <= 0) return invalid()
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      child = Bun.spawn(['bash', '--noprofile', '--norc', '-c', LAUNCH, '--', String(remaining), command, ...args], {
        cwd: directory,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      })
    } catch {
      return invalid()
    }
    let failed = false
    const kill = () => {
      failed = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(kill, timeLeft)
    timer.unref()
    signal.addEventListener('abort', kill, { once: true })
    if (signal.aborted) kill()
    try {
      const [stdout, stderr, code] = await Promise.all([collect(child.stdout, stdoutLimit, kill, onLine), collect(child.stderr, 8_192, kill), child.exited])
      signal.throwIfAborted()
      const cpu = Number(child.resourceUsage()?.cpuTime.total)
      if (failed || code !== 0 || child.signalCode !== null || stderr.trim() || !Number.isSafeInteger(cpu) || cpu < 0) return invalid()
      cpuUsed += cpu
      if (cpuUsed > 30_000_000 || Date.now() > deadline) return invalid()
      return stdout
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', kill)
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited.catch(() => undefined)
    }
  }
  try {
    await writeFile(path, payload, { flag: 'wx', mode: 0o600, signal })
    if (demuxer === 'mov') validateMovBoxes(payload)
    const matroska = demuxer === 'matroska' ? matroskaHeader(payload, durationLimit) : undefined
    const inputOptions = [
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      demuxer,
      '-f',
      demuxer,
      ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
      // COMPLETE_FRAMES Opus gets an empty EOF parser flush in both ffprobe
      // and ffmpeg (FFmpeg 8.0 libavcodec/opus/parser.c:opus_parse). A framed
      // audio A_OPUS TrackEntry permits bypassing only that redundant parser;
      // the probe must still validate stream metadata and libopus must decode
      // every packet. Strict stderr, demuxing and complete-EOF checks remain.
      ...(matroska?.opus ? ['-fflags', '+noparse+nofillin'] : []),
      '-i',
      path
    ]
    const raw = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-max_alloc',
        '67108864',
        ...inputOptions,
        '-show_entries',
        'format=format_name,duration:stream=codec_type,codec_name,width,height,sample_rate,channels,duration,avg_frame_rate,nb_frames:stream_disposition=attached_pic',
        '-of',
        'json'
      ],
      32_768
    )
    let probe: {
      format?: { duration?: string }
      streams?: {
        codec_type?: string
        codec_name?: string
        width?: number
        height?: number
        sample_rate?: string
        channels?: number
        duration?: string
        avg_frame_rate?: string
        nb_frames?: string
        disposition?: { attached_pic?: number }
      }[]
    }
    try {
      probe = JSON.parse(raw)
    } catch {
      return invalid()
    }
    const streams = probe.streams
    if (!Array.isArray(streams) || streams.length < 1 || streams.length > 2) return invalid()
    let duration = Math.max(declaredDurationSeconds(probe.format?.duration, durationLimit), matroska?.durationSeconds ?? 0)
    for (const stream of streams) duration = Math.max(duration, declaredDurationSeconds(stream.duration, durationLimit))
    let videoCount = 0
    let audioCount = 0
    let audioRate = 0
    let frameRate = 0
    for (const stream of streams) {
      if (!stream.codec_name || stream.disposition?.attached_pic) return invalid()
      if (stream.codec_type === 'video') {
        videoCount++
        const width = stream.width ?? 0
        const height = stream.height ?? 0
        const [numerator, denominator] = (stream.avg_frame_rate ?? '').split('/').map(Number)
        const fps = numerator! / denominator!
        if (
          !video ||
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width < 1 ||
          height < 1 ||
          width > 4096 ||
          height > 4096 ||
          width * height > 8_847_360 ||
          !Number.isFinite(fps) ||
          fps <= 0 ||
          fps > 120 ||
          duration * fps > 18_000 ||
          (stream.nb_frames !== undefined && (!Number.isSafeInteger(Number(stream.nb_frames)) || Number(stream.nb_frames) > 18_000))
        )
          return invalid()
        frameRate = fps
      } else if (stream.codec_type === 'audio') {
        audioCount++
        const rate = Number(stream.sample_rate)
        if (
          !Number.isSafeInteger(rate) ||
          rate < 8_000 ||
          rate > 192_000 ||
          !Number.isSafeInteger(stream.channels) ||
          stream.channels! < 1 ||
          stream.channels! > 8
        )
          return invalid()
        audioRate = rate
      } else return invalid()
    }
    if (videoCount > 1 || audioCount > 1 || (video ? videoCount !== 1 : audioCount !== 1)) return invalid()
    const opus = streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'opus')
    if (matroska?.opus && !opus) return invalid()
    let audioSamples = 0
    let videoFrames = 0
    let decodedSpan = 0
    // Public per-frame statistics measure real decoded samples/frames. Progress
    // alone omits the final packet's duration in FFmpeg 6.1 and can report the
    // shortest stream in newer FFmpeg. Retain timestamps as a longer-span bound.
    const inspectDecodedLine = (line: string): boolean => {
      if (line.startsWith('agent_audio=')) {
        const match = AUDIO_FRAME_STATS.exec(line)
        if (!match) return invalid()
        const samples = Number(match[1])
        const pts = Number(match[2])
        const numerator = Number(match[3])
        const denominator = Number(match[4])
        if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(pts) || numerator !== 1 || denominator !== audioRate || audioRate === 0)
          return invalid()
        audioSamples += samples
        decodedSpan = Math.max(decodedSpan, (pts + samples) / audioRate)
        if (!Number.isSafeInteger(audioSamples) || audioSamples / audioRate > durationLimit || decodedSpan > durationLimit) return invalid()
        return false
      }
      if (line.startsWith('agent_video=')) {
        const match = VIDEO_FRAME_STATS.exec(line)
        if (!match) return invalid()
        const pts = Number(match[1])
        const numerator = Number(match[2])
        const denominator = Number(match[3])
        if (
          !Number.isSafeInteger(pts) ||
          !Number.isSafeInteger(numerator) ||
          numerator < 1 ||
          !Number.isSafeInteger(denominator) ||
          denominator < 1 ||
          frameRate === 0
        )
          return invalid()
        videoFrames++
        decodedSpan = Math.max(decodedSpan, (pts * numerator) / denominator + 1 / frameRate, videoFrames / frameRate)
        if (videoFrames > 18_000 || decodedSpan > durationLimit || decodedSpan * frameRate > 18_000) return invalid()
        return false
      }
      return true
    }
    // No -t/-frames truncation: success requires decoding through EOF under the same CPU/deadline budget.
    const progress = await run(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-v',
        'error',
        '-xerror',
        '-max_alloc',
        '67108864',
        '-threads',
        '1',
        '-err_detect',
        'explode',
        ...(opus ? ['-c:a', 'libopus'] : []),
        ...inputOptions,
        '-map',
        '0',
        ...(audioCount ? ['-stats_enc_pre:a', 'pipe:1', '-stats_enc_pre_fmt:a', 'agent_audio={samp}:{pts}:{tb}'] : []),
        ...(videoCount ? ['-stats_enc_pre:v', 'pipe:1', '-stats_enc_pre_fmt:v', 'agent_video={pts}:{tb}'] : []),
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-filter_complex_threads',
        '1',
        '-progress',
        'pipe:1',
        '-nostats',
        '-f',
        'null',
        '-'
      ],
      65_536,
      inspectDecodedLine
    )
    if (!progress.includes('progress=end')) return invalid()
    const decodedFrames = [...progress.matchAll(/^frame=(\d+)$/gmu)].map(match => Number(match[1]))
    const decodedTimes = [...progress.matchAll(/^out_time_us=(\d+)$/gmu)].map(match => Number(match[1]) / 1_000_000)
    duration = Math.max(duration, decodedSpan, audioCount ? audioSamples / audioRate : 0, ...decodedTimes)
    if (
      decodedTimes.length === 0 ||
      decodedTimes.at(-1)! <= 0 ||
      duration <= 0 ||
      duration > durationLimit ||
      (audioCount > 0 && audioSamples === 0) ||
      (video && (videoFrames === 0 || duration * frameRate > 18_000)) ||
      (video && (decodedFrames.length === 0 || decodedFrames.at(-1)! < 1)) ||
      decodedFrames.some(frames => frames > 18_000) ||
      decodedTimes.some(seconds => seconds > durationLimit)
    )
      return invalid()
    return { durationSeconds: duration }
  } finally {
    activeDecoders--
    await rm(directory, { recursive: true, force: true })
  }
}
