import type { ExternalMcpServerInput, ExternalMcpServerView } from '../../shared/agents/external-mcp.ts'

export interface ExternalMcpOAuthDraft {
  issuer: string
  scopes: string
  registrationMode: 'automatic' | 'preregistered'
  clientId: string
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
  clientSecret: string
  clearClientSecret: boolean
}

export const createExternalMcpOAuthDraft = (oauth?: ExternalMcpServerView['oauth']): ExternalMcpOAuthDraft => ({
  issuer: oauth?.issuer ?? '',
  scopes: oauth?.scopes?.join('\n') ?? '',
  registrationMode: oauth?.registrationMode ?? 'automatic',
  clientId: oauth?.clientId ?? '',
  tokenEndpointAuthMethod: oauth?.tokenEndpointAuthMethod ?? 'none',
  clientSecret: '',
  clearClientSecret: false
})

export const externalMcpOAuthInput = (draft: ExternalMcpOAuthDraft): ExternalMcpServerInput['oauth'] => ({
  ...(draft.issuer.trim() ? { issuer: draft.issuer.trim() } : {}),
  ...(draft.scopes.trim() ? { scopes: draft.scopes.split(/\s+/u).filter(Boolean) } : {}),
  registrationMode: draft.registrationMode,
  ...(draft.registrationMode === 'preregistered' ? {
    clientId: draft.clientId.trim(),
    tokenEndpointAuthMethod: draft.tokenEndpointAuthMethod,
    ...(draft.clearClientSecret ? { clientSecretValue: null } : draft.clientSecret ? { clientSecretValue: draft.clientSecret } : {})
  } : {})
})
