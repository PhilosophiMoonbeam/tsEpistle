import { execFileSync } from 'node:child_process'
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

    expect(install).toContain('--set-string image.tag="$INITIAL_IMAGE_TAG"')
    expect(upgrade).toContain('--set-string image.tag="$WIKI_TEST_IMAGE_TAG"')
    expect(smoke).toContain('INITIAL_IMAGE_TAG="${WIKI_TEST_IMAGE_TAG}-helm-initial"')
    expect(smoke).toContain('docker image tag "$WIKI_TEST_IMAGE_REPOSITORY:$WIKI_TEST_IMAGE_TAG" "$INITIAL_IMAGE"')
    expect(smoke).toContain('kind load docker-image --name "$KIND_CLUSTER_NAME" "$INITIAL_IMAGE"')
    expect(upgrade).toContain('--timeout 10m >"$UPGRADE_LOG" 2>&1 &')
    expect(upgrade).toContain('while kill -0 "$upgrade_pid"')
    expect(upgrade).toContain('assert_no_mixed_application_versions')
    expect(smoke).toContain('($pods | map(.image) | unique) as $images')
    expect(smoke).toContain('if ($images | length) > 1')
    expect(smoke).toContain('port-forward service/"$APP" 8080:80')
    expect(smoke).toContain('http://127.0.0.1:8080/healthz')
    expect(() => execFileSync('bash', ['-n', 'dev/e2e/helm-lifecycle-smoke.sh'], { cwd: rootPath })).not.toThrow()
  })
})
