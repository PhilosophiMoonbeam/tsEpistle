import { promises as dns } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { BrowserWorkerError } from './errors.ts'
import { parseCanonicalBrowserTarget } from './target.ts'

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
] as const) blocked.addSubnet(network, prefix, 'ipv6')

export interface BrowserDnsResolver { resolve4(hostname: string): Promise<readonly string[]>; resolve6(hostname: string): Promise<readonly string[]> }
const systemResolver: BrowserDnsResolver = { resolve4: hostname => dns.resolve4(hostname), resolve6: hostname => dns.resolve6(hostname) }
const safeResolve = async (resolve: () => Promise<readonly string[]>): Promise<readonly string[]> => { try { return await resolve() } catch { return [] } }

export const assertPublicBrowserTarget = async (url: string, resolver: BrowserDnsResolver = systemResolver): Promise<void> => {
  const target = parseCanonicalBrowserTarget(url)
  const hostname = target.hostname.startsWith('[') && target.hostname.endsWith(']') ? target.hostname.slice(1, -1) : target.hostname
  const literalFamily = isIP(hostname)
  const addresses = literalFamily > 0
    ? [hostname]
    : [...await safeResolve(() => resolver.resolve4(hostname)), ...await safeResolve(() => resolver.resolve6(hostname))]
  if (addresses.length === 0) throw new BrowserWorkerError('BROWSER_DNS_FAILED', 'Browser target did not resolve to a public address', 403)
  for (const address of addresses) {
    const family = isIP(address)
    if (family === 0 || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) throw new BrowserWorkerError('BROWSER_EGRESS_DENIED', 'Browser target resolves to a forbidden network', 403)
  }
}
