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

  test('preserves silent inline fetch errors, whitespace-safe initials, and intersection loading', () => {
    expect(script).toContain('async fetch (silent = false)')
    expect(script).toMatch(
      /const nameParts = comment\.authorName\.trim\(\)\.toUpperCase\(\)\.split\(\/\\s\+\/\)\s*const firstInitial = nameParts\[0\]\?\.charAt\(0\) \?\? ''\s*const lastInitial = nameParts\.length > 1 \? nameParts\[nameParts\.length - 1\]\?\.charAt\(0\) \?\? '' : ''[\s\S]*initials: firstInitial \+ lastInitial/
    )
    expect(script).toMatch(/this\.fetchError = getErrorMessage\(err\)\s*if \(!silent\) \{\s*showNotification\(wikiStore, \{/)
    expect(source).toContain("v-if='isLoading && (!hasLoadedOnce || comments.length === 0)'")
    expect(source).toContain("v-else-if='fetchError'")
    expect(script).toMatch(
      /onIntersect \(isIntersecting: boolean, _entries: IntersectionObserverEntry\[\], _observer: IntersectionObserver\): void \{\s*if \(!isIntersecting\) return\s*this\.hasIntersected = true\s*void this\.fetch\(true\)/
    )
    expect(script).toMatch(/finally \{\s*if \(requestId === this\.fetchGeneration\) \{[\s\S]*this\.isLoading = false\s*this\.hasLoadedOnce = true/)
  })
})
