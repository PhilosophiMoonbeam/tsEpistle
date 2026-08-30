import zlib from 'node:zlib'
import type { MarkdownIt, StateBlock, Token } from 'markdown-it'
import { createDiagramPrefetchToken } from '../html-image-prefetch/trusted-diagram.ts'

// ------------------------------------
// Markdown - PlantUML Preprocessor
// ------------------------------------
interface PlantUmlOptions {
  openMarker?: string
  closeMarker?: string
  imageFormat?: string
  server?: string
}

const plugin = {
  init(mdinst: MarkdownIt, conf: PlantUmlOptions) {
    mdinst.use((md: MarkdownIt, opts: PlantUmlOptions = {}) => {
      const openMarker = opts.openMarker || '```plantuml'
      const openChar = openMarker.charCodeAt(0)
      const closeMarker = opts.closeMarker || '```'
      const closeChar = closeMarker.charCodeAt(0)
      const imageFormat = opts.imageFormat || 'svg'
      const server = opts.server || 'https://plantuml.requarks.io'

      md.block.ruler.before(
        'fence',
        'uml_diagram',
        (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
          let nextLine
          let i
          let autoClosed = false
          const openingMark = state.bMarks[startLine]
          const openingShift = state.tShift[startLine]
          const openingEnd = state.eMarks[startLine]
          const openingIndent = state.sCount[startLine]
          if (openingMark === undefined || openingShift === undefined || openingEnd === undefined || openingIndent === undefined) {
            return false
          }
          let start = openingMark + openingShift
          let max = openingEnd

          // Check out the first character quickly,
          // this should filter out most of non-uml blocks
          //
          if (openChar !== state.src.charCodeAt(start)) {
            return false
          }

          // Check out the rest of the marker string
          //
          for (i = 0; i < openMarker.length; ++i) {
            if (openMarker[i] !== state.src[start + i]) {
              return false
            }
          }

          const markup = state.src.slice(start, start + i)
          const params = state.src.slice(start + i, max)

          // Since start is found, we can report success here in validation mode
          //
          if (silent) {
            return true
          }

          // Search for the end of the block
          //
          nextLine = startLine

          for (;;) {
            nextLine++
            if (nextLine >= endLine) {
              // unclosed block should be autoclosed by end of document.
              // also block seems to be autoclosed by end of parent
              break
            }

            const lineMark = state.bMarks[nextLine]
            const lineShift = state.tShift[nextLine]
            const lineEnd = state.eMarks[nextLine]
            const lineIndent = state.sCount[nextLine]
            if (lineMark === undefined || lineShift === undefined || lineEnd === undefined || lineIndent === undefined) {
              break
            }
            start = lineMark + lineShift
            max = lineEnd

            if (start < max && lineIndent < state.blkIndent) {
              // non-empty line with negative indent should stop the list:
              // - ```
              //  test
              break
            }

            if (closeChar !== state.src.charCodeAt(start)) {
              // didn't find the closing fence
              continue
            }

            if (lineIndent > openingIndent) {
              // closing fence should not be indented with respect of opening fence
              continue
            }

            let closeMarkerMatched = true
            for (i = 0; i < closeMarker.length; ++i) {
              if (closeMarker[i] !== state.src[start + i]) {
                closeMarkerMatched = false
                break
              }
            }

            if (!closeMarkerMatched) {
              continue
            }

            // make sure tail has spaces only
            if (state.skipSpaces(start + i) < max) {
              continue
            }

            // found!
            autoClosed = true
            break
          }

          const contents = state.src
            .split('\n')
            .slice(startLine + 1, nextLine)
            .join('\n')

          // We generate a token list for the alt property, to mimic what the image parser does.
          const altTokens: Token[] = []
          // Remove leading space if any.
          const alt = params ? params.slice(1) : 'uml diagram'
          state.md.inline.parse(alt, state.md, state.env, altTokens)

          const zippedCode = encode64(zlib.deflateRawSync('@startuml\n' + contents + '\n@enduml').toString('binary'))

          const token = state.push('uml_diagram', 'img', 0)
          const imageUrl = `${server}/${imageFormat}/${zippedCode}`
          // alt is constructed from children. No point in populating it here.
          token.attrs = [
            ['src', imageUrl],
            ['alt', ''],
            ['class', 'uml-diagram'],
            ['data-diagram-prefetch', createDiagramPrefetchToken(imageUrl)]
          ]
          token.block = true
          token.children = altTokens
          token.info = params
          token.map = [startLine, nextLine]
          token.markup = markup

          state.line = nextLine + (autoClosed ? 1 : 0)

          return true
        },
        {
          alt: ['paragraph', 'reference', 'blockquote', 'list']
        }
      )
      const renderImage = md.renderer.rules.image
      if (!renderImage) {
        throw new Error('Markdown-It image renderer is unavailable')
      }
      md.renderer.rules.uml_diagram = renderImage
    }, conf)
  }
}

function encode64(data: string) {
  let r = ''
  for (let i = 0; i < data.length; i += 3) {
    if (i + 2 === data.length) {
      r += append3bytes(data.charCodeAt(i), data.charCodeAt(i + 1), 0)
    } else if (i + 1 === data.length) {
      r += append3bytes(data.charCodeAt(i), 0, 0)
    } else {
      r += append3bytes(data.charCodeAt(i), data.charCodeAt(i + 1), data.charCodeAt(i + 2))
    }
  }
  return r
}

function append3bytes(b1: number, b2: number, b3: number) {
  const c1 = b1 >> 2
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4)
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6)
  const c4 = b3 & 0x3f
  let r = ''
  r += encode6bit(c1 & 0x3f)
  r += encode6bit(c2 & 0x3f)
  r += encode6bit(c3 & 0x3f)
  r += encode6bit(c4 & 0x3f)
  return r
}

function encode6bit(raw: number) {
  let b = raw
  if (b < 10) {
    return String.fromCharCode(48 + b)
  }
  b -= 10
  if (b < 26) {
    return String.fromCharCode(65 + b)
  }
  b -= 26
  if (b < 26) {
    return String.fromCharCode(97 + b)
  }
  b -= 26
  if (b === 0) {
    return '-'
  }
  if (b === 1) {
    return '_'
  }
  return '?'
}

export default plugin
