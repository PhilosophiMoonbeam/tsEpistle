/** Handler identities implemented by this build. Factory keys must match this catalog. */
export const durableJobIdentities = [
  'locale-package@1',
  'storage-action@1',
  'cleanup-durable-jobs@1',
  'cleanup-site-logo@1',
  'process-site-logo@1',
  'process-site-logo@2',
  'process-site-logo@3',
  'rerender-content-extension@1',
  'deliver-webhook@1',
  'notify-page-watcher@1',
  'asset-relocation@1'
] as const
export type DurableJobIdentity = (typeof durableJobIdentities)[number]
