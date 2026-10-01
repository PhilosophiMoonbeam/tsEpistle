import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

import { SEARCH_ENTER_EVENT,
SEARCH_MOVE_EVENT,
emitSearchEnter,
emitSearchMove,
onSearchEnter,
onSearchMove,
offSearchEnter,
offSearchMove } from './search-navigation-events.ts'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const helperPath = path.join(repoRoot, 'client/helpers/search-navigation-events.ts')
const guardedFiles = [
  'client/components/common/nav-header.vue',
  'client/components/common/search-results.vue'
]

function getLineNumber (content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function directRootEventPattern (eventName) {
  return new RegExp(
    '\\bthis\\s*\\.\\s*\\$root\\s*\\.\\s*\\$(?:emit|on|off)\\s*\\(\\s*([\'"`])' + eventName + '\\1',
    'g'
  )
}

describe('search navigation events', () => {
  test('emitSearchEnter emits the shared search enter event with the legacy payload', () => {
    const handler = vi.fn()
    onSearchEnter(handler)

    emitSearchEnter()

    expect(handler).toHaveBeenCalledWith(true)
    offSearchEnter(handler)
  })

  test('emitSearchMove emits the shared search move event with the direction', () => {
    const handler = vi.fn()
    onSearchMove(handler)

    emitSearchMove('down')

    expect(handler).toHaveBeenCalledWith('down')
    offSearchMove(handler)
  })

  test('offSearchEnter unsubscribes from the shared search enter event with the same handler', () => {
    const handler = vi.fn()
    onSearchEnter(handler)
    offSearchEnter(handler)

    emitSearchEnter()

    expect(handler).not.toHaveBeenCalled()
  })

  test('offSearchMove unsubscribes from the shared search move event with the same handler', () => {
    const handler = vi.fn()
    onSearchMove(handler)
    offSearchMove(handler)

    emitSearchMove('up')

    expect(handler).not.toHaveBeenCalled()
  })

  test('offSearchEnter does not broadly unsubscribe without a handler', () => {
    const handler = vi.fn()
    onSearchEnter(handler)
    offSearchEnter()

    emitSearchEnter()

    expect(handler).toHaveBeenCalledWith(true)
    offSearchEnter(handler)
  })

  test('offSearchMove does not broadly unsubscribe without a handler', () => {
    const handler = vi.fn()
    onSearchMove(handler)
    offSearchMove()

    emitSearchMove('down')

    expect(handler).toHaveBeenCalledWith('down')
    offSearchMove(handler)
  })
})

describe('search navigation event usage', () => {
  test('common search components use the helper instead of direct root bus search events', () => {
    const offenders = []

    for (const relPath of guardedFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')

      for (const eventName of [SEARCH_ENTER_EVENT, SEARCH_MOVE_EVENT]) {
        const pattern = directRootEventPattern(eventName)
        let match

        while ((match = pattern.exec(content)) !== null) {
          offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root event for ${eventName}`)
        }
      }

      expect(content).not.toMatch(/emitSearch(?:Enter|Move)\s*\(\s*this\.\$root/)
      expect(content).not.toMatch(/onSearch(?:Enter|Move)\s*\(\s*this\.\$root/)
      expect(content).not.toMatch(/offSearch(?:Enter|Move)\s*\(\s*this\.\$root/)
    }

    expect(offenders).toEqual([])
  })

  test('search navigation helper owns its bus instead of requiring caller root instances', () => {
    const source = fs.readFileSync(helperPath, 'utf8')

    const sourceFile = ts.createSourceFile(helperPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const vueDependencies = []
    const visit = node => {
      let moduleSpecifier
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const onlyNamedTypes = !clause?.name && bindings && ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly)
        if (!clause?.isTypeOnly && !onlyNamedTypes) moduleSpecifier = node.moduleSpecifier
      } else if (ts.isExportDeclaration(node)) {
        const clause = node.exportClause
        const onlyNamedTypes = clause && ts.isNamedExports(clause) &&
          clause.elements.length > 0 && clause.elements.every(binding => binding.isTypeOnly)
        if (!node.isTypeOnly && !onlyNamedTypes) moduleSpecifier = node.moduleSpecifier
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
          moduleSpecifier = node.moduleReference.expression
        }
      } else if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        moduleSpecifier = node.arguments[0]
      }
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier) && moduleSpecifier.text === 'vue') {
        vueDependencies.push(getLineNumber(source, node.getStart(sourceFile)))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    expect(vueDependencies).toEqual([])
    expect(source).not.toMatch(/new\s+Vue\s*\(/)
    expect(source).not.toMatch(/\.\$(?:emit|on|off)\s*\(/)
  })
})
