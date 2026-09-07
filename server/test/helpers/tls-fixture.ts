import { execFileSync } from 'node:child_process'
import { mkdtempSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Local, short-lived test material. No external CA or production certificate is used. */
export const tlsFixture = (days = 2) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsepistle-tls-test-'))
  chmodSync(directory, 0o700)
  const issue = (name: string) => {
    const keyPath = join(directory, name + '.key'),
      certPath = join(directory, name + '.crt'),
      pfxPath = join(directory, name + '.p12')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        String(days),
        '-subj',
        '/CN=wiki.example.test',
        '-addext',
        'subjectAltName=DNS:wiki.example.test,IP:127.0.0.1'
      ],
      { stdio: 'ignore' }
    )
    execFileSync('openssl', ['pkcs12', '-export', '-out', pfxPath, '-inkey', keyPath, '-in', certPath, '-passout', 'pass:fixture-password'], {
      stdio: 'ignore'
    })
    for (const path of [keyPath, certPath, pfxPath]) chmodSync(path, 0o600)
    return { keyPath, certPath, pfxPath, key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
  }
  try {
    return { directory, first: issue('first'), second: issue('second'), close: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
