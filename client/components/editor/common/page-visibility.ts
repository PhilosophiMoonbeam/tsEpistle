import { publicationBoundaryTimestamp } from '../../../../shared/publication-window.ts'

// One answer to "who can see this page?" for the Properties dialog and the
// editor header. Mirrors the reader check in server/controllers/common.ts:
// unpublished or out-of-window pages are visible only to people who can edit.

export type PageVisibilityInput = {
  readonly visibility: string
  readonly isPublished: boolean
  readonly publishStartDate?: string | null
  readonly publishEndDate?: string | null
}

export type PageVisibilityState = 'private' | 'unpublished' | 'scheduled' | 'expired' | 'published' | 'publishedUntil'

export type PageVisibilitySummary = {
  readonly state: PageVisibilityState
  /** editor:props.visibility* sentence key. */
  readonly summaryKey: string
  /** Short chip label key, or null for the ordinary published state. */
  readonly chipKey: string | null
  readonly icon: string
  readonly values: Readonly<Record<string, string>>
}

const formatDate = (date: Date, locale?: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
  } catch {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
  }
}

export const describePageVisibility = (input: PageVisibilityInput, now = new Date(), locale?: string): PageVisibilitySummary => {
  if (input.visibility === 'private') {
    return {
      state: 'private',
      summaryKey: 'editor:props.visibilityPrivate',
      chipKey: 'editor:props.visibilityChipPrivate',
      icon: 'mdi-lock-outline',
      values: {}
    }
  }
  if (!input.isPublished) {
    return {
      state: 'unpublished',
      summaryKey: 'editor:props.visibilityUnpublished',
      chipKey: 'editor:props.visibilityChipUnpublished',
      icon: 'mdi-eye-off-outline',
      values: {}
    }
  }
  const startTimestamp = publicationBoundaryTimestamp(input.publishStartDate)
  const endTimestamp = publicationBoundaryTimestamp(input.publishEndDate)
  if ((startTimestamp !== null && !Number.isFinite(startTimestamp)) || (endTimestamp !== null && !Number.isFinite(endTimestamp))) {
    return {
      state: 'unpublished',
      summaryKey: 'editor:props.visibilityUnpublished',
      chipKey: 'editor:props.visibilityChipUnpublished',
      icon: 'mdi-eye-off-outline',
      values: {}
    }
  }
  const start = startTimestamp === null ? null : new Date(startTimestamp)
  const end = endTimestamp === null ? null : new Date(endTimestamp)
  if (end && end.getTime() < now.getTime()) {
    return {
      state: 'expired',
      summaryKey: 'editor:props.visibilityExpired',
      chipKey: 'editor:props.visibilityChipExpired',
      icon: 'mdi-calendar-remove-outline',
      values: { end: formatDate(end, locale) }
    }
  }
  if (start && start.getTime() > now.getTime()) {
    return {
      state: 'scheduled',
      summaryKey: end ? 'editor:props.visibilityScheduledUntil' : 'editor:props.visibilityScheduled',
      chipKey: 'editor:props.visibilityChipScheduled',
      icon: 'mdi-calendar-clock-outline',
      values: end ? { start: formatDate(start, locale), end: formatDate(end, locale) } : { start: formatDate(start, locale) }
    }
  }
  if (end) {
    return {
      state: 'publishedUntil',
      summaryKey: 'editor:props.visibilityPublishedUntil',
      chipKey: null,
      icon: 'mdi-earth',
      values: { end: formatDate(end, locale) }
    }
  }
  return { state: 'published', summaryKey: 'editor:props.visibilityPublished', chipKey: null, icon: 'mdi-earth', values: {} }
}
