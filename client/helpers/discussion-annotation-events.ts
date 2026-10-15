import { createEventBus } from './simple-event-bus'
import type { DiscussionAnnotationAnchor } from '../../shared/discussion-annotations.ts'

const bus = createEventBus<[number, DiscussionAnnotationAnchor | number | undefined]>()
export function composeDiscussionAnnotation(pageId: number, anchor: DiscussionAnnotationAnchor): void {
  bus.emit('discussionCompose', pageId, anchor)
}
export function focusDiscussionThread(pageId: number, commentId: number): void {
  bus.emit('discussionThread', pageId, commentId)
}
export function discussionAnnotationsChanged(pageId: number): void {
  bus.emit('discussionChanged', pageId, undefined)
}
export function jumpDiscussionAnnotation(pageId: number, anchor: DiscussionAnnotationAnchor): void {
  bus.emit('discussionJump', pageId, anchor)
}
export function onComposeDiscussionAnnotation(handler: (pageId: number, anchor: DiscussionAnnotationAnchor) => void): () => void {
  const listener = (pageId: number, value: DiscussionAnnotationAnchor | number | undefined) => {
    if (value && typeof value === 'object') handler(pageId, value)
  }
  bus.on('discussionCompose', listener)
  return () => bus.off('discussionCompose', listener)
}
export function onFocusDiscussionThread(handler: (pageId: number, commentId: number) => void): () => void {
  const listener = (pageId: number, value: DiscussionAnnotationAnchor | number | undefined) => {
    if (typeof value === 'number') handler(pageId, value)
  }
  bus.on('discussionThread', listener)
  return () => bus.off('discussionThread', listener)
}
export function onDiscussionAnnotationsChanged(handler: (pageId: number) => void): () => void {
  bus.on('discussionChanged', handler)
  return () => bus.off('discussionChanged', handler)
}
export function onJumpDiscussionAnnotation(handler: (pageId: number, anchor: DiscussionAnnotationAnchor) => void): () => void {
  const listener = (pageId: number, value: DiscussionAnnotationAnchor | number | undefined) => {
    if (value && typeof value === 'object') handler(pageId, value)
  }
  bus.on('discussionJump', listener)
  return () => bus.off('discussionJump', listener)
}
