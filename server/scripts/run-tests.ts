const roots = ['client', 'server', 'shared'] as const
const requested = Bun.argv.slice(2)

const discoverTests = async (): Promise<string[]> => {
  if (requested.length > 0) return requested
  const glob = new Bun.Glob('**/*.{test,spec}.{js,jsx,ts,tsx}')
  const files = await Promise.all(roots.map(async root =>
    Array.fromAsync(glob.scan({ cwd: root, onlyFiles: true })).then(matches => matches.map(match => `${root}/${match}`))
  ))
  return files.flat().sort()
}

interface TestFailure {
  file: string
  output: string
}

const files = await discoverTests()
if (files.length === 0) throw new Error('No test files matched.')

const workerCount = Math.max(1, Math.min(Number.parseInt(Bun.env.BUN_TEST_JOBS ?? '8', 10) || 8, files.length))
const failures: TestFailure[] = []
let nextFile = 0

const runWorker = async (): Promise<void> => {
  while (nextFile < files.length) {
    const file = files[nextFile++]!
    const child = Bun.spawn([process.execPath, 'test', file], {
      cwd: import.meta.dir + '/../..',
      env: Bun.env,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (exitCode !== 0) failures.push({ file, output: `${stdout}${stderr}`.trim() })
  }
}

await Promise.all(Array.from({ length: workerCount }, runWorker))

for (const failure of failures) {
  console.error(`\n::group::${failure.file}\n${failure.output}\n::endgroup::`)
}

if (failures.length > 0) {
  console.error(`\n${files.length - failures.length}/${files.length} test files passed; ${failures.length} failed.`)
  process.exit(1)
}

console.log(`${files.length}/${files.length} test files passed in isolated Bun processes.`)
