import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import Prism from './setup.ts'

const requestedComponents: string[] = []

beforeEach(() => {
  resetBody()
  requestedComponents.length = 0
  const appendChild = document.body.appendChild.bind(document.body)
  // Replace only the browser's script transport: run the installed component, including its real grammar and dependencies.
  vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const appended = appendChild(node)
    if (node instanceof browserWindow.HTMLScriptElement) {
      const pathname = new URL(node.src).pathname
      requestedComponents.push(pathname)
      const component = path.resolve(import.meta.dir, '../../../node_modules/prismjs/components', path.basename(pathname))
      if (pathname.startsWith('/_assets/js/prism/') && fs.existsSync(component)) {
        new Function('Prism', fs.readFileSync(component, 'utf8'))(Prism)
        node.dispatchEvent(new browserWindow.Event('load'))
      } else {
        node.dispatchEvent(new browserWindow.Event('error'))
      }
    }
    return appended
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetBody()
})

const codeBlock = (language: string, source: string): HTMLElement => {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.className = `language-${language}`
  code.textContent = source
  pre.appendChild(code)
  document.body.appendChild(pre)
  return code
}

describe('Prism language loading', () => {
  it.each(['test', 'unknown-fence'])('renders an unsupported %s fence as readable code without a component request', language => {
    const source = 'if (a < b) return "<literal>&";'
    const code = codeBlock(language, source)

    Prism.highlightElement(code)
    Prism.highlightElement(code)

    expect(code.textContent).toBe(source)
    expect(code.querySelector('.token')).toBeNull()
    expect(code.querySelector('literal')).toBeNull()
    expect(requestedComponents).toEqual([])
  })

  it('continues highlighting bundled JavaScript without a component request', () => {
    const code = codeBlock('javascript', 'const answer = 42;')

    Prism.highlightElement(code)

    expect(code.querySelector('.token.keyword')?.textContent).toBe('const')
    expect(requestedComponents).toEqual([])
  })

  it('loads a supported alias using its canonical component and rehighlights the code', async () => {
    const code = codeBlock('py', 'print("hello")')

    Prism.highlightElement(code)

    await vi.waitFor(() => expect(code.querySelector('.token.string')?.textContent).toBe('"hello"'))
    expect(requestedComponents).toEqual(['/_assets/js/prism/prism-python.min.js'])
  })

  it('loads the dependencies of a supported lazy grammar before highlighting it', async () => {
    const source = 'const element = <section>{42}</section>;'
    const code = codeBlock('tsx', source)

    Prism.highlightElement(code)

    await vi.waitFor(() => expect(code.querySelector('.token.tag')?.textContent).toBe('<section>'))
    expect(code.querySelector('.token.keyword')?.textContent).toBe('const')
    expect(code.textContent).toBe(source)
    expect(requestedComponents).toContain('/_assets/js/prism/prism-jsx.min.js')
    expect(requestedComponents).toContain('/_assets/js/prism/prism-typescript.min.js')
    expect(requestedComponents).toContain('/_assets/js/prism/prism-tsx.min.js')
  })
})
