import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/editor/editor-modal-drawio.vue')
const focusScopePath = join(process.cwd(), 'client/components/common/modal-focus-scope.ts')
const source = readFileSync(componentPath, 'utf8')
const focusScopeSource = readFileSync(focusScopePath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.script?.content ?? ''

describe('Draw.io editor modal contract', () => {
  test('activates and disposes the shared modal focus scope', () => {
    expect(errors).toEqual([])
    expect(template).toMatch(/v-card\.editor-modal-drawio[\s\S]*ref='modalRoot'[\s\S]*role='dialog'[\s\S]*aria-modal='true'/)
    expect(template).toMatch(/v-btn\([\s\S]*ref='closeButton'[\s\S]*aria-label='Back to editor'/)
    expect(script).toContain("import { createModalFocusScope, type ModalFocusScope } from '../common/modal-focus-scope'")
    expect(script).toMatch(
      /this\.returnFocus = document\.activeElement[\s\S]*this\.focusScope = createModalFocusScope\(\{[\s\S]*root,[\s\S]*restoreTarget: \(\) => this\.returnFocus,[\s\S]*onEscape: this\.close[\s\S]*this\.\$refs\.closeButton/
    )
    expect(script).toMatch(/beforeUnmount \(\) \{[\s\S]*this\.disposed = true[\s\S]*this\.focusScope\?\.deactivate\(\)[\s\S]*this\.focusScope = null/)
    expect(focusScopeSource).toMatch(/'iframe'/)
  })

  test('keeps Escape on the existing close path', () => {
    expect(script).toMatch(/onEscape: this\.close/)
    expect(script).toMatch(/close \(\) \{[\s\S]*this\.clearLoadTimer\(\)[\s\S]*wikiStore\.editor\.activeModal = ''/)
  })

  test('retains the fixed diagrams.net message boundary', () => {
    expect(template).toContain("src='https://embed.diagrams.net/?embed=1&proto=json&spin=1&saveAndExit=1&noSaveBtn=1&noExitBtn=0'")
    expect(script).toContain("const DRAWIO_ORIGIN = 'https://embed.diagrams.net'")
    expect(script).toMatch(/drawio\.contentWindow\.postMessage\(JSON\.stringify\(msg\), DRAWIO_ORIGIN\)/)
    expect(script).toMatch(/evt\.origin !== DRAWIO_ORIGIN \|\| !drawio\?\.contentWindow \|\| evt\.source !== drawio\.contentWindow/)
  })
})
