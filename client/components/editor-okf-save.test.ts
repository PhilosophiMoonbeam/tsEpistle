import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import _ from 'lodash'
import * as ts from 'typescript'
import { describe, expect, it } from '../../server/test/bun-test.mts'

const editorPath = join(process.cwd(), 'client/components/editor.vue')
const editorSource = readFileSync(editorPath, 'utf8')
const editorSfc = parse(editorSource, { filename: editorPath })
const editorScript = editorSfc.descriptor.script?.content ?? ''
const editorAst = ts.createSourceFile(editorPath, editorScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const editorDefaultExport = editorAst.statements.find(ts.isExportAssignment)
if (
  !editorDefaultExport ||
  !ts.isCallExpression(editorDefaultExport.expression) ||
  !ts.isObjectLiteralExpression(editorDefaultExport.expression.arguments[0])
) {
  throw new Error('Unable to find the editor component definition')
}
const editorOptions = editorDefaultExport.expression.arguments[0]

const extractObjectOption = (name: string): string => {
  const property = editorOptions.properties.find(
    candidate =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name
  )
  if (!property || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
    throw new Error(`Unable to find the editor ${name} option`)
  }
  return editorScript.slice(property.initializer.getStart(editorAst), property.initializer.end)
}

const executableEditorBehavior = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const editorBehavior = {
    computed: ${extractObjectOption('computed')},
    methods: ${extractObjectOption('methods')}
  }
`)

type OkfState = {
  authority: {
    state: string
    metadata: Record<string, unknown> | null
  }
  projection: {
    state: string
    value: unknown
  }
}

const createStore = () => ({
  editor: {
    content: 'persisted content'
  },
  page: {
    description: 'persisted description',
    isPublished: true,
    isSearchable: true,
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
    } as OkfState
  }
})

describe('editor Knowledge / OKF save contract', () => {
  it('keeps invalid drafts observable and restores a deep-cloned OKF baseline', () => {
    const wikiStore = createStore()
    const behavior = new Function('_', 'wikiStore', `${executableEditorBehavior}\nreturn editorBehavior`)(_, wikiStore) as {
      computed: { isDirty: (this: { savedState: unknown }) => boolean }
      methods: {
        setCurrentSavedState: (this: { savedState: unknown }) => void
        restoreCurrentSavedState: (this: { savedState: unknown }) => void
      }
    }
    const context = { savedState: {} as Record<string, unknown> }
    const setCurrentSavedState = behavior.methods.setCurrentSavedState.bind(context)
    const restoreCurrentSavedState = behavior.methods.restoreCurrentSavedState.bind(context)
    const isDirty = behavior.computed.isDirty.bind(context)

    setCurrentSavedState()
    expect(context.savedState).toMatchObject({ content: 'persisted content', title: 'Knowledge' })
    const savedState = context.savedState as {
      tags: string[]
      okf: OkfState
    }
    expect(savedState.okf).toEqual(wikiStore.page.okf)
    expect(savedState.okf).not.toBe(wikiStore.page.okf)
    expect(savedState.tags).not.toBe(wikiStore.page.tags)

    wikiStore.page.okf.authority.state = 'invalid'
    wikiStore.page.okf.authority.metadata = { type: '', status: 'unsupported' }
    wikiStore.page.tags.push('live-only')
    expect(isDirty()).toBe(true)
    expect(savedState.okf.authority.state).toBe('valid')

    restoreCurrentSavedState()
    expect(isDirty()).toBe(false)
    expect(wikiStore.page.okf).not.toBe(savedState.okf)
    expect(wikiStore.page.tags).not.toBe(savedState.tags)
    wikiStore.page.okf.authority.state = 'invalid'
    wikiStore.page.tags.push('live-only')
    expect(savedState.okf.authority.state).toBe('valid')
    expect(savedState.tags).toEqual(['knowledge'])
  })
})
