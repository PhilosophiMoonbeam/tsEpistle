import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '../../server/test/bun-test.mts'

const editorPath = path.join(process.cwd(), 'client/components/editor.vue')
const editorSource = fs.readFileSync(editorPath, 'utf8')
const script = editorSource.match(/<script lang=['"]ts['"]>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? ''

describe('editor Knowledge / OKF save contract', () => {
  it('validates metadata before any create, conflict, or update request', () => {
    const saveStart = script.indexOf('async save(')
    const validation = script.indexOf('const pageInput = this.getPageInput()', saveStart)
    const create = script.indexOf('await createPage(', saveStart)
    const conflict = script.indexOf('await checkPageConflict(', saveStart)
    const update = script.indexOf('await updatePage(', saveStart)

    expect(saveStart).toBeGreaterThan(-1)
    expect(validation).toBeGreaterThan(saveStart)
    expect(validation).toBeLessThan(create)
    expect(validation).toBeLessThan(conflict)
    expect(validation).toBeLessThan(update)
  })

  it('routes invalid metadata through the existing visible editor error notification', () => {
    const getPageInput = script.slice(script.indexOf('getPageInput ()'), script.indexOf('setCurrentSavedState ()'))
    const save = script.slice(script.indexOf('async save('), script.indexOf('async saveAndClose()'))

    expect(getPageInput).toContain('buildOkfMetadataPayload(wikiStore.page.okf.authority.metadata)')
    expect(getPageInput).toContain('okfMetadata === undefined ? {} : { okfMetadata }')
    expect(save).toContain('message: getErrorMessage(err)')
    expect(save).toContain("style: 'error'")
    expect(save).toContain("icon: 'warning'")
  })

  it('keeps invalid drafts observable without throwing from dirty-state rendering', () => {
    expect(script).toContain('validateOkfMetadataPayload(wikiStore.page.okf.authority.metadata)')
    expect(script).toContain('!_.isEqual(this.savedState.okfMetadata, validateOkfMetadataPayload')
  })
})
