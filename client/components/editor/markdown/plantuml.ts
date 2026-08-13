import type { MarkdownIt, StateBlock, Token } from 'markdown-it'
import { deflate } from 'pako'

interface PlantUmlOptions {
  openMarker?: string
  closeMarker?: string
  imageFormat?: string
  server?: string
}

const defaults: Required<PlantUmlOptions> = {
  openMarker: '```plantuml',
  closeMarker: '```',
  imageFormat: 'svg',
  server: 'https://plantuml.requarks.io'
}

function plantUmlPlugin (md: MarkdownIt, options: PlantUmlOptions = {}): void {
  const config = { ...defaults, ...options }
  const openChar = config.openMarker.charCodeAt(0)
  const closeChar = config.closeMarker.charCodeAt(0)

  md.block.ruler.before('fence', 'uml_diagram', (
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean
  ): boolean => {
    let start = state.bMarks[startLine] + state.tShift[startLine]
    let max = state.eMarks[startLine]

    if (openChar !== state.src.charCodeAt(start)) return false
    for (let index = 0; index < config.openMarker.length; index++) {
      if (config.openMarker[index] !== state.src[start + index]) return false
    }

    const markup = state.src.slice(start, start + config.openMarker.length)
    const params = state.src.slice(start + config.openMarker.length, max)
    if (silent) return true

    let nextLine = startLine
    let autoClosed = false
    for (;;) {
      nextLine++
      if (nextLine >= endLine) break

      start = state.bMarks[nextLine] + state.tShift[nextLine]
      max = state.eMarks[nextLine]
      if (start < max && state.sCount[nextLine] < state.blkIndent) break
      if (closeChar !== state.src.charCodeAt(start)) continue
      if (state.sCount[nextLine] > state.sCount[startLine]) continue

      let closeMarkerMatched = true
      for (let index = 0; index < config.closeMarker.length; index++) {
        if (config.closeMarker[index] !== state.src[start + index]) {
          closeMarkerMatched = false
          break
        }
      }
      if (!closeMarkerMatched || state.skipSpaces(start + config.closeMarker.length) < max) continue

      autoClosed = true
      break
    }

    const contents = state.src.split('\n').slice(startLine + 1, nextLine).join('\n')
    const altTokens: Token[] = []
    state.md.inline.parse(params ? params.slice(1) : 'uml diagram', state.md, state.env, altTokens)

    const encodedDiagram = encode64(deflate(`@startuml\n${contents}\n@enduml`))
    const token = state.push('uml_diagram', 'img', 0)
    token.attrs = [
      ['src', `${config.server}/${config.imageFormat}/${encodedDiagram}`],
      ['alt', ''],
      ['class', 'uml-diagram']
    ]
    token.block = true
    token.children = altTokens
    token.info = params
    token.map = [startLine, nextLine]
    token.markup = markup
    state.line = nextLine + (autoClosed ? 1 : 0)
    return true
  }, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })

  md.renderer.rules.uml_diagram = md.renderer.rules.image
}

function encode64 (data: Uint8Array): string {
  let result = ''
  for (let index = 0; index < data.length; index += 3) {
    result += append3bytes(
      data[index],
      index + 1 < data.length ? data[index + 1] : 0,
      index + 2 < data.length ? data[index + 2] : 0
    )
  }
  return result
}

function append3bytes (byte1: number, byte2: number, byte3: number): string {
  return [
    byte1 >> 2,
    ((byte1 & 0x3) << 4) | (byte2 >> 4),
    ((byte2 & 0xf) << 2) | (byte3 >> 6),
    byte3 & 0x3f
  ].map(value => encode6bit(value & 0x3f)).join('')
}

function encode6bit (raw: number): string {
  if (raw < 10) return String.fromCharCode(48 + raw)
  const upper = raw - 10
  if (upper < 26) return String.fromCharCode(65 + upper)
  const lower = upper - 26
  if (lower < 26) return String.fromCharCode(97 + lower)
  if (lower === 26) return '-'
  if (lower === 27) return '_'
  return '?'
}

export default {
  init (markdown: MarkdownIt, options: PlantUmlOptions): void {
    markdown.use(plantUmlPlugin, options)
  }
}
