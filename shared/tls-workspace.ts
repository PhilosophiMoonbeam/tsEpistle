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
