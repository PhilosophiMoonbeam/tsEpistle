import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/comments.vue'), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]

describe('comments REST migration guard', () => {
  test('fetches and mutates comments through REST helpers', () => {
    expect(script).toContain("import { createComment, deleteComment, fetchComment, fetchComments, updateComment } from '../helpers/comments-api'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain('export default defineComponent({')
    expect(script).toContain('const comments = await fetchComments(')
    expect(script).toContain('const response = await createComment(window.fetch.bind(window), {')
    expect(script).toContain('const response = await updateComment(')
    expect(script).toContain('await deleteComment(window.fetch.bind(window), commentToDelete.id)')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves silent fetch errors, initials, and intersection loading', () => {
    expect(script).toContain('async fetch (silent = false)')
    expect(script).toContain("comment.authorName.toUpperCase().split(' ')")
    expect(script).toContain('if (!silent) {')
    expect(script).toContain('showNotification(wikiStore, {')
    expect(script).toContain('onIntersect (isIntersecting: boolean, _entries: IntersectionObserverEntry[], _observer: IntersectionObserver): void')
    expect(script).toContain('this.hasLoadedOnce = true')
    expect(script).toContain('this.fetch(true)')
  })
})
