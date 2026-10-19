import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const rootPath = process.cwd()

describe('product build and publication metadata', () => {
  test('resolves deployment images only when the canary pointer matches its immutable revision record', () => {
    const temporaryDirectory = fs.mkdtempSync('/tmp/wiki-canary-promotion-')
    const fakeBin = path.join(temporaryDirectory, 'bin')
    const pointerManifest = path.join(temporaryDirectory, 'pointer.json')
    const immutableManifest = path.join(temporaryDirectory, 'immutable.json')
    const revision = 'a'.repeat(40)
    const applicationAmd64 = `registry.test/wiki@sha256:${'b'.repeat(64)}`
    const applicationArm64 = `registry.test/wiki@sha256:${'c'.repeat(64)}`
    const agentBrowserAmd64 = `registry.test/wiki-agent-browser@sha256:${'d'.repeat(64)}`
    const agentBrowserArm64 = `registry.test/wiki-agent-browser@sha256:${'e'.repeat(64)}`
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      annotations: {
        'io.tsepistle.canary-promotion.schema-version': '1',
        'io.tsepistle.canary-promotion.main-sha': revision,
        'org.opencontainers.image.revision': revision,
        'io.tsepistle.canary-promotion.application-amd64': applicationAmd64,
        'io.tsepistle.canary-promotion.application-arm64': applicationArm64,
        'io.tsepistle.canary-promotion.agent-browser-amd64': agentBrowserAmd64,
        'io.tsepistle.canary-promotion.agent-browser-arm64': agentBrowserArm64
      }
    })

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(pointerManifest, manifest)
      fs.writeFileSync(immutableManifest, manifest)
      const fakeDocker = path.join(fakeBin, 'docker')
      fs.writeFileSync(fakeDocker, `#!/bin/sh
if [ "$4" = "$WIKI_CANARY_PROMOTION_REPOSITORY:${revision}" ]; then
  cat "$CANARY_IMMUTABLE_MANIFEST"
else
  cat "$CANARY_POINTER_MANIFEST"
fi
`)
      fs.chmodSync(fakeDocker, 0o755)
      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        WIKI_CANARY_PROMOTION_REPOSITORY: 'registry.test/wiki-canary-promotion',
        WIKI_IMAGE_REPOSITORY: 'registry.test/wiki',
        WIKI_AGENT_BROWSER_IMAGE_REPOSITORY: 'registry.test/wiki-agent-browser',
        CANARY_POINTER_MANIFEST: pointerManifest,
        CANARY_IMMUTABLE_MANIFEST: immutableManifest
      }

      const resolved = JSON.parse(execFileSync('bash', ['dev/resolve-canary-promotion.sh', '--format=json'], {
        cwd: rootPath,
        encoding: 'utf8',
        env
      }))
      expect(resolved).toEqual({
        schemaVersion: 1,
        mainSha: revision,
        images: {
          application: { amd64: applicationAmd64, arm64: applicationArm64 },
          agentBrowser: { amd64: agentBrowserAmd64, arm64: agentBrowserArm64 }
        }
      })

      const deploymentEnvironment = execFileSync('bash', ['dev/resolve-canary-promotion.sh', '--format=env'], {
        cwd: rootPath,
        encoding: 'utf8',
        env: { ...env, WIKI_CANARY_ARCHITECTURE: 'arm64' }
      })
      expect(deploymentEnvironment).toContain(`export WIKI_CANARY_MAIN_SHA='${revision}'`)
      expect(deploymentEnvironment).toContain(`export WIKI_IMAGE='${applicationArm64}'`)
      expect(deploymentEnvironment).toContain(`export WIKI_AGENT_BROWSER_IMAGE='${agentBrowserArm64}'`)

      const mismatchedManifest = JSON.parse(manifest)
      mismatchedManifest.annotations['io.tsepistle.canary-promotion.application-amd64'] = `registry.test/wiki@sha256:${'f'.repeat(64)}`
      fs.writeFileSync(immutableManifest, JSON.stringify(mismatchedManifest))
      const mismatch = spawnSync('bash', ['dev/resolve-canary-promotion.sh', '--format=json'], {
        cwd: rootPath,
        env,
        encoding: 'utf8'
      })
      expect(mismatch.status).toBe(1)
      expect(mismatch.stdout).toBe('')
      expect(mismatch.stderr).toContain(`${env.WIKI_CANARY_PROMOTION_REPOSITORY}:${revision}`)
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
