import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Run explicitly, never through the browser/runtime test scheduler. Both controls
// use the real project, so an unrelated baseline failure cannot count as success.
const root = fileURLToPath(new URL('../../', import.meta.url))
const project = path.join(root, 'tsconfig.client-tests.json')
const filename = path.join(root, 'client/test', `frontend-type-control-${randomUUID()}.test.ts`)
const fixture = (element: string): string => `import { createModalFocusScope } from '../components/common/modal-focus-scope.ts'
createModalFocusScope({ root: ${element}, restoreTarget: null, onEscape: () => {} })
`
const typecheck = () => spawnSync(process.execPath, [
  'server/scripts/run-vue-tsc.ts', '-p', project, '--noEmit', '--pretty', 'false'
], { cwd: root, encoding: 'utf8' })

try {
  writeFileSync(filename, fixture("document.createElement('section')"), { flag: 'wx' })
  const config = ts.readConfigFile(project, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  if (parsed.errors.length || !parsed.fileNames.includes(filename)) {
    throw new Error('The frontend test project did not admit the public fixture control')
  }
  const positive = typecheck()
  if (positive.error || positive.status !== 0) {
    throw new Error(`Compatible public fixture failed typechecking:\n${positive.error ?? ''}${positive.stdout}${positive.stderr}`)
  }
  writeFileSync(filename, fixture('42'))
  const negative = typecheck()
  const diagnostics = `${negative.stdout}${negative.stderr}`
  const diagnosticFile = path.relative(root, filename).split(path.sep).join('/')
  const rejectedFixture = diagnostics.split('\n').some(line =>
    line.includes(`${diagnosticFile}(2,`) && line.includes('error TS2322:') && line.includes("Type 'number' is not assignable to type 'HTMLElement'")
  )
  if (negative.error || negative.status === null || negative.status === 0 || !rejectedFixture) {
    throw new Error(`Incompatible public fixture was not rejected for its HTMLElement contract:\n${negative.error ?? ''}${diagnostics}`)
  }
  console.log('Frontend test typing admits a compatible public fixture and rejects its incompatible root (TS2322).')
} finally {
  rmSync(filename, { force: true })
}
