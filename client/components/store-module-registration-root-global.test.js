import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { browserWindow } from '../test/browser-dom.mts'
import { afterAll, describe, expect, test } from '../../server/test/bun-test.mts'

const originalSiteConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
Object.defineProperty(browserWindow, 'siteConfig', {
  configurable: true,
  value: {
    company: '', contentLicense: '', footerOverride: '', banner: {},
    darkMode: false, tocPosition: 'left', title: 'Test', logoUrl: '',
    product: { name: 'Test', version: '1.0.0' }
  }
})
afterAll(() => {
  if (originalSiteConfig) Object.defineProperty(browserWindow, 'siteConfig', originalSiteConfig)
  else Reflect.deleteProperty(browserWindow, 'siteConfig')
})
const storeModule = await import('../store/index.ts')

const readScript = relativePath => {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const script = parse(source).descriptor.script
  if (!script) throw new Error(`${relativePath} has no component script`)
  return ts.createSourceFile(relativePath, script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
const memberName = node => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text
  if (ts.isIdentifier(node)) return node.text
}
const legacyAccesses = script => {
  const violations = []
  const visit = node => {
    if (ts.isCallExpression(node) && memberName(node.expression) === 'registerModule') violations.push('registerModule')
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      memberName(node) === '$store' && ts.isIdentifier(node.expression) && node.expression.text === 'WIKI') {
      violations.push('WIKI.$store')
    }
    ts.forEachChild(node, visit)
  }
  visit(script)
  return violations
}
const property = (object, name) => {
  const member = object.properties.find(candidate => candidate.name?.getText(object.getSourceFile()) === name)
  if (!member) throw new Error(`Missing component member: ${name}`)
  return member
}
const options = script => {
  const exported = script.statements.find(ts.isExportAssignment)?.expression
  const object = ts.isCallExpression(exported) ? exported.arguments[0] : exported
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('Component options were not found')
  return object
}
// Evaluate complete state-owning members with the real Pinia singleton, resolving
// import aliases from the AST. Unrelated lifecycle work remains at its boundary.
const evaluateMembers = (script, members) => {
  const imports = []
  for (const statement of script.statements) {
    if (!ts.isImportDeclaration(statement) || !/\/store\/index\.ts$/.test(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) imports.push([binding.name.text, storeModule[binding.propertyName?.text ?? binding.name.text]])
    }
  }
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `const members = { ${members.map(member => member.getText(script)).join(',\n')} };`
  )
  return new Function(...imports.map(([name]) => name), `${executable}\nreturn members`)(...imports.map(([, value]) => value))
}

describe('store singleton migration contracts', () => {
  const cases = [
    { label: 'admin shell', path: 'client/components/admin.vue' },
    { label: 'editor shell', path: 'client/components/editor.vue' },
    { label: 'admin security editor settings', path: 'client/components/admin/admin-security.vue' }
  ]

  test.each(cases)('$label does not execute legacy registration or root-global store access', ({ path: relativePath }) => {
    expect(legacyAccesses(readScript(relativePath))).toEqual([])
  })

  test('admin mode, editor selection and the security picker share the application store', () => {
    const { wikiStore } = storeModule
    const original = {
      pageMode: wikiStore.page.mode,
      editor: wikiStore.editor.editor,
      activeModal: wikiStore.editor.activeModal,
      editorKey: wikiStore.editor.editorKey
    }
    const adminScript = readScript('client/components/admin.vue')
    const editorScript = readScript('client/components/editor.vue')
    const securityScript = readScript('client/components/admin/admin-security.vue')
    const admin = evaluateMembers(adminScript, [property(options(adminScript), 'created')])
    const editorComputed = property(options(editorScript), 'computed').initializer
    const editor = evaluateMembers(editorScript, [property(editorComputed, 'currentEditor'), property(editorComputed, 'activeModal')])
    const securityMethods = property(options(securityScript), 'methods').initializer
    const security = evaluateMembers(securityScript, [property(securityMethods, 'browseBackground')])
    try {
      wikiStore.page.mode = 'view'
      admin.created.call({ loadInfo() {}, syncOpenedSection() {} })
      expect(wikiStore.page.mode).toBe('admin')

      wikiStore.editor.editor = 'markdown'
      expect(editor.currentEditor.get()).toBe('markdown')
      editor.currentEditor.set('code')
      expect(wikiStore.editor.editor).toBe('code')
      wikiStore.editor.editor = 'markdown'
      expect(editor.currentEditor.get()).toBe('markdown')

      editor.activeModal.set('')
      const picker = { locked: false, selectingBackground: false }
      security.browseBackground.call(picker)
      expect(picker.selectingBackground).toBe(true)
      expect(wikiStore.editor.editorKey).toBe('common')
      expect(wikiStore.editor.activeModal).toBe('editorModalMedia')
      expect(editor.activeModal.get()).toBe('editorModalMedia')
    } finally {
      wikiStore.page.mode = original.pageMode
      wikiStore.editor.editor = original.editor
      wikiStore.editor.activeModal = original.activeModal
      wikiStore.editor.editorKey = original.editorKey
    }
  })
})
