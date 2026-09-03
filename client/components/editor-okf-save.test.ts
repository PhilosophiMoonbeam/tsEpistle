import fs from 'node:fs'
import path from 'node:path'
import _ from 'lodash'
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
    expect(save).toMatch(/const message = getErrorMessage\(err\)[\s\S]*?wikiStore\.showNotification\(\{\s*message,\s*style: 'error',\s*icon: 'warning'/)
  })

  it('keeps invalid drafts observable and restores a deep-cloned OKF baseline', () => {
    const isDirtyBody = script.match(/isDirty \(\) \{([\s\S]*?)\n\s+\}\n\s+\},\n\s+watch:/)?.[1] ?? ''
    const setSavedStateBody = script.match(/setCurrentSavedState \(\) \{([\s\S]*?)\n\s+\},\n\s+restoreCurrentSavedState/)?.[1] ?? ''
    const restoreSavedStateBody = script.match(/restoreCurrentSavedState \(\) \{([\s\S]*?)\n\s+\},\n\s+injectCustomCss/)?.[1] ?? ''
    const wikiStore = {
      editor: {
        content: 'persisted content'
      },
      page: {
        description: 'persisted description',
        isPublished: true,
        visibility: 'public',
        locale: 'en',
        path: 'knowledge',
        publishEndDate: '',
        publishStartDate: '',
        tags: ['knowledge'],
        title: 'Knowledge',
        scriptCss: '',
        scriptJs: '',
        okf: {
          authority: {
            state: 'valid',
            metadata: { type: 'Reference', status: 'stable' }
          },
          projection: {
            state: 'current',
            value: { summary: 'persisted' }
          }
        }
      }
    }
    type SavedState = {
      content: string
      description: string
      isPublished: boolean
      visibility: string
      locale: string
      path: string
      publishEndDate: string
      publishStartDate: string
      tags: string[]
      title: string
      scriptCss: string
      scriptJs: string
      okf: typeof wikiStore.page.okf
    }
    const context = {
      savedState: {} as SavedState
    }
    const loadMethod = (body: string) =>
      new Function('_', 'wikiStore', `return function () {${body}}`)(_, wikiStore) as (this: typeof context) => unknown
    const isDirty = loadMethod(isDirtyBody)
    const setCurrentSavedState = loadMethod(setSavedStateBody)
    const restoreCurrentSavedState = loadMethod(restoreSavedStateBody)

    expect(script).not.toContain('validateOkfMetadataPayload')
    expect(script).toContain('!_.isEqual(this.savedState.okf, wikiStore.page.okf)')
    expect(script).toContain('okf: _.cloneDeep(wikiStore.page.okf)')
    expect(script).toContain('wikiStore.page.okf = _.cloneDeep(this.savedState.okf)')

    setCurrentSavedState.call(context)
    expect(context.savedState.okf).toEqual(wikiStore.page.okf)
    expect(context.savedState.okf).not.toBe(wikiStore.page.okf)
    expect(context.savedState.tags).not.toBe(wikiStore.page.tags)

    wikiStore.page.okf.authority.state = 'invalid'
    wikiStore.page.okf.authority.metadata = { type: '', status: 'unsupported' }
    expect(() => isDirty.call(context)).not.toThrow()
    expect(isDirty.call(context)).toBe(true)
    expect(context.savedState.okf.authority.state).toBe('valid')

    restoreCurrentSavedState.call(context)
    expect(isDirty.call(context)).toBe(false)
    expect(wikiStore.page.okf).not.toBe(context.savedState.okf)
    expect(wikiStore.page.tags).not.toBe(context.savedState.tags)
    wikiStore.page.okf.authority.state = 'invalid'
    wikiStore.page.tags.push('live-only')
    expect(context.savedState.okf.authority.state).toBe('valid')
    expect(context.savedState.tags).toEqual(['knowledge'])
  })
})
