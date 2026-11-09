<template lang='pug'>
  v-dialog(
    v-model='isShown'
    max-width='1000'
    scrollable
    :persistent='loading'
    aria-labelledby='page-convert-dialog-title'
    aria-describedby='page-convert-dialog-description'
    @after-enter='focusEditor'
    @after-leave='restoreFocus'
    )
    v-card
      .dialog-header.is-short.is-dark
        v-icon.me-2(color='white') mdi-lightning-bolt
        span#page-convert-dialog-title {{$t('common:page.convert')}}
      v-card-text.pt-5
        localized-rich-text#page-convert-dialog-description.text-body-medium(path='common:page.convertTitle', tag='div')
          template(#title)
            strong {{pageTitle}}
        v-select.mt-5(
          ref='editorSelect'
          :items='editorOptions'
          variant="outlined"
          density="compact"
          hide-details
          :label='$t(`common:pageConvert.newEditor`)'
          v-model='newEditor'
          :disabled='loading'
        )
        v-alert.mt-5(
          color='warning'
          variant='tonal'
          density='compact'
        ) {{$t('common:page.convertSubtitle')}}
        v-alert.mt-4(v-if='needsReview && !committing && !commitMessage', type='info', variant='tonal')
          | HTML stays unchanged until you review a candidate and explicitly confirm. Cancel before confirmation to keep the original HTML editor.
        v-alert.mt-4(v-if='commitMessage', type='info', variant='tonal', role='status') {{commitMessage}}
        section.mt-5(v-if='review', aria-label='Conversion review', aria-live='polite')
          p Review expires at {{review.expiresAt}}. The original HTML will remain available in page history after confirmation.
          v-btn.mb-3(variant='outlined', @click='downloadOriginal') Download exact original HTML
          v-textarea(label='Exact original HTML', :model-value='review.originalSource', readonly, rows='5', variant='outlined')
          v-textarea(label='Candidate Markdown', :model-value='review.candidate', readonly, rows='7', variant='outlined')
          v-alert.mb-4(type='warning', variant='tonal')
            ul
              li(v-for='warning in review.report.warnings', :key='warning') {{warning}}
          p Native-render differences: {{differenceSummary}}
          p.text-body-small {{review.report.renderer}}
          v-textarea(label='Native render HTML (inert source; never executed in this dialog)', :model-value='review.report.previewHtml', readonly, rows='5', variant='outlined')
          v-textarea(label='Markdown → native render → Markdown roundtrip', :model-value='review.report.roundtripSource', readonly, rows='5', variant='outlined')
          v-checkbox(:model-value='reviewAccepted', @update:model-value='reviewAccepted = $event === true', :disabled='committing', label='I reviewed the original, candidate and loss report and accept this exact conversion.', hide-details)
      v-card-chin
        v-spacer
        v-btn(v-if='!committing', variant="text", @click='discard') {{loading ? 'Cancel conversion' : $t('common:actions.cancel')}}
        v-btn.px-4(
          color="warning"
          variant="flat"
          @click='convertPage'
          :loading='loading'
          :disabled='loading || !canConvert'
        ) {{committing ? 'Confirming conversion' : needsReview && !review ? 'Review conversion candidate' : needsReview ? 'Confirm reviewed conversion' : $t('common:actions.convert')}}
</template>

<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { convertPage, reviewPageConversion } from '../../helpers/pages-api'
import type { PageConversionReview } from '../../helpers/pages-api'
import { captureGovernanceFetch, governanceOwnerMatches } from '../../helpers/page-governance-api'
import LocalizedRichText from './localized-rich-text'

export default defineComponent({
  components: { LocalizedRichText },
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      loading: false,
      committing: false,
      commitMessage: '',
      conversionDisposed: false,
      newEditor: '',
      review: null as PageConversionReview | null,
      reviewAccepted: false,
      reviewAuthorityKey: null as string | null,
      convertAbortController: null as AbortController | null,
      returnFocusTarget: null as HTMLElement | null
    }
  },
  computed: {
    isShown: {
      get(): boolean { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    pageTitle(): string { return wikiStore.page.title },
    pagePath(): string { return wikiStore.page.path },
    pageLocale(): string { return wikiStore.page.locale },
    pageVisibility(): string { return wikiStore.page.visibility },
    pageId(): number { return wikiStore.page.id },
    pageEditor(): string { return wikiStore.page.editor },
    pageSourceRevision(): string { return wikiStore.page.sourceRevision },
    authorityKey(): string { return this.conversionAuthority() },
    editorOptions(): { value: string, title: string }[] { return markRaw([
      { value: 'markdown', title: this.$t('common:pageConvert.editorMarkdown') },
      { value: 'visual-markdown', title: this.$t('common:pageConvert.editorVisualMarkdown') },
      { value: 'ckeditor', title: this.$t('common:pageConvert.editorVisualHtml') },
      { value: 'code', title: this.$t('common:pageConvert.editorRawHtml') }
    ]) },
    needsReview(): boolean { return ['ckeditor', 'code'].includes(this.pageEditor) && ['markdown', 'visual-markdown'].includes(this.newEditor) },
    differenceSummary(): string {
      if (!this.review) return ''
      const changed = Object.entries(this.review.report.differences).filter(([, differs]) => differs).map(([category]) => category)
      return changed.length ? changed.join(', ') : 'No differences detected by the limited diagnostics; not a lossless guarantee.'
    },
    canConvert(): boolean {
      return Boolean(this.newEditor) && this.newEditor !== this.pageEditor && (!this.needsReview || !this.review || this.reviewAccepted === true)
    }
  },
  watch: {
    newEditor() { this.invalidateReview() },
    pageId: { flush: 'sync', handler() { this.invalidateReview() } },
    pageEditor: { flush: 'sync', handler() { this.invalidateReview() } },
    pageSourceRevision: { flush: 'sync', handler() { this.invalidateReview() } },
    authorityKey: { flush: 'sync', handler() { this.invalidateReview() } },
    isShown: {
      immediate: true,
      handler(newValue: boolean) {
        if (newValue) {
          const activeElement = document.activeElement
          const overlayId = activeElement instanceof HTMLElement
            ? activeElement.closest<HTMLElement>('.v-overlay__content')?.id
            : undefined
          let overlayActivator: HTMLElement | null = null
          if (overlayId) {
            for (const candidate of document.querySelectorAll<HTMLElement>('[aria-controls]')) {
              if (candidate.getAttribute('aria-controls') === overlayId) {
                overlayActivator = candidate
                break
              }
            }
          }
          this.returnFocusTarget = overlayActivator ?? (activeElement instanceof HTMLElement ? activeElement : null)
          this.newEditor = this.pageEditor
        }
        if (!newValue) this.invalidateReview()
      }
    }
  },
  beforeUnmount() {
    this.conversionDisposed = true
    this.invalidateReview()
    this.returnFocusTarget = null
  },
  methods: {
    conversionAuthority(): string {
      return JSON.stringify([wikiStore.user.id, wikiStore.user.authVersion, wikiStore.offlineIdentityEpoch,
        wikiStore.authRefreshOutcome, wikiStore.authRefreshPending, wikiStore.user.permissions,
        window.siteConfig.agentCsrfToken, wikiStore.authRefreshSettled])
    },
    invalidateReview(): void {
      if (!this.committing) {
        this.convertAbortController?.abort()
        this.commitMessage = ''
      }
      this.review = null
      this.reviewAuthorityKey = null
      this.reviewAccepted = false
    },
    downloadOriginal(): void {
      if (!this.review) return
      const url = URL.createObjectURL(new Blob([this.review.originalSource], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `page-${this.review.pageId}-revision-${this.review.sourceRevision}-original.html`
      link.click()
      URL.revokeObjectURL(url)
    },
    focusEditor(): void {
      const select = this.$refs.editorSelect as { focus?: () => void } | undefined
      select?.focus?.()
    },
    restoreFocus(): void {
      const target = this.returnFocusTarget
      this.returnFocusTarget = null
      if (target?.isConnected && target.getClientRects().length > 0 && !target.matches(':disabled')) {
        target.focus({ preventScroll: true })
      }
    },
    discard(): void {
      if (this.committing) return
      this.invalidateReview()
      this.isShown = false
    },
    async convertPage(): Promise<void> {
      if (!this.canConvert || this.loading) return

      const controller = new AbortController()
      this.convertAbortController = controller
      this.loading = true
      this.commitMessage = ''
      wikiStore.startLoading('page-convert')
      const authorityKey = this.conversionAuthority()
      try {
        const reviewed = this.review
        const csrfToken = window.siteConfig.agentCsrfToken
        if (typeof csrfToken !== 'string' || !csrfToken || !governanceOwnerMatches(authorityKey) ||
          (reviewed && this.reviewAuthorityKey !== authorityKey)) {
          throw new Error('The browser session changed. Review the current source again.')
        }
        const ownedFetch = captureGovernanceFetch(window.fetch.bind(window), authorityKey)
        const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
          if (this.conversionAuthority() !== authorityKey) throw new Error('The browser session changed. Review the current source again.')
          const headers = new Headers(init?.headers)
          headers.set('X-Wiki-Csrf', csrfToken)
          const response = await ownedFetch(url, { ...init, headers, signal: controller.signal })
          if (this.conversionAuthority() !== authorityKey) throw new Error('The browser session changed. Review the current source again.')
          return response
        }
        const editor = this.newEditor
        const revision = this.pageSourceRevision
        const id = this.pageId
        const requiresReview = this.needsReview
        if (requiresReview && reviewed && (reviewed.pageId !== id || reviewed.sourceRevision !== revision || reviewed.editor !== editor || Date.parse(reviewed.expiresAt) <= Date.now())) {
          throw new Error('The review is stale. Review the current source again.')
        }
        if (requiresReview && !reviewed) {
          const candidate = await reviewPageConversion(fetchImpl, id, editor, revision)
          if (controller.signal.aborted || this.convertAbortController !== controller || id !== this.pageId || revision !== this.pageSourceRevision || editor !== this.newEditor || authorityKey !== this.conversionAuthority() || !governanceOwnerMatches(authorityKey)) return
          this.review = candidate
          this.reviewAuthorityKey = authorityKey
          this.reviewAccepted = false
          return
        }
        this.committing = true
        this.commitMessage = 'Confirmation submitted. It cannot be cancelled. Leaving this page does not undo the conversion.'
        await convertPage(fetchImpl, id, editor, revision, reviewed?.reviewToken)
        this.commitMessage = 'The submitted conversion completed. Reload the page to see its current editor.'
        if (this.conversionDisposed || !this.isShown || id !== this.pageId || revision !== this.pageSourceRevision || editor !== this.newEditor) {
          if (authorityKey === this.conversionAuthority() && governanceOwnerMatches(authorityKey)) {
            wikiStore.showNotification({ message: this.commitMessage, style: 'success', icon: 'check' })
          }
          return
        }
        if (authorityKey !== this.conversionAuthority() || !governanceOwnerMatches(authorityKey)) return
        this.returnFocusTarget = null
        this.isShown = false
        const scope = this.pageVisibility === 'private' ? '/_private' : ''
        window.location.assign(`/e${scope}/${this.pageLocale}/${this.pagePath}`)
      } catch (err) {
        if (this.convertAbortController === controller && !controller.signal.aborted) {
          if (this.committing) {
            const rejected = err instanceof Error && 'status' in err && typeof err.status === 'number' && err.status >= 400 && err.status < 500
            this.commitMessage = rejected && authorityKey === this.conversionAuthority()
              ? err.message
              : 'The submitted conversion outcome could not be confirmed. It may have completed. Reload with current access before trying again.'
            if (authorityKey === this.conversionAuthority() && governanceOwnerMatches(authorityKey)) {
              wikiStore.showError(this.commitMessage)
            }
          } else if (!this.conversionDisposed) {
            wikiStore.showError(err)
          }
          this.review = null
          this.reviewAuthorityKey = null
          this.reviewAccepted = false
        }
      } finally {
        wikiStore.stopLoading('page-convert')
        if (this.convertAbortController === controller) {
          this.convertAbortController = null
          this.loading = false
          this.committing = false
          if (this.isShown && !this.conversionDisposed) {
            await this.$nextTick()
            this.focusEditor()
          }
        }
      }
    }
  }
})
</script>
