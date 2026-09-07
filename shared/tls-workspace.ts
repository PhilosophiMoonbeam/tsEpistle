export interface TlsCertificateEvidence {
  fingerprint256: string
  serialNumber: string
  subject: string
  issuer: string
  subjectAlternativeNames: string
  validFrom: string
  validUntil: string
  validity: 'valid' | 'expiring' | 'expired' | 'not-yet-valid'
  daysRemaining: number
  key: string
  isCertificateAuthority: boolean
}
export interface TlsConnectionEvidence {
  observedAt: string
  endpoint: { host: string; port: number; servername: string }
  connected: boolean
  trusted: boolean | null
  hostnameMatches: boolean | null
  protocol: string | null
  cipher: string | null
  certificate: TlsCertificateEvidence | null
  chain: TlsCertificateEvidence[]
  summary: string
}

/** Material accepted by this process; a separate handshake observes what a client receives. */
export interface TlsAppliedMaterial {
  revision: string
  appliedAt: string
  certificate: TlsCertificateEvidence | null
  source: 'inline' | 'file'
  format: 'pem' | 'pfx'
}

export interface TlsConfigurationEvent {
  id: string
  createdAt: string
  actorId: number | null
  apiKeyId: number | null
  reason: string
  enabled: boolean
}
export interface TlsListenerSnapshot {
  httpPort: number | null
  httpsPort: number | null
  material: TlsAppliedMaterial | null
  replacementMode: 'context-reload' | 'listener-restart' | null
}
export interface TlsConfigurationWorkspace {
  fingerprint: string
  revision: string
  observedAt: string
  publicUrl: string
  offline: boolean
  redirection: { enabled: boolean; eligible: boolean; reason: string | null; trustedProxy: boolean }
  deployment: {
    enabled: boolean
    provider: string | null
    format: string | null
    source: 'inline' | 'file'
    domain: string | null
    subscriberEmail: string | null
  }
  listeners: TlsListenerSnapshot
  runtimeRedirection: { enabled: boolean; eligible: boolean; publicUrl: string; settingsCurrent: boolean }
  savedCertificate: TlsCertificateEvidence | null
  savedCertificateIssue: string | null
  history: TlsConfigurationEvent[]
}

export type TlsOperationKind = 'public-check' | 'native-check' | 'validate-material' | 'apply-certificate' | 'renew-certificate'
export interface TlsOperation {
  id: string
  kind: TlsOperationKind
  state: 'running' | 'succeeded' | 'failed' | 'uncertain'
  phase: string
  actorId: number | null
  apiKeyId: number | null
  reason: string
  createdAt: string
  completedAt: string | null
  summary: string
  result: {
    connection?: TlsConnectionEvidence
    material?: { certificate: TlsCertificateEvidence; source: 'inline' | 'file'; format: 'pem' | 'pfx' }
    applied?: TlsAppliedMaterial
  } | null
}
export interface TlsWorkspace extends TlsConfigurationWorkspace {
  operations: TlsOperation[]
}
