import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const rootPath = process.cwd()

describe('Helm application lifecycle contract', () => {

  test('fails closed when the supported previous release is missing or unresolved', () => {
    const fakeBin = fs.mkdtempSync(path.join(process.cwd(), 'helm-lifecycle-contract-'))
    const docker = path.join(fakeBin, 'docker')
    fs.writeFileSync(docker, '#!/usr/bin/env bash\nexit 1\n')
    fs.chmodSync(docker, 0o755)
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      WIKI_TEST_IMAGE_REPOSITORY: 'candidate.example/wiki',
      WIKI_TEST_IMAGE_TAG: 'candidate',
      POSTGRES_TEST_IMAGE_REPOSITORY: 'postgres.example/postgres',
      POSTGRES_TEST_IMAGE_TAG: '15'
    }

    try {
      const missing = spawnSync('bash', ['dev/e2e/helm-lifecycle-smoke.sh'], {
        cwd: rootPath,
        encoding: 'utf8',
        env: { ...env, WIKI_TEST_PREVIOUS_IMAGE: '' }
      })
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('WIKI_TEST_PREVIOUS_IMAGE is required')

      const previousImage = `previous.example/wiki:1.0.0@sha256:${'b'.repeat(64)}`
      const unresolved = spawnSync('bash', ['dev/e2e/helm-lifecycle-smoke.sh'], {
        cwd: rootPath,
        encoding: 'utf8',
        env: { ...env, WIKI_TEST_PREVIOUS_IMAGE: previousImage }
      })
      expect(unresolved.status).toBe(1)
      expect(unresolved.stderr).toContain(`Supported previous-release image is not resolved locally: ${previousImage}`)
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true })
    }
  })

  test('rejects a previous release that resolves to the candidate image ID', () => {
    const fakeBin = fs.mkdtempSync(path.join(process.cwd(), 'helm-lifecycle-contract-'))
    const docker = path.join(fakeBin, 'docker')
    const imageRevision = `sha256:${'a'.repeat(64)}`
    fs.writeFileSync(docker, `#!/usr/bin/env bash\nprintf '%s\\n' '${imageRevision}'\n`)
    fs.chmodSync(docker, 0o755)

    try {
      const result = spawnSync('bash', ['dev/e2e/helm-lifecycle-smoke.sh'], {
        cwd: rootPath,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          WIKI_TEST_IMAGE_REPOSITORY: 'candidate.example/wiki',
          WIKI_TEST_IMAGE_TAG: 'candidate',
          WIKI_TEST_PREVIOUS_IMAGE: `previous.example/wiki:1.0.0@sha256:${'b'.repeat(64)}`,
          POSTGRES_TEST_IMAGE_REPOSITORY: 'postgres.example/postgres',
          POSTGRES_TEST_IMAGE_TAG: '15'
        }
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Previous release and candidate resolve to the same application revision: ${imageRevision}`)
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true })
    }
  })
})
