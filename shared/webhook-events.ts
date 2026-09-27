/** Event names emitted by the page, approval, and discussion outbox producers. */
export const WEBHOOK_EVENTS = [
  { name: 'page.created', title: 'Page created', description: 'A new page was added.', group: 'Pages' },
  { name: 'page.updated', title: 'Page updated', description: 'Content or page settings changed.', group: 'Pages' },
  { name: 'page.deleted', title: 'Page deleted', description: 'A page was removed.', group: 'Pages' },
  { name: 'page.moved', title: 'Page moved', description: 'A page path or language changed.', group: 'Pages' },
  { name: 'page.restored', title: 'Revision restored', description: 'A previous revision was restored.', group: 'Pages' },
  { name: 'page.visibility-changed', title: 'Visibility changed', description: 'A page changed between public and private.', group: 'Pages' },
  { name: 'page.ownership-transferred', title: 'Ownership transferred', description: 'A private page changed owner.', group: 'Pages' },
  { name: 'approval.submitted', title: 'Review submitted', description: 'A page entered the approval workflow.', group: 'Reviews' },
  { name: 'approval.approve', title: 'Review approved', description: 'A reviewer approved a revision.', group: 'Reviews' },
  { name: 'approval.reject', title: 'Review rejected', description: 'A reviewer rejected a revision.', group: 'Reviews' },
  { name: 'approval.requestchanges', title: 'Changes requested', description: 'A reviewer requested changes.', group: 'Reviews' },
  { name: 'approval.resubmit', title: 'Review resubmitted', description: 'A revised page was submitted again.', group: 'Reviews' },
  { name: 'approval.cancel', title: 'Review cancelled', description: 'An approval request was cancelled.', group: 'Reviews' },
  { name: 'approval.reassign', title: 'Reviewer reassigned', description: 'A review was assigned to another person.', group: 'Reviews' },
  { name: 'approval.publish', title: 'Review published', description: 'An approved revision was published.', group: 'Reviews' },
  { name: 'comment.created', title: 'Comment created', description: 'A public comment was created. Subscribe to this exact name; * does not include comment events.', group: 'Comments' },
  { name: 'comment.updated', title: 'Comment updated', description: 'A public comment was updated. Subscribe to this exact name; * does not include comment events.', group: 'Comments' },
  { name: 'comment.deleted', title: 'Comment deleted', description: 'A public comment was deleted. Subscribe to this exact name; * does not include comment events.', group: 'Comments' }
] as const
export const COMMENT_WEBHOOK_ACTIONS = ['created', 'updated', 'deleted'] as const
export type CommentWebhookAction = typeof COMMENT_WEBHOOK_ACTIONS[number]
export type CommentWebhookEventName = `comment.${CommentWebhookAction}`

export const isCommentWebhookEventName = (value: string): value is CommentWebhookEventName =>
  COMMENT_WEBHOOK_ACTIONS.some(action => value === `comment.${action}`)

export const isWebhookEventName = (value: string): boolean =>
  value.length <= 128 && /^(\*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*)$/.test(value)
