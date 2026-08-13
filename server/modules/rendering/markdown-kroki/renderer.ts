import zlib from 'node:zlib'
import type { MarkdownIt, StateBlock, Token } from 'markdown-it'

// ------------------------------------
// Markdown - Kroki Preprocessor
// ------------------------------------
interface KrokiOptions {
  openMarker?: string
  closeMarker?: string
  server?: string
}

const plugin = {
  init (mdinst: MarkdownIt, conf: KrokiOptions) {
    mdinst.use((md: MarkdownIt, opts: KrokiOptions = {}) => {
      const openMarker = opts.openMarker || '```kroki'
      const openChar = openMarker.charCodeAt(0)
      const closeMarker = opts.closeMarker || '```'
      const closeChar = closeMarker.charCodeAt(0)
      const server = opts.server || 'https://kroki.io'

      md.block.ruler.before('fence', 'kroki', (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
        let nextLine
        let i
        let autoClosed = false
        const openingMark = state.bMarks[startLine]
        const openingShift = state.tShift[startLine]
        const openingEnd = state.eMarks[startLine]
        const openingIndent = state.sCount[startLine]
        if (
          openingMark === undefined ||
          openingShift === undefined ||
          openingEnd === undefined ||
          openingIndent === undefined
        ) {
          return false
        }
        let start = openingMark + openingShift
        let max = openingEnd

        // Check out the first character quickly,
        // this should filter out most of non-uml blocks
        //
        if (openChar !== state.src.charCodeAt(start)) { return false }

        // Check out the rest of the marker string
        //
        for (i = 0; i < openMarker.length; ++i) {
          if (openMarker[i] !== state.src[start + i]) { return false }
        }

        const markup = state.src.slice(start, start + i)
        const params = state.src.slice(start + i, max)

        // Since start is found, we can report success here in validation mode
        //
        if (silent) { return true }

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
          if (
            lineMark === undefined ||
            lineShift === undefined ||
            lineEnd === undefined ||
            lineIndent === undefined
          ) {
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

        let contents = state.src
          .split('\n')
          .slice(startLine + 1, nextLine)
          .join('\n')

        // We generate a token list for the alt property, to mimic what the image parser does.
        const altTokens: Token[] = []
        // Remove leading space if any.
        const alt = params ? params.slice(1) : 'uml diagram'
        state.md.inline.parse(
          alt,
          state.md,
          state.env,
          altTokens
        )

        const firstLineFeed = contents.indexOf('\n')
        const diagramType = firstLineFeed === -1 ? '' : contents.substring(0, firstLineFeed)
        if (firstLineFeed !== -1) {
          contents = contents.substring(firstLineFeed + 1)
        }

        const result = zlib.deflateSync(contents).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')

        const token = state.push('kroki', 'img', 0)
        // alt is constructed from children. No point in populating it here.
        token.attrs = [ [ 'src', `${server}/${diagramType}/svg/${result}` ], [ 'alt', '' ], ['class', 'uml-diagram prefetch-candidate'] ]
        token.block = true
        token.children = altTokens
        token.info = params
        token.map = [ startLine, nextLine ]
        token.markup = markup

        state.line = nextLine + (autoClosed ? 1 : 0)

        return true
      }, {
        alt: [ 'paragraph', 'reference', 'blockquote', 'list' ]
      })
      const renderImage = md.renderer.rules.image
      if (!renderImage) {
        throw new Error('Markdown-It image renderer is unavailable')
      }
      md.renderer.rules.kroki = renderImage
    }, conf)
  }
}

export default plugin
