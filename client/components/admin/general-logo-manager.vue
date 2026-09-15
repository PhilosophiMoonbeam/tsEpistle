<template lang='pug'>
.general-logo-workflow
  p.general-logo-note {{ $t('admin:general.logoWorkflowNote') }}
  .logo-manager
    .logo-preview-grid
      .logo-preview-card
        .logo-preview-heading {{ $t('admin:general.logoActive') }}
        .logo-preview-frame
          v-img(
            v-if='activeLogoUrl'
            :src='activeLogoUrl'
            :alt='$t(`admin:general.logoActivePreviewAlt`)'
            :cover='false'
          )
          v-icon(v-else size='42' color='grey' aria-hidden='true') mdi-image-off-outline
        .logo-preview-status(v-if='activeLogoUrl')
          v-chip(
            color='success'
            variant='tonal'
            size='small'
          ) {{ $t('admin:general.logoStatusActive') }}
        p.logo-preview-empty(v-else) {{ $t('admin:general.logoNoActive') }}
      .logo-preview-card.logo-preview-card--candidate(
        v-if='candidateVisible'
        :aria-busy='candidateIsProcessing ? "true" : "false"'
        aria-describedby='logo-candidate-status'
      )
        .logo-preview-heading {{ $t('admin:general.logoCandidate') }}
        .logo-preview-frame(:class='`logo-preview-frame--${previewBackground}`')
          v-img(
            v-if='candidatePreviewUrl'
            :src='candidatePreviewUrl'
            :alt='$t(`admin:general.logoCandidatePreviewAlt`)'
            :cover='false'
          )
          v-icon(v-else size='42' color='grey' aria-hidden='true') mdi-image-sync-outline
        .logo-candidate-status-line
          v-progress-circular(
            v-if='candidateIsProcessing'
            indeterminate
            size='16'
            width='2'
            color='primary'
            aria-hidden='true'
          )
          span(aria-hidden='true') {{ $t(candidateStatusKey) }}
        p#logo-candidate-status.logo-status-supporting(v-if='candidateStatusSupportingKey') {{ $t(candidateStatusSupportingKey) }}
        .logo-candidate-actions
          v-btn(
            v-if='uploadInterrupted'
            color='primary'
            variant='tonal'
            size='small'
            :disabled='disabled || logoUploading || logoRetrying || !selectedFile'
            @click='retryUpload'
          )
            v-icon(start) mdi-upload
            | {{ $t('admin:general.logoRetryUpload') }}
          v-btn(
            v-if='statusUnavailable'
            color='primary'
            variant='tonal'
            size='small'
            :loading='logoStatusChecking'
            :disabled='disabled || logoUploading || logoRetrying'
            @click='checkAgain'
          )
            v-icon(start) mdi-refresh
            | {{ $t('admin:general.logoCheckAgain') }}
          v-btn(
            v-if='candidateHasFailed && !candidateFailureIsSource'
            color='primary'
            variant='tonal'
            size='small'
            :loading='logoRetrying'
            :disabled='disabled || logoUploading || logoRetrying || confirming'
            @click='retryLogo'
          )
            v-icon(start) mdi-refresh
            | {{ $t('admin:general.logoRetry') }}
          v-btn(
            v-if='candidateHasFailed || uploadInterrupted'
            variant='text'
            size='small'
            :disabled='disabled || logoUploading || logoRetrying'
            @click='chooseAnother'
          ) {{ $t('admin:general.logoChooseAnotherImage') }}
    input.logo-file-input(
      ref='logoFileInput'
      type='file'
      tabindex='-1'
      :aria-label='$t(`admin:general.logoPickerLabel`)'
      :aria-describedby='pickerDescribedBy'
      accept='image/png,image/jpeg,image/webp'
      :disabled='disabled || logoRetrying || confirming'
      @change='onLogoFileChange'
      @click.stop
    )
    .logo-drop-target(
      ref='logoDropTarget'
      :class='{ "logo-drop-target--active": logoDragActive, "logo-drop-target--disabled": disabled || logoRetrying || confirming }'
      role='button'
      tabindex='0'
      :aria-label='$t(`admin:general.logoPickerLabel`)'
      :aria-describedby='pickerDescribedBy'
      :aria-disabled='disabled || logoRetrying || confirming'
      @click='openLogoPicker'
      @keydown.enter.prevent='openLogoPicker'
      @keydown.space.prevent='openLogoPicker'
      @dragenter.prevent='onLogoDragEnter'
      @dragover.prevent
      @dragleave.prevent='onLogoDragLeave'
      @drop.prevent='onLogoDrop'
    )
      v-icon.logo-drop-icon(size='34' aria-hidden='true') mdi-image-plus-outline
      .logo-drop-copy
        .text-body-large.font-weight-medium {{ $t(pickerTitleKey) }}
        .text-body-small.text-medium-emphasis {{ $t(pickerHintKey) }}
    p#logo-picker-help.logo-picker-help.text-body-small.text-medium-emphasis {{ $t('admin:general.logoPickerHelp') }}
    .logo-message.logo-message--error(
      v-if='logoErrorKey'
      id='logo-picker-error'
      role='alert'
    )
      span {{ $t(logoErrorKey) }}
      v-btn.logo-error-action(
        v-if='uploadInterrupted'
        variant='text'
        size='small'
        :disabled='disabled || logoUploading || logoRetrying || !selectedFile'
        @click='retryUpload'
      ) {{ $t('admin:general.logoRetryUpload') }}
      v-btn.logo-error-action(
        v-else-if='candidateHasFailed'
        variant='text'
        size='small'
        :disabled='disabled || logoUploading || logoRetrying'
        @click='chooseAnother'
      ) {{ $t('admin:general.logoChooseAnotherImage') }}
    p.logo-status(
      role='status'
      aria-live='polite'
      :aria-busy='candidateIsProcessing ? "true" : "false"'
    ) {{ $t(candidateStatusKey) }}
    p.logo-disclosure.text-body-small.text-medium-emphasis
      v-icon.mr-2(size='18' aria-hidden='true') mdi-earth
      | {{ $t('admin:general.logoPublicUsage') }}
  v-dialog(
    v-model='confirming'
    max-width='560'
    :persistent='logoUploading'
    aria-labelledby='general-logo-review-title'
  )
    v-card.general-logo-review
      v-card-title#general-logo-review-title(
        ref='reviewHeading'
        tabindex='-1'
      ) {{ $t('admin:general.logoReviewTitle') }}
      v-card-text
        .general-logo-selection-frame(:class='`general-logo-selection-frame--${previewBackground}`')
          img.general-logo-selection(
            v-if='candidatePreviewUrl'
            :src='candidatePreviewUrl'
            :alt='$t(`admin:general.logoSelectionPreviewAlt`)'
          )
        .logo-background-control(
          role='group'
          :aria-label='$t(`admin:general.logoPreviewBackground`)'
        )
          span.logo-background-label {{ $t('admin:general.logoPreviewBackground') }}
          .logo-background-options
            button.logo-background-option(
              v-for='option in previewBackgroundOptions'
              :key='option.value'
              type='button'
              :class='`logo-background-option--${option.value}`'
              :aria-pressed='previewBackground === option.value ? "true" : "false"'
              @click='previewBackground = option.value'
            ) {{ $t(option.labelKey) }}
        p.logo-file-details(v-if='selectedFile') {{ selectedFileDetails }}
        p.logo-review-copy {{ $t('admin:general.logoReviewCopy') }}
      v-card-actions
        v-btn(
          variant='text'
          :disabled='logoUploading'
          @click='cancelSelection'
        ) {{ $t('admin:general.logoCancel') }}
        v-spacer
        v-btn(
          variant='text'
          :disabled='logoUploading || logoRetrying'
          @click='chooseAnother'
        ) {{ $t('admin:general.logoChooseAnother') }}
        v-btn(
          color='primary'
          variant='flat'
          :disabled='disabled || !selectedFile || logoUploading || logoRetrying'
          @click='publishSelected'
        ) {{ $t('admin:general.logoUseThisLogo') }}
</template>
<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import {
  fetchSiteLogoStatus,
  retrySiteLogo,
  SiteLogoApiError,
  uploadSiteLogo
} from '../../helpers/site-logo-api'
import {
  SITE_LOGO_SOURCE_BYTE_LIMIT,
  type LogoIconDescriptor,
  type SiteLogoErrorCode,
  type SiteLogoStatus
} from '../../../shared/site-logo.ts'

const logoErrorMessageKeys: Record<SiteLogoErrorCode, string> = {
  UNSUPPORTED_IMAGE: 'admin:general.logoErrorUnsupported',
  IMAGE_TOO_LARGE: 'admin:general.logoErrorTooLarge',
  INVALID_IMAGE: 'admin:general.logoErrorInvalid',
  NO_VISIBLE_PIXELS: 'admin:general.logoErrorNoVisiblePixels',
  UNSUITABLE_LOGO: 'admin:general.logoErrorProcessing',
  PROCESSING_FAILED: 'admin:general.logoErrorProcessing',
  ARTIFACT_TOO_LARGE: 'admin:general.logoErrorProcessing'
}

const sourceFailureCodes: Readonly<Partial<Record<SiteLogoErrorCode, true>>> = Object.freeze({
  UNSUPPORTED_IMAGE: true,
  IMAGE_TOO_LARGE: true,
  INVALID_IMAGE: true,
  NO_VISIBLE_PIXELS: true
})

const pollDelays = [1500, 3000, 6000] as const
const maxPollFailures = pollDelays.length

type PreviewBackground = 'light' | 'dark' | 'transparency'
type SelectionDimensions = { width: number; height: number }
type IconLinkKey = 'favicon16' | 'favicon32' | 'apple180' | 'app192' | 'app512' | 'faviconIco'
const iconLinkFieldByKey: Readonly<Record<IconLinkKey, keyof LogoIconDescriptor>> = Object.freeze({
  favicon16: 'favicon16Url',
  favicon32: 'favicon32Url',
  apple180: 'apple180Url',
  app192: 'app192Url',
  app512: 'app512Url',
  faviconIco: 'faviconIcoUrl'
})

export default {
  props: { disabled: Boolean },
  data() {
    return {
      logoStatus: null as SiteLogoStatus | null,
      logoUploading: false,
      logoRetrying: false,
      logoStatusChecking: false,
      logoDragActive: false,
      logoDragDepth: 0,
      logoErrorKey: null as string | null,
      logoStatusUnavailable: false,
      logoPollFailures: 0,
      candidatePreviewUrl: '',
      logoPollTimer: null as number | null,
      logoRequestId: 0,
      logoRequestController: null as AbortController | null,
      logoDisposed: false,
      selectedFile: null as File | null,
      selectedDimensions: null as SelectionDimensions | null,
      selectionVersion: 0,
      submittedSelectionVersion: null as number | null,
      submittedRevisionId: null as string | null,
      trackedCandidateRevisionId: null as string | null,
      publishedNoticeKey: null as string | null,
      confirming: false,
      previewBackground: 'transparency' as PreviewBackground,
      coarsePointer: false
    }
  },
  computed: {
    activeLogoUrl() {
      return this.logoStatus?.active?.logoUrl || wikiStore.site.logoUrl || ''
    },
    activeLogoIcons() {
      return this.logoStatus?.active?.logoIcons || null
    },
    candidateVisible() {
      return Boolean(
        this.logoUploading ||
        this.logoStatusUnavailable ||
        this.selectedFile ||
        this.candidatePreviewUrl ||
        this.logoErrorKey ||
        this.publishedNoticeKey ||
        (this.logoStatus?.candidate && this.logoStatus.candidate.status !== 'ready')
      )
    },
    candidateIsProcessing() {
      const status = this.logoStatus?.candidate?.status
      return this.logoUploading || this.logoRetrying || status === 'pending' || status === 'running'
    },
    candidateHasFailed() {
      return this.logoStatus?.candidate?.status === 'failed'
    },
    candidateFailureIsSource() {
      const code = this.logoStatus?.candidate?.errorCode
      return Boolean(code && Object.hasOwn(sourceFailureCodes, code))
    },
    uploadInterrupted() {
      return this.logoErrorKey === 'admin:general.logoErrorUploadInterrupted'
    },
    statusUnavailable() {
      return this.logoStatusUnavailable
    },
    candidateStatusKey() {
      if (this.logoUploading) return 'admin:general.logoStatusUploading'
      if (this.confirming && this.selectedFile) return 'admin:general.logoStatusReview'
      if (this.logoStatusUnavailable) return 'admin:general.logoStatusUnavailable'
      if (this.logoRetrying || this.logoStatus?.candidate?.status === 'pending' || this.logoStatus?.candidate?.status === 'running') {
        return 'admin:general.logoStatusPreparing'
      }
      if (this.publishedNoticeKey) return this.publishedNoticeKey
      if (this.uploadInterrupted) return 'admin:general.logoStatusUploadInterrupted'
      if (this.candidateHasFailed) {
        return this.candidateFailureIsSource
          ? 'admin:general.logoStatusSourceFailure'
          : 'admin:general.logoStatusProcessingFailed'
      }
      if (this.logoErrorKey) return 'admin:general.logoStatusSourceFailure'
      if (this.selectedFile) return 'admin:general.logoStatusReview'
      return 'admin:general.logoStatusIdle'
    },
    candidateStatusSupportingKey() {
      if (this.logoStatusUnavailable) return 'admin:general.logoStatusUnavailableHint'
      if (this.logoRetrying || this.logoStatus?.candidate?.status === 'pending' || this.logoStatus?.candidate?.status === 'running') {
        return 'admin:general.logoStatusPreparingHint'
      }
      if (this.publishedNoticeKey === 'admin:general.logoStatusPublishedWithoutAnimation') {
        return 'admin:general.logoStatusPublishedWithoutAnimationHint'
      }
      if (this.publishedNoticeKey === 'admin:general.logoStatusPublished') return 'admin:general.logoStatusPublishedHint'
      return null
    },
    candidateStatusColor() {
      if (this.logoStatusUnavailable) return 'warning'
      if (this.logoErrorKey || this.candidateHasFailed) return 'error'
      if (this.publishedNoticeKey) return 'success'
      return 'info'
    },
    pickerTitleKey() {
      return this.coarsePointer ? 'admin:general.logoPickerTitleCoarse' : 'admin:general.logoPickerTitle'
    },
    pickerHintKey() {
      return this.coarsePointer ? 'admin:general.logoPickerHintCoarse' : 'admin:general.logoPickerHint'
    },
    pickerDescribedBy() {
      return this.logoErrorKey ? 'logo-picker-help logo-picker-error' : 'logo-picker-help'
    },
    previewBackgroundOptions() {
      return [
        { value: 'light' as const, labelKey: 'admin:general.logoPreviewLight' },
        { value: 'dark' as const, labelKey: 'admin:general.logoPreviewDark' },
        { value: 'transparency' as const, labelKey: 'admin:general.logoPreviewTransparency' }
      ]
    },
    selectedFileDetails() {
      if (!this.selectedFile) return ''
      const dimensions = this.selectedDimensions
        ? `${this.selectedDimensions.width} × ${this.selectedDimensions.height}`
        : this.$t('admin:general.logoDimensionsUnavailable')
      const bytes = this.selectedFile.size.toLocaleString()
      return this.$t('admin:general.logoFileDetails', {
        filename: this.selectedFile.name,
        dimensions,
        bytes
      })
    }
  },
  watch: {
    confirming(value: boolean) {
      if (value) {
        this.$nextTick?.(() => this.focusReviewHeading())
      } else if (!this.logoUploading && this.selectedFile) {
        this.dismissSelection(false)
      } else if (!value) {
        this.$nextTick?.(() => this.focusPickerTarget())
      }
    }
  },
  methods: {
    focusReviewHeading() {
      const heading = this.$refs?.reviewHeading as HTMLElement | undefined
      heading?.focus?.()
    },
    focusPickerTarget() {
      const target = this.$refs?.logoDropTarget as HTMLElement | undefined
      target?.focus?.()
    },
    dismissSelection(focus = true) {
      this.confirming = false
      this.selectedFile = null
      this.selectedDimensions = null
      this.selectionVersion++
      this.clearCandidatePreview()
      if (focus) this.$nextTick?.(() => this.focusPickerTarget())
    },
    cancelSelection() {
      this.dismissSelection()
      this.logoErrorKey = null
    },
    chooseAnother() {
      this.dismissSelection(false)
      this.logoErrorKey = null
      this.publishedNoticeKey = null
      this.$nextTick?.(() => this.openLogoPicker())
    },
    async publishSelected() {
      if (this.disabled || !this.selectedFile || this.logoUploading || this.logoRetrying) return
      const file = this.selectedFile
      const selectionVersion = this.selectionVersion
      this.submittedSelectionVersion = selectionVersion
      this.confirming = false
      await this.uploadSelectedLogo(file, selectionVersion)
    },
    clearLogoPoll() {
      if (this.logoPollTimer !== null) {
        window.clearTimeout(this.logoPollTimer)
        this.logoPollTimer = null
      }
    },
    scheduleLogoPoll() {
      this.clearLogoPoll()
      if (this.logoDisposed || !this.candidateIsProcessing) return
      const delay = pollDelays[Math.min(this.logoPollFailures, pollDelays.length - 1)]
      this.logoPollTimer = window.setTimeout(() => {
        this.logoPollTimer = null
        this.refreshLogoStatus(true)
      }, delay)
    },
    applyLogoStatus(status: SiteLogoStatus) {
      const previousActiveRevisionId = this.logoStatus?.active?.revisionId || null
      const previousCandidateRevisionId = this.logoStatus?.candidate?.revisionId || null
      if (status.candidate?.revisionId) this.trackedCandidateRevisionId = status.candidate.revisionId
      this.logoStatus = status
      this.logoStatusUnavailable = false
      this.logoPollFailures = 0
      if (status.active?.logoUrl) {
        wikiStore.site.logoUrl = status.active.logoUrl
        if (status.active.logoIcons) {
          ;(wikiStore.site as typeof wikiStore.site & { logoIcons?: LogoIconDescriptor }).logoIcons = status.active.logoIcons
          this.updateOwnedIconLinks(status.active.logoIcons)
        }
      }
      const activatedRevision = status.active?.revisionId && this.trackedCandidateRevisionId === status.active.revisionId
        ? status.active.revisionId !== previousActiveRevisionId || previousCandidateRevisionId === status.active.revisionId
        : false
      if (activatedRevision && status.active) {
        this.publishedNoticeKey = status.active.enhancement.status === 'unavailable'
          ? 'admin:general.logoStatusPublishedWithoutAnimation'
          : 'admin:general.logoStatusPublished'
        if (this.submittedSelectionVersion === null || this.submittedSelectionVersion === this.selectionVersion) {
          this.selectedFile = null
          this.selectedDimensions = null
          this.selectionVersion++
          this.clearCandidatePreview()
          this.confirming = false
          this.$nextTick?.(() => this.focusPickerTarget())
        }
        this.submittedSelectionVersion = null
        this.submittedRevisionId = null
        this.trackedCandidateRevisionId = null
        this.logoErrorKey = null
      } else if (status.candidate?.status === 'failed') {
        this.logoErrorKey = this.logoErrorMessageKey(status.candidate.errorCode)
        this.clearLogoPoll()
      } else if (status.candidate?.status === 'pending' || status.candidate?.status === 'running') {
        this.scheduleLogoPoll()
      } else {
        this.clearLogoPoll()
      }
      if (this.logoUploading || this.logoRetrying) {
        if (status.candidate?.revisionId) this.submittedRevisionId = status.candidate.revisionId
      }
    },
    updateOwnedIconLinks(icons: LogoIconDescriptor) {
      if (typeof document === 'undefined') return
      const links = document.querySelectorAll<HTMLLinkElement>('link[data-site-logo-icon]')
      links.forEach(link => {
        const key = link.dataset.siteLogoIcon as IconLinkKey | undefined
        if (!key) return
        const iconField = iconLinkFieldByKey[key]
        if (!iconField) return
        const url = icons[iconField]
        if (url) link.href = url
      })
    },
    logoErrorMessageKey(code: SiteLogoErrorCode | null) {
      return code ? logoErrorMessageKeys[code] : 'admin:general.logoErrorGeneric'
    },
    logoRequestErrorKey(error: unknown) {
      return error instanceof SiteLogoApiError && error.code
        ? this.logoErrorMessageKey(error.code)
        : 'admin:general.logoErrorGeneric'
    },
    async refreshLogoStatus(isPoll = false) {
      if (this.logoDisposed || this.logoStatusChecking) return
      const requestId = ++this.logoRequestId
      this.logoRequestController?.abort()
      const controller = new AbortController()
      this.logoRequestController = controller
      this.logoStatusChecking = true
      if (!isPoll) {
        this.logoStatusUnavailable = false
        this.logoPollFailures = 0
      }
      try {
        const status = await fetchSiteLogoStatus(window.fetch.bind(window), controller.signal)
        if (requestId !== this.logoRequestId || this.logoDisposed) return
        this.applyLogoStatus(status)
      } catch (error) {
        if (requestId === this.logoRequestId && !this.logoDisposed && !controller.signal.aborted) {
          this.logoStatusUnavailable = true
          this.logoPollFailures = Math.min(this.logoPollFailures + 1, maxPollFailures)
          this.clearLogoPoll()
          if (this.logoPollFailures < maxPollFailures) this.scheduleLogoPoll()
        }
      } finally {
        if (requestId === this.logoRequestId && !this.logoDisposed) this.logoStatusChecking = false
      }
    },
    checkAgain() {
      void this.refreshLogoStatus()
    },
    openLogoPicker() {
      if (this.disabled || this.logoRetrying || this.confirming) return
      ;(this.$refs?.logoFileInput as HTMLInputElement | undefined)?.click()
    },
    onLogoDragEnter() {
      if (this.disabled || this.logoRetrying || this.confirming) return
      this.logoDragDepth++
      this.logoDragActive = true
    },
    onLogoDragLeave() {
      this.logoDragDepth = Math.max(0, this.logoDragDepth - 1)
      this.logoDragActive = this.logoDragDepth > 0
    },
    onLogoDrop(event: DragEvent) {
      this.logoDragDepth = 0
      this.logoDragActive = false
      if (this.disabled || this.logoRetrying || this.confirming) return
      this.acceptLogoFiles(event.dataTransfer?.files)
    },
    onLogoFileChange(event: Event) {
      const input = event.target as HTMLInputElement
      this.acceptLogoFiles(input.files)
      input.value = ''
    },
    acceptLogoFiles(files: FileList | null | undefined) {
      if (!files || files.length === 0) return
      if (files.length !== 1) {
        this.logoErrorKey = 'admin:general.logoErrorOneFile'
        return
      }
      const file = files.item(0)
      if (!file) return
      if (file.size > SITE_LOGO_SOURCE_BYTE_LIMIT) {
        this.logoErrorKey = 'admin:general.logoErrorTooLarge'
        return
      }
      this.logoErrorKey = null
      this.logoStatusUnavailable = false
      this.publishedNoticeKey = null
      this.selectionVersion++
      this.selectedFile = file
      this.selectedDimensions = null
      this.replaceCandidatePreview(file, this.selectionVersion)
      this.confirming = true
    },
    replaceCandidatePreview(file: File, selectionVersion?: number) {
      const activeSelectionVersion = selectionVersion ?? this.selectionVersion
      this.clearCandidatePreview()
      this.candidatePreviewUrl = URL.createObjectURL(file)
      if (typeof Image === 'undefined') return
      const image = new Image()
      const state = this
      image.onload = () => {
        if (
          !state.logoDisposed &&
          activeSelectionVersion === state.selectionVersion &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0
        ) {
          state.selectedDimensions = { width: image.naturalWidth, height: image.naturalHeight }
        }
      }
      image.onerror = () => {
        if (!state.logoDisposed && activeSelectionVersion === state.selectionVersion) state.selectedDimensions = null
      }
      image.src = this.candidatePreviewUrl
    },
    clearCandidatePreview() {
      if (!this.candidatePreviewUrl) return
      URL.revokeObjectURL(this.candidatePreviewUrl)
      this.candidatePreviewUrl = ''
    },
    async uploadSelectedLogo(file: File, selectionVersion?: number) {
      const activeSelectionVersion = selectionVersion ?? this.selectionVersion
      this.clearLogoPoll()
      const requestId = ++this.logoRequestId
      this.logoRequestController?.abort()
      const controller = new AbortController()
      this.logoRequestController = controller
      this.submittedSelectionVersion = activeSelectionVersion
      this.logoErrorKey = null
      this.logoStatusUnavailable = false
      this.logoUploading = true
      if (!this.candidatePreviewUrl || this.selectedFile !== file) this.replaceCandidatePreview(file, activeSelectionVersion)
      try {
        const status = await uploadSiteLogo(window.fetch.bind(window), file, controller.signal)
        if (requestId !== this.logoRequestId || this.logoDisposed) return
        this.applyLogoStatus(status)
      } catch (error) {
        if (requestId === this.logoRequestId && !this.logoDisposed && !controller.signal.aborted) {
          this.logoErrorKey = error instanceof SiteLogoApiError && error.code
            ? this.logoRequestErrorKey(error)
            : 'admin:general.logoErrorUploadInterrupted'
        }
      } finally {
        if (requestId === this.logoRequestId && !this.logoDisposed) this.logoUploading = false
      }
    },
    async retryUpload() {
      if (this.disabled || this.logoUploading || this.logoRetrying || !this.selectedFile) return
      const file = this.selectedFile
      const selectionVersion = this.selectionVersion
      this.logoErrorKey = null
      await this.uploadSelectedLogo(file, selectionVersion)
    },
    async retryLogo() {
      if (this.disabled || this.logoUploading || this.logoRetrying || this.confirming || !this.candidateHasFailed) return
      this.clearLogoPoll()
      const requestId = ++this.logoRequestId
      this.logoRequestController?.abort()
      const controller = new AbortController()
      this.logoRequestController = controller
      this.logoErrorKey = null
      this.logoStatusUnavailable = false
      this.logoRetrying = true
      try {
        const status = await retrySiteLogo(window.fetch.bind(window), controller.signal)
        if (requestId !== this.logoRequestId || this.logoDisposed) return
        this.applyLogoStatus(status)
      } catch (error) {
        if (requestId === this.logoRequestId && !this.logoDisposed && !controller.signal.aborted) {
          this.logoErrorKey = this.logoRequestErrorKey(error)
        }
      } finally {
        if (requestId === this.logoRequestId && !this.logoDisposed) this.logoRetrying = false
      }
    }
  },
  mounted() {
    this.coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    this.refreshLogoStatus()
  },
  beforeUnmount() {
    this.logoDisposed = true
    this.logoRequestId++
    this.logoRequestController?.abort()
    this.clearLogoPoll()
    this.clearCandidatePreview()
  }
}
</script>
<style lang='scss' scoped>
.general-logo-note { margin: 0 0 1.25rem; color: var(--wiki-text-muted); line-height: 1.7; }
.general-logo-review { max-height: 90dvh; .v-card-title { white-space: normal; } .v-card-text { overflow: auto; } }
.general-logo-review p { line-height: 1.7; overflow-wrap: anywhere; }
.general-logo-selection-frame {
  display: grid;
  min-height: 210px;
  margin-bottom: 1.25rem;
  place-items: center;
  overflow: hidden;
  border-radius: 10px;
}
.general-logo-selection-frame--light { background: rgb(var(--v-theme-surface)); }
.general-logo-selection-frame--dark { background: #202321; }
.general-logo-selection-frame--transparency,
.logo-preview-frame--transparency {
  background:
    linear-gradient(45deg, rgba(var(--v-theme-on-surface), .06) 25%, transparent 25%) 0 0 / 16px 16px,
    linear-gradient(-45deg, rgba(var(--v-theme-on-surface), .06) 25%, transparent 25%) 0 8px / 16px 16px,
    linear-gradient(45deg, transparent 75%, rgba(var(--v-theme-on-surface), .06) 75%) 8px -8px / 16px 16px,
    linear-gradient(-45deg, transparent 75%, rgba(var(--v-theme-on-surface), .06) 75%) -8px 0 / 16px 16px;
}
.general-logo-selection { display: block; width: 100%; max-width: 100%; height: 210px; object-fit: contain; }
.logo-background-control { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.logo-background-label { font-size: .875rem; font-weight: 600; }
.logo-background-options { display: flex; flex-wrap: wrap; gap: .5rem; }
.logo-background-option {
  min-height: 36px;
  padding: .35rem .75rem;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.logo-background-option[aria-pressed='true'] { border-color: rgb(var(--v-theme-primary)); box-shadow: 0 0 0 2px rgba(var(--v-theme-primary), .18); }
.logo-background-option--light { background: rgb(var(--v-theme-surface)); }
.logo-background-option--dark { background: #202321; color: #fff; }
.logo-background-option--transparency {
  background:
    linear-gradient(45deg, rgba(var(--v-theme-on-surface), .08) 25%, transparent 25%) 0 0 / 10px 10px,
    linear-gradient(-45deg, rgba(var(--v-theme-on-surface), .08) 25%, transparent 25%) 0 5px / 10px 10px,
    linear-gradient(45deg, transparent 75%, rgba(var(--v-theme-on-surface), .08) 75%) 5px -5px / 10px 10px,
    linear-gradient(-45deg, transparent 75%, rgba(var(--v-theme-on-surface), .08) 75%) -5px 0 / 10px 10px;
}
.logo-file-details { margin: 0 0 .75rem; font-size: .875rem; overflow-wrap: anywhere; }
.logo-review-copy { margin: 0; }
.logo-manager { --logo-manager-border: rgba(var(--v-border-color), var(--v-border-opacity)); }
.logo-preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.logo-preview-card { min-width: 0; padding: 1rem; border: 1px solid var(--logo-manager-border); border-radius: 12px; background: rgba(var(--v-theme-surface-variant), .24); }
.logo-preview-heading { margin-bottom: .75rem; color: rgba(var(--v-theme-on-surface), .72); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.logo-preview-frame { display: grid; width: 100%; height: 112px; place-items: center; overflow: hidden; border-radius: 8px; background-color: rgb(var(--v-theme-surface)); }
.logo-preview-frame--dark { background: #202321; }
.logo-preview-frame > .v-img { width: 100%; height: 100%; }
.logo-preview-frame > .v-img :deep(img) { object-fit: contain; }
.logo-preview-status { margin-top: .75rem; }
.logo-preview-empty { margin: .75rem 0 0; color: var(--wiki-text-muted); font-size: .875rem; }
.logo-candidate-status-line { display: flex; align-items: center; gap: .5rem; min-height: 24px; margin-top: .75rem; font-size: .875rem; font-weight: 600; }
.logo-status-supporting { margin: .45rem 0 0; color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.5; }
.logo-candidate-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
.logo-drop-target { position: relative; display: flex; align-items: center; gap: 1rem; min-height: 96px; padding: 1rem 1.25rem; border: 1.5px dashed rgba(var(--v-theme-primary), .5); border-radius: 12px; background: rgba(var(--v-theme-primary), .045); cursor: pointer; transition: border-color .16s ease, background-color .16s ease, transform .16s ease; }
.logo-drop-target:hover, .logo-drop-target:focus-visible, .logo-drop-target--active { border-color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .1); outline: none; transform: translateY(-1px); }
.logo-drop-target:focus-visible { box-shadow: 0 0 0 3px rgba(var(--v-theme-primary), .22); }
.logo-drop-target--disabled { cursor: wait; opacity: .58; transform: none; }
.logo-file-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.logo-drop-icon { flex: 0 0 auto; color: rgb(var(--v-theme-primary)); }
.logo-drop-copy { min-width: 0; }
.logo-picker-help { margin: .65rem 0 0; line-height: 1.5; }
.logo-message { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem .5rem; margin-top: .75rem; font-size: .875rem; }
.logo-message--error { color: rgb(var(--v-theme-error)); }
.logo-error-action { color: inherit; }
.logo-status { margin: .75rem 0 0; min-height: 1.35rem; font-size: .875rem; font-weight: 600; }
.logo-disclosure { display: flex; align-items: flex-start; margin: 1rem 0 0; line-height: 1.5; }
@media (max-width: 600px) {
  .logo-preview-grid { grid-template-columns: 1fr; }
  .logo-drop-target { align-items: flex-start; }
  .logo-background-control { align-items: flex-start; flex-direction: column; }
}
</style>
