import fs from 'node:fs'
import path from 'node:path'

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${name}\\s*\\(`))

  if (methodStart === -1) return null

  const paramsStart = script.indexOf('(', methodStart)
  let paramsDepth = 0
  let bodyStart = -1

  for (let idx = paramsStart; idx < script.length; idx++) {
    if (script[idx] === '(') {
      paramsDepth++
    } else if (script[idx] === ')') {
      paramsDepth--
      if (paramsDepth === 0) {
        bodyStart = script.indexOf('{', idx)
        break
      }
    }
  }

  if (bodyStart === -1) return null

  let bodyDepth = 0
  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      bodyDepth++
    } else if (script[idx] === '}') {
      bodyDepth--
      if (bodyDepth === 0) return script.slice(methodStart, idx + 1)
    }
  }

  return null
}

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/common/page-convert.vue'), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]
const convertPageMethod = extractMethod(script, 'convertPage')
const beforeUnmount = extractMethod(script, 'beforeUnmount')

describe('page-convert root UI facade contract', () => {
  test('keeps editor choices static and non-reactive while using the typed REST facade', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toMatch(/import\s*\{(?=[^}]*\bdefineComponent\b)(?=[^}]*\bmarkRaw\b)[^}]*\}\s*from\s*['"]vue['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { convertPage } from '../../helpers/pages-api'")
    expect(script).toMatch(/const\s+editorOptions\s*=\s*markRaw\s*\(\s*\[[\s\S]*?\]\s*\)/)
    expect(script).toMatch(/data\s*\(\s*\)\s*\{[\s\S]*?\beditorOptions\s*,/)
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('guards reentry and sends the current page conversion payload with an abortable fetch', () => {
    expect(convertPageMethod).not.toBeNull()
    expect(convertPageMethod).toMatch(/if\s*\(\s*!this\.canConvert\s*\|\|\s*this\.loading\s*\)\s*return/)
    expect(convertPageMethod).toMatch(
      /const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.convertAbortController\s*=\s*controller[\s\S]*?this\.loading\s*=\s*true[\s\S]*?wikiStore\.startLoading\s*\(\s*['"]page-convert['"]\s*\)/
    )
    expect(convertPageMethod).toMatch(
      /await\s+convertPage\s*\(\s*\(\s*url\s*,\s*init\s*\)\s*=>\s*window\.fetch\s*\(\s*url\s*,\s*\{\s*\.\.\.init\s*,\s*signal:\s*controller\.signal\s*\}\s*\)\s*,\s*this\.pageId\s*,\s*this\.newEditor\s*,\s*this\.pageSourceRevision\s*\)/
    )
  })

  test('only the current live request owns errors, completion state, dialog close, and redirect', () => {
    expect(convertPageMethod).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\|\|\s*this\.convertAbortController\s*!==\s*controller\s*\)\s*return[\s\S]*?this\.isShown\s*=\s*false/
    )
    expect(convertPageMethod).toContain("const scope = this.pageVisibility === 'private' ? '/_private' : ''")
    expect(convertPageMethod).toMatch(/window\.location\.assign\s*\(\s*`\/e\$\{scope\}\/\$\{this\.pageLocale\}\/\$\{this\.pagePath\}`\s*\)/)
    expect(convertPageMethod).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*this\.convertAbortController\s*===\s*controller\s*&&\s*!controller\.signal\.aborted\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)/
    )
    expect(convertPageMethod).toMatch(
      /finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]page-convert['"]\s*\)[\s\S]*?if\s*\(\s*this\.convertAbortController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.convertAbortController\s*=\s*null[\s\S]*?this\.loading\s*=\s*false/
    )
    expect(convertPageMethod.match(/wikiStore\.startLoading\s*\(/g)).toHaveLength(1)
    expect(convertPageMethod.match(/wikiStore\.stopLoading\s*\(/g)).toHaveLength(1)
  })

  test('aborts conversion ownership when the dialog component unmounts', () => {
    expect(beforeUnmount).not.toBeNull()
    expect(beforeUnmount).toMatch(/this\.convertAbortController\?\.abort\s*\(\s*\)[\s\S]*?this\.convertAbortController\s*=\s*null/)
  })
})
