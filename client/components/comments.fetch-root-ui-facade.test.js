const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, 'comments.vue')
const source = fs.readFileSync(sourcePath, 'utf8')

function extractScript (vueSource) {
  const match = vueSource.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) {
    throw new Error('comments.vue script block not found')
  }
  return match[1]
}

function extractMethod (script, methodName) {
  const methodStart = script.indexOf(`    async ${methodName} (`)
  if (methodStart === -1) {
    throw new Error(`${methodName} method not found`)
  }

  const nextMethod = script.indexOf('\n    /**', methodStart + 1)
  if (nextMethod === -1) {
    return script.slice(methodStart)
  }
  return script.slice(methodStart, nextMethod)
}

const script = extractScript(source)
const fetchMethod = extractMethod(script, 'fetch')

describe('comments fetch root UI facade guard', () => {
  test('imports showNotification helper', () => {
    expect(script).toContain("import { showNotification } from '../helpers/root-ui-store'")
  })

  test('routes non-silent fetch errors through root UI facade', () => {
    expect(fetchMethod).toContain('async fetch (silent = false)')
    expect(fetchMethod).toContain('this.isLoading = true')
    expect(fetchMethod).toContain('this.$apollo.query({')
    expect(fetchMethod).toContain("locale: this.$store.get('page/locale')")
    expect(fetchMethod).toContain("path: this.$store.get('page/path')")
    expect(fetchMethod).toContain("fetchPolicy: 'network-only'")
    expect(fetchMethod).toContain("_.get(results, 'data.comments.list', [])")
    expect(fetchMethod).toContain("c.authorName.toUpperCase().split(' ')")
    expect(fetchMethod).toContain('if (!silent) {')
    expect(fetchMethod).toContain('showNotification(this.$store, {')
    expect(fetchMethod).toContain("style: 'red'")
    expect(fetchMethod).toContain('message: err.message')
    expect(fetchMethod).toContain("icon: 'alert'")
    expect(fetchMethod).toContain('this.isLoading = false')
    expect(fetchMethod).toContain('this.hasLoadedOnce = true')
    expect(fetchMethod).not.toMatch(/this\.\$store\.commit\(['"]showNotification['"]/)
  })

  test('keeps comment mutation methods out of this tiny migration scope', () => {
    expect(script).toContain('async postComment ()')
    expect(script).toContain('async editComment (cm)')
    expect(script).toContain('async updateComment ()')
    expect(script).toContain('async deleteComment ()')
    expect(script).toContain("this.$store.commit('showNotification', {")
    expect(script).toContain("this.$store.commit(`loadingStart`, 'comments-edit')")
    expect(script).toContain("this.$store.commit(`loadingStop`, 'comments-delete')")
  })

  test('preserves intersection-triggered silent fetch and template markers', () => {
    expect(script).toContain('this.fetch(true)')
    expect(source).toContain("div(v-intersect.once='onIntersect')")
    expect(source).toContain("v-btn(color='red', dark, @click='deleteComment')")
    expect(source).toContain('v-textarea#discussion-new(')
  })
})
