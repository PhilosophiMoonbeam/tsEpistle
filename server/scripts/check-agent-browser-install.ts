import { open, readFile, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const ELF_HEADER_BYTES = 64
const require = createRequire(import.meta.url)

const layouts = {
  amd64: {
    machine: 0x3e,
    machineName: 'x86-64',
    chromiumPath: 'chrome-linux64/chrome',
    headlessShellPath: 'chrome-headless-shell-linux64/chrome-headless-shell'
  },
  arm64: {
    machine: 0xb7,
    machineName: 'AArch64',
    chromiumPath: 'chrome-linux/chrome',
    headlessShellPath: 'chrome-linux/headless_shell'
  }
} as const

type SupportedArchitecture = keyof typeof layouts

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'I/O error'
}

async function readBrowserRevisions(): Promise<{ chromium: string; headlessShell: string }> {
  let playwrightCoreEntry: string
  try {
    playwrightCoreEntry = require.resolve('playwright-core')
  } catch (error) {
    throw new Error(`cannot resolve installed playwright-core (${errorCode(error)})`)
  }

  const manifestPath = path.join(path.dirname(playwrightCoreEntry), 'browsers.json')
  let manifestText: string
  try {
    manifestText = await readFile(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read installed playwright-core browsers.json (${errorCode(error)})`)
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw new Error('installed playwright-core browsers.json is invalid JSON')
  }
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest) ||
    !('browsers' in manifest) ||
    !Array.isArray(manifest.browsers)
  ) {
    throw new Error('installed playwright-core browsers.json has no browsers list')
  }
  const browsers: unknown[] = manifest.browsers

  function revisionFor(name: string): string {
    let revision: unknown
    let matches = 0
    for (const browser of browsers) {
      if (
        typeof browser !== 'object' ||
        browser === null ||
        Array.isArray(browser) ||
        !('name' in browser) ||
        browser.name !== name
      ) continue
      matches += 1
      revision = 'revision' in browser ? browser.revision : undefined
    }
    if (matches !== 1) throw new Error(`browsers.json must contain one ${name} entry`)
    if (typeof revision !== 'string' || !/^\d+$/.test(revision)) {
      throw new Error(`browsers.json has an invalid ${name} revision`)
    }
    return revision
  }

  return {
    chromium: revisionFor('chromium'),
    headlessShell: revisionFor('chromium-headless-shell')
  }
}

async function readElfHeader(executablePath: string, name: string): Promise<Buffer> {
  let fileHandle: FileHandle
  try {
    fileHandle = await open(executablePath, 'r')
  } catch (error) {
    throw new Error(`${name} binary is unavailable (${errorCode(error)})`)
  }

  const header = Buffer.alloc(ELF_HEADER_BYTES)
  let bytesRead = 0
  let readFailure: string | undefined
  let closeFailure: string | undefined
  try {
    bytesRead = (await fileHandle.read(header, 0, header.length, 0)).bytesRead
  } catch (error) {
    readFailure = errorCode(error)
  } finally {
    try {
      await fileHandle.close()
    } catch (error) {
      closeFailure = errorCode(error)
    }
  }

  if (readFailure) throw new Error(`cannot read ${name} ELF header (${readFailure})`)
  if (closeFailure) throw new Error(`cannot close ${name} binary (${closeFailure})`)
  if (bytesRead !== ELF_HEADER_BYTES) throw new Error(`${name} binary has a truncated ELF header`)
  return header
}

function verifyElfHeader(header: Buffer, name: string, architecture: SupportedArchitecture): void {
  const layout = layouts[architecture]
  if (header.readUInt8(0) !== 0x7f || header.toString('ascii', 1, 4) !== 'ELF') {
    throw new Error(`${name} binary is not ELF`)
  }
  if (header.readUInt8(4) !== 2) throw new Error(`${name} binary is not 64-bit ELF`)
  if (header.readUInt8(5) !== 1) throw new Error(`${name} binary is not little-endian ELF`)

  const machine = header.readUInt16LE(18)
  if (machine !== layout.machine) {
    throw new Error(
      `${name} binary has ELF machine 0x${machine.toString(16).padStart(4, '0')}; expected ${layout.machineName}`
    )
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error('usage: bun server/scripts/check-agent-browser-install.ts <amd64|arm64>')
  }
  const architecture = process.argv[2]
  if (architecture !== 'amd64' && architecture !== 'arm64') {
    throw new Error(`unsupported TARGETARCH '${architecture}' (expected amd64 or arm64)`)
  }

  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!browsersPath) throw new Error('PLAYWRIGHT_BROWSERS_PATH must be set')

  const revisions = await readBrowserRevisions()
  const layout = layouts[architecture]
  const binaries = [
    {
      name: 'chromium',
      path: path.join(
        browsersPath,
        `chromium-${revisions.chromium}`,
        layout.chromiumPath
      )
    },
    {
      name: 'headless shell',
      path: path.join(
        browsersPath,
        `chromium_headless_shell-${revisions.headlessShell}`,
        layout.headlessShellPath
      )
    }
  ]

  for (const binary of binaries) {
    const header = await readElfHeader(binary.path, binary.name)
    verifyElfHeader(header, binary.name, architecture)
  }

  console.log(`Verified ${architecture} architecture headers for Playwright Chromium and headless shell.`)
}

try {
  await main()
} catch (error) {
  console.error(`agent-browser install check failed: ${error instanceof Error ? error.message : 'unexpected error'}`)
  process.exitCode = 1
}
