export const OPTIONAL_EXTENSION_KEYS = ['git', 'pandoc', 'puppeteer', 'sharp'] as const

export type OptionalExtensionKey = (typeof OPTIONAL_EXTENSION_KEYS)[number]
export type ExtensionObservationState = 'usable' | 'missing' | 'not-provided' | 'unknown'
export type ExtensionCompatibilityState = 'verified' | 'not-applicable' | 'unknown'
export type ExtensionInstallationBoundary = 'application-image' | 'application-package' | 'separate-image'

export interface ExtensionWorkspaceLink {
  label: string
  path: string
  query?: Record<string, string>
  hash?: string
}

export interface ExtensionWorkspaceCapability {
  title: string
  detail: string
  configuration?: ExtensionWorkspaceLink
}

export interface ExtensionWorkspaceDependency {
  title: string
  detail: string
}

export interface OptionalExtensionRuntimeObservation {
  state: ExtensionObservationState
  compatibility: ExtensionCompatibilityState
  evidence: string
}

/** Server-only definition. Its observation must be bounded, input-free and free of command output. */
export interface OptionalExtensionDefinition {
  key: OptionalExtensionKey
  title: string
  description: string
  installation: {
    boundary: ExtensionInstallationBoundary
    detail: string
    recovery: string
  }
  capabilities: ExtensionWorkspaceCapability[]
  dependencies: ExtensionWorkspaceDependency[]
  observe(): Promise<OptionalExtensionRuntimeObservation>
}

export interface ExtensionWorkspaceExtension {
  key: OptionalExtensionKey
  title: string
  description: string
  installation: OptionalExtensionDefinition['installation']
  capabilities: ExtensionWorkspaceCapability[]
  dependencies: ExtensionWorkspaceDependency[]
  observation: OptionalExtensionRuntimeObservation & { checkedAt: string }
}

export interface ExtensionsWorkspace {
  observedAt: string
  extensions: ExtensionWorkspaceExtension[]
}
