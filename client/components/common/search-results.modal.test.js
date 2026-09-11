import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { JSDOM } from 'jsdom'

const compileSearchMethods = (source, names) => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Search component script was not found.')

  const sourceFile = ts.createSourceFile('search-results.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let methods
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'methods' && ts.isObjectLiteralExpression(node.initializer)) {
      methods = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!methods) throw new Error('Search component methods were not found.')

  const selected = new Set(names)
  const declarations = methods.properties.filter(node => ts.isMethodDeclaration(node) && selected.has(node.name.getText(sourceFile)))
  if (declarations.length !== selected.size) throw new Error('A requested search method was not found.')

  const compiled = ts.transpileModule(`const methods = ({${declarations.map(node => node.getText(sourceFile)).join(',')}})`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None
    }
  }).outputText
  return new Function(`${compiled}\nreturn methods`)()
}

describe('Ask modal accessibility contract', () => {
  const search = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
  test('restores focus to the remounted zero-result Ask action instead of the global trigger', () => {
    const methods = compileSearchMethods(search, ['restoreTargetFor'])
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const fixtureDocument = dom.window.document
    const focusKey = 'test-ask-focus'
    const opener = fixtureDocument.createElement('button')
    const replacement = fixtureDocument.createElement('button')
    const globalFallback = fixtureDocument.createElement('button')

    opener.dataset.modalFocusKey = focusKey
    replacement.dataset.modalFocusKey = focusKey
    fixtureDocument.body.append(opener, replacement, globalFallback)
    opener.remove()

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: fixtureDocument
    })

    try {
      const resolveTarget = methods.restoreTargetFor.call(
        {
          findSearchTrigger: () => globalFallback
        },
        opener
      )

      expect(opener.isConnected).toBe(false)
      expect(replacement.isConnected).toBe(true)
      expect(resolveTarget()).toBe(replacement)
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
      else delete globalThis.document
      dom.window.close()
    }
  })
})
