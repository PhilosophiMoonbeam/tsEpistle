import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'
import {
  type LogoIconDescriptor,
  type SiteLogoActiveStatus,
  type SiteLogoEnhancementStatus,
  type SiteLogoEnhancementUnavailableReason,
  type SiteLogoErrorCode,
  type SiteLogoStatus
} from '../../shared/site-logo.ts'

export type SiteLogoAcceptedType = 'image/png' | 'image/jpeg' | 'image/webp'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

const acceptedContentTypes: Readonly<Record<SiteLogoAcceptedType, true>> = Object.freeze({
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true
})

const candidateStates: Readonly<Record<NonNullable<SiteLogoStatus['candidate']>['status'], true>> = Object.freeze({
  pending: true,
  running: true,
  ready: true,
  failed: true
})

const errorCodes: Readonly<Record<SiteLogoErrorCode, true>> = Object.freeze({
  UNSUPPORTED_IMAGE: true,
  IMAGE_TOO_LARGE: true,
  INVALID_IMAGE: true,
  NO_VISIBLE_PIXELS: true,
  UNSUITABLE_LOGO: true,
  PROCESSING_FAILED: true,
  ARTIFACT_TOO_LARGE: true
})

const enhancementUnavailableReasons: Readonly<Record<SiteLogoEnhancementUnavailableReason, true>> = Object.freeze({
  UNSUITABLE_LOGO: true,
  ARTIFACT_TOO_LARGE: true,
  PROCESSING_FAILED: true
})

const logoPublicPattern = /^\/_site-logo\/[a-f0-9]{64}\/logo\.png$/
const iconPublicPattern = /^\/_site-logo\/[a-f0-9]{64}\/icon\.png$/
const faviconPublicPattern = /^\/_site-logo\/[a-f0-9]{64}\/favicon\.ico$/

export class SiteLogoApiError extends Error {
  readonly code: SiteLogoErrorCode | null

  constructor(code: SiteLogoErrorCode | null, message = 'Site logo request failed.') {
    super(message)
    this.name = 'SiteLogoApiError'
    this.code = code
  }
}

export function isSiteLogoErrorCode(value: unknown): value is SiteLogoErrorCode {
  return typeof value === 'string' && Object.hasOwn(errorCodes, value)
}

export function isSiteLogoAcceptedType(value: unknown): value is SiteLogoAcceptedType {
  return typeof value === 'string' && Object.hasOwn(acceptedContentTypes, value)
}

function parseIconDescriptor(value: unknown): LogoIconDescriptor {
  if (!isRecord(value)) throw new SiteLogoApiError(null)
  const favicon16Url = value.favicon16Url
  const favicon32Url = value.favicon32Url
  const tile150Url = value.tile150Url
  const apple180Url = value.apple180Url
  const app192Url = value.app192Url
  const app512Url = value.app512Url
  const maskable512Url = value.maskable512Url
  const faviconIcoUrl = value.faviconIcoUrl
  if (
    typeof favicon16Url !== 'string' ||
    !iconPublicPattern.test(favicon16Url) ||
    typeof favicon32Url !== 'string' ||
    !iconPublicPattern.test(favicon32Url) ||
    typeof tile150Url !== 'string' ||
    !iconPublicPattern.test(tile150Url) ||
    typeof apple180Url !== 'string' ||
    !iconPublicPattern.test(apple180Url) ||
    typeof app192Url !== 'string' ||
    !iconPublicPattern.test(app192Url) ||
    typeof app512Url !== 'string' ||
    !iconPublicPattern.test(app512Url) ||
    typeof maskable512Url !== 'string' ||
    !iconPublicPattern.test(maskable512Url) ||
    typeof faviconIcoUrl !== 'string' ||
    !faviconPublicPattern.test(faviconIcoUrl)
  ) {
    throw new SiteLogoApiError(null)
  }
  return Object.freeze({
    favicon16Url,
    favicon32Url,
    tile150Url,
    apple180Url,
    app192Url,
    app512Url,
    maskable512Url,
    faviconIcoUrl
  })
}

function parseEnhancement(value: unknown): SiteLogoEnhancementStatus {
  if (!isRecord(value) || (value.status !== 'ready' && value.status !== 'unavailable')) throw new SiteLogoApiError(null)
  if (value.status === 'ready') {
    if (value.reason !== null) throw new SiteLogoApiError(null)
    return Object.freeze({ status: 'ready', reason: null })
  }
  if (typeof value.reason !== 'string' || !isSiteLogoEnhancementUnavailableReason(value.reason)) throw new SiteLogoApiError(null)
  return Object.freeze({ status: 'unavailable', reason: value.reason })
}

function isSiteLogoEnhancementUnavailableReason(value: unknown): value is SiteLogoEnhancementUnavailableReason {
  return typeof value === 'string' && Object.hasOwn(enhancementUnavailableReasons, value)
}

function parseActive(value: unknown): SiteLogoActiveStatus | null {
  if (value === null) return null
  if (!isRecord(value) || typeof value.revisionId !== 'string' || typeof value.logoUrl !== 'string' || !logoPublicPattern.test(value.logoUrl)) {
    throw new SiteLogoApiError(null)
  }
  if (!Object.hasOwn(value, 'logoIcons') || !Object.hasOwn(value, 'enhancement')) throw new SiteLogoApiError(null)
  const logoIcons = value.logoIcons === null ? null : parseIconDescriptor(value.logoIcons)
  return Object.freeze({
    revisionId: value.revisionId,
    logoUrl: value.logoUrl,
    logoIcons,
    enhancement: parseEnhancement(value.enhancement)
  })
}

function parseCandidate(value: unknown): SiteLogoStatus['candidate'] {
  if (value === null) return null
  if (
    !isRecord(value) ||
    typeof value.revisionId !== 'string' ||
    typeof value.status !== 'string' ||
    !Object.hasOwn(candidateStates, value.status) ||
    !Object.hasOwn(value, 'errorCode') ||
    !(value.errorCode === null || isSiteLogoErrorCode(value.errorCode))
  ) {
    throw new SiteLogoApiError(null)
  }
  return Object.freeze({
    revisionId: value.revisionId,
    status: value.status as NonNullable<SiteLogoStatus['candidate']>['status'],
    errorCode: value.errorCode as SiteLogoErrorCode | null
  })
}

function parseStatus(payload: unknown): SiteLogoStatus {
  if (!isRecord(payload) || !Object.hasOwn(payload, 'active') || !Object.hasOwn(payload, 'candidate')) throw new SiteLogoApiError(null)
  const active = parseActive(payload.active)
  const candidate = parseCandidate(payload.candidate)
  if (Object.hasOwn(payload, 'statusUrl') && payload.statusUrl !== '/_api/site/logo') throw new SiteLogoApiError(null)
  const status: SiteLogoStatus = {
    active,
    candidate,
    ...(payload.statusUrl === undefined ? {} : { statusUrl: '/_api/site/logo' as const })
  }
  return Object.freeze(status)
}

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) return null
  return await response.json().catch(() => null)
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
