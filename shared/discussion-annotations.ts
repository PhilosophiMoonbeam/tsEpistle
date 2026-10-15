export interface DiscussionAnnotationAnchor {
  exact: string
  prefix: string
  suffix: string
  heading: string | null
  offset: number
}

export interface DiscussionAnnotationInput {
  anchor: DiscussionAnnotationAnchor
  note: string
}

export interface DiscussionAnnotation extends DiscussionAnnotationInput {
  id: number
  commentId: number
  position: number
  revision: number
  resolvedAt: string | null
  resolvedById: number | null
  createdAt: string
  updatedAt: string
}

export interface DiscussionAnnotationStateInput {
  expectedRevision: number
  resolved: boolean
}

export interface DiscussionContribution {
  id: number
  replyTo: number
  content: string
  render: string
  createdAt: string
  updatedAt: string
  annotations: DiscussionAnnotation[]
  page: { id: number; title: string; path: string; locale: string; visibility: 'public' | 'private'; url: string }
}

export interface MyDiscussionsPage {
  items: DiscussionContribution[]
  nextCursor: string | null
}

/** Bounded, currently authorized reader projection; continuation is an annotation ID, never a total. */
export interface DiscussionPageAnnotations {
  items: DiscussionAnnotation[]
  nextAfter: number | null
}
