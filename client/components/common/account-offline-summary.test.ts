import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/common/account-offline-summary.vue'), 'utf8')
const script = source.match(/<script setup lang='ts'>([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error('Offline summary script was not found')
const ast = ts.createSourceFile('account-offline-summary.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['retry', 'openStorage'].includes(node.name?.text ?? ''))
if (declarations.length !== 2) throw new Error('Offline summary recovery functions were not found')
const compiled = ts.transpileModule(declarations.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

const createRecovery = (openOfflineStorage: () => Promise<{ close: () => void }>) => {
  const state = { loading: true, error: '', disposed: false, reloads: 0 }
  const recovery = new Function('state', 'openOfflineStorage', `
    let storage = null;
    const loading = { get value() { return state.loading }, set value(value) { state.loading = value } };
    const error = { get value() { return state.error }, set value(value) { state.error = value } };
    let disposed = false;
    const t = key => key;
    const load = async () => { state.reloads += 1; state.loading = false; state.error = '' };
    ${compiled}
    return { retry, openStorage, dispose() { disposed = true } };
  `)(state, openOfflineStorage) as { retry: () => Promise<void>; openStorage: () => Promise<void>; dispose: () => void }
  return { state, recovery }
}

describe('offline account summary recovery', () => {
  it('reopens missing storage after a transient failure, then reloads the existing connection', async () => {
    let opens = 0
    let closes = 0
    const { state, recovery } = createRecovery(async () => {
      opens += 1
      if (opens === 1) throw new Error('Database upgrade blocked')
      return { close: () => { closes += 1 } }
    })
    await recovery.openStorage()
    expect(state.error).toBe('Database upgrade blocked')
    expect(state.loading).toBe(false)
    await recovery.retry()
    expect(opens).toBe(2)
    expect(state.reloads).toBe(1)
    expect(state.error).toBe('')
    await recovery.retry()
    expect(opens).toBe(2)
    expect(state.reloads).toBe(2)
    expect(closes).toBe(0)
  })

  it('ignores duplicate retry while opening and closes a connection resolved after disposal', async () => {
    const { promise, resolve: resolveOpen } = Promise.withResolvers<{ close: () => void }>()
    let opens = 0
    let closes = 0
    const { state, recovery } = createRecovery(() => {
      opens += 1
      return promise
    })
    state.loading = false
    const opening = recovery.retry()
    expect(state.loading).toBe(true)
    await recovery.retry()
    expect(opens).toBe(1)
    recovery.dispose()
    resolveOpen({ close: () => { closes += 1 } })
    await opening
    expect(closes).toBe(1)
    expect(state.reloads).toBe(0)
    await recovery.retry()
    expect(opens).toBe(1)
  })
})
