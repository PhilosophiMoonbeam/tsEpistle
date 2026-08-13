const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, 'comments.vue'), 'utf8')
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]

describe('comments REST migration guard', () => {
  test('fetches and mutates comments through REST helpers', () => {
    expect(script).toContain("import { createComment, deleteComment, fetchComment, fetchComments, updateComment } from '../helpers/comments-api'")
    expect(script).toContain('const comments = await fetchComments(')
    expect(script).toContain('const response = await createComment(window.fetch.bind(window), {')
    expect(script).toContain('const response = await updateComment(')
    expect(script).toContain('await deleteComment(window.fetch.bind(window), this.commentToDelete.id)')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves silent fetch errors, initials, and intersection loading', () => {
    expect(script).toContain('async fetch (silent = false)')
    expect(script).toContain("c.authorName.toUpperCase().split(' ')")
    expect(script).toContain('if (!silent) {')
    expect(script).toContain('showNotification(this.$store, {')
    expect(script).toContain('this.hasLoadedOnce = true')
    expect(script).toContain('this.fetch(true)')
  })
})
