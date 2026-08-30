import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const rootPath = process.cwd()
const read = relativePath => fs.readFileSync(path.join(rootPath, relativePath), 'utf8')

describe('Helm application lifecycle contract', () => {
  test('keeps the source lifecycle, access, and operator guidance aligned', () => {
    const deployment = read('dev/helm/templates/deployment.yaml')
    const notes = read('dev/helm/templates/NOTES.txt')
    const readme = read('dev/helm/README.md')
    const smoke = read('dev/e2e/helm-lifecycle-smoke.sh')
    const install = smoke.slice(smoke.indexOf('helm install'), smoke.indexOf('helm upgrade'))
    const renderContract = read('server/test/scripts/check-helm-lifecycle-contract.sh')
    const protectedWorkflow = read('.github/workflows/helm.yml')
    const lifecycleWorkflow = read('.github/workflows/build.yml')
    const upgrade = smoke.slice(smoke.indexOf('helm upgrade'), smoke.indexOf('helm rollback'))

    expect(deployment).toContain('strategy:\n    type: Recreate')
    expect(notes).toContain('port-forward service/{{ include "wiki.fullname" . }} 8080:{{ .Values.service.port }}')
    expect(notes).toContain('http://127.0.0.1:8080/healthz')
    expect(notes).not.toContain('port-forward $POD_NAME 8080:80')

    expect(readme).toContain('kubectl --namespace default port-forward service/wiki-tsfranki 8080:80')
    expect(readme).toContain('curl --fail http://127.0.0.1:8080/healthz')
    expect(renderContract).toContain('helm lint dev/helm')
    expect(renderContract).toContain('--show-only templates/deployment.yaml')
    expect(renderContract).toContain('helm install wiki dev/helm')
    expect(protectedWorkflow).toContain('run: server/test/scripts/check-helm-lifecycle-contract.sh')
    expect(protectedWorkflow).not.toMatch(/helm (?:lint|template) (?:wiki )?dev\/helm/)
    expect(readme).toContain('at the cost of application downtime')

    expect(install).toContain('--set image.repository="$PREVIOUS_IMAGE_REPOSITORY"')
    expect(install).toContain('--set-string image.digest="$PREVIOUS_IMAGE_DIGEST"')
    expect(upgrade).toContain('--set image.repository="$WIKI_TEST_IMAGE_REPOSITORY"')
    expect(upgrade).toContain('--set-string image.digest=')
    expect(upgrade).toContain('--set-string image.tag="$WIKI_TEST_IMAGE_TAG"')
    expect(smoke).toContain(': "${WIKI_TEST_PREVIOUS_IMAGE:?WIKI_TEST_PREVIOUS_IMAGE is required}"')
    expect(smoke).toMatch(/\^\(\.\+\):\(\[\^\/@\]\+\)@\(sha256:\[0-9a-f\]\{64\}\)\$/)
    expect(smoke).toContain('docker image inspect --format \'{{.Id}}\' "$WIKI_TEST_PREVIOUS_IMAGE"')
    expect(smoke).toContain('if [ "$INITIAL_IMAGE_REVISION" = "$CANDIDATE_IMAGE_REVISION" ]')
    expect(smoke).not.toContain('docker image tag "$WIKI_TEST_IMAGE_REPOSITORY:$WIKI_TEST_IMAGE_TAG"')
    expect(smoke).toContain('kind load docker-image --name "$KIND_CLUSTER_NAME" "$WIKI_TEST_PREVIOUS_IMAGE"')
    expect(smoke).toContain('podAnnotations.lifecycle-image-revision="$INITIAL_IMAGE_REVISION"')
    expect(upgrade).toContain('podAnnotations.lifecycle-image-revision="$CANDIDATE_IMAGE_REVISION"')
    expect(smoke).toContain('helm get values "$RELEASE"')
    expect(smoke).toContain('Helm lifecycle evidence: stage=%s helmRevision=%s image=%s applicationRevision=%s')
    expect(lifecycleWorkflow).toMatch(/WIKI_HELM_PREVIOUS_IMAGE: \S+@sha256:[0-9a-f]{64}/)
    expect(lifecycleWorkflow).toContain('run: docker pull "$WIKI_HELM_PREVIOUS_IMAGE"')
    expect(lifecycleWorkflow).toContain('WIKI_TEST_PREVIOUS_IMAGE: ${{ env.WIKI_HELM_PREVIOUS_IMAGE }}')
    expect(upgrade).toContain('--timeout 10m >"$UPGRADE_LOG" 2>&1 &')
    expect(upgrade).toContain('while kill -0 "$upgrade_pid"')
    expect(upgrade).toContain('assert_no_mixed_application_versions')
    expect(smoke).toContain('($pods | map(.image) | unique) as $images')
    expect(smoke).toContain('if ($images | length) > 1')
    expect(smoke).toContain('port-forward service/"$APP" 8080:80')
    expect(smoke).toContain('http://127.0.0.1:8080/healthz')
    expect(() => execFileSync('bash', ['-n', 'dev/e2e/helm-lifecycle-smoke.sh'], { cwd: rootPath })).not.toThrow()
  })

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
