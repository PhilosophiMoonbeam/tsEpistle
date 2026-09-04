import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'

export const SITE_LOGO_MAX_BYTES = 5_242_880
export type SiteLogoAcceptedType = 'image/png' | 'image/jpeg' | 'image/webp'

export type SiteLogoCandidateState = 'pending' | 'running' | 'ready' | 'failed'
export type SiteLogoErrorCode =
  | 'UNSUPPORTED_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'INVALID_IMAGE'
  | 'NO_VISIBLE_PIXELS'
  | 'UNSUITABLE_LOGO'
  | 'PROCESSING_FAILED'
  | 'ARTIFACT_TOO_LARGE'
  | 'MANAGED_LOGO_CONFLICT'

export type SiteLogoStatus = {
  active: {
    revisionId: string
    logoUrl: string
  } | null
  candidate: {
    revisionId: string
    status: SiteLogoCandidateState
    errorCode: SiteLogoErrorCode | null
  } | null
  statusUrl?: '/_api/site/logo'
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

const acceptedContentTypes: Record<SiteLogoAcceptedType, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true
}

const candidateStates: Record<SiteLogoCandidateState, true> = {
  pending: true,
  running: true,
  ready: true,
  failed: true
}

const errorCodes: Record<SiteLogoErrorCode, true> = {
  UNSUPPORTED_IMAGE: true,
  IMAGE_TOO_LARGE: true,
  INVALID_IMAGE: true,
  NO_VISIBLE_PIXELS: true,
  UNSUITABLE_LOGO: true,
  PROCESSING_FAILED: true,
  ARTIFACT_TOO_LARGE: true,
  MANAGED_LOGO_CONFLICT: true
}
const publicLogoPattern = /^\/_site-logo\/[a-f0-9]{64}\/logo\.png$/
export class SiteLogoApiError extends Error {
  readonly code: SiteLogoErrorCode | null
  constructor(code: SiteLogoErrorCode | null, message = 'Site logo request failed.') {
    super(message)
    this.name = 'SiteLogoApiError'
    this.code = code
  }
}
export function isSiteLogoErrorCode(value: unknown): value is SiteLogoErrorCode {
  return typeof value === 'string' && value in errorCodes
}

export function isSiteLogoAcceptedType(value: unknown): value is SiteLogoAcceptedType {
  return typeof value === 'string' && value in acceptedContentTypes
}

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) return null
  return await response.json().catch(() => null)
}
function parseStatus(payload: unknown): SiteLogoStatus {
  if (!isRecord(payload)) throw new SiteLogoApiError(null)

  const active = payload.active
  if (active !== null && (!isRecord(active) || typeof active.revisionId !== 'string' || !publicLogoPattern.test(String(active.logoUrl))))
    throw new SiteLogoApiError(null)

  const candidate = payload.candidate
  if (candidate !== null) {
    if (
      !isRecord(candidate) ||
      typeof candidate.revisionId !== 'string' ||
      typeof candidate.status !== 'string' ||
      !(candidate.status in candidateStates) ||
      !(candidate.errorCode === null || isSiteLogoErrorCode(candidate.errorCode))
    )
      throw new SiteLogoApiError(null)
  }

  if (payload.statusUrl !== undefined && payload.statusUrl !== '/_api/site/logo') {
    throw new SiteLogoApiError(null)
  }

  return payload as SiteLogoStatus
}

async function requestStatus(fetchImpl: FetchImpl, path: string, init: RequestInit): Promise<SiteLogoStatus> {
  const response = await sameOriginJsonFetch(fetchImpl, path, init)
  const payload = await readPayload(response)
  if (!response.ok) {
    const code = isRecord(payload) && isSiteLogoErrorCode(payload.code) ? payload.code : null
    throw new SiteLogoApiError(code)
  }
  return parseStatus(payload)
}

export function fetchSiteLogoStatus(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<SiteLogoStatus> {
  return requestStatus(fetchImpl, '/_api/site/logo', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal
  })
}

export function uploadSiteLogo(fetchImpl: FetchImpl, file: File, signal?: AbortSignal): Promise<SiteLogoStatus> {
  const body = new FormData()
  body.append('image', file, file.name)
  return requestStatus(fetchImpl, '/_api/site/logo', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    body,
    signal
  })
}

export function retrySiteLogo(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<SiteLogoStatus> {
  return requestStatus(fetchImpl, '/_api/site/logo/retry', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal
  })
}
