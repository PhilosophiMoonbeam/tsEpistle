<template lang="pug">
  v-list.social-sharing(nav, role='group', tabindex='-1', density="compact", :aria-label='$t(`common:page.share`)')
    .social-sharing__canonical
      label.social-sharing__url-label
        span {{ $t('common:socialSharing.canonicalUrl') }}
        input.social-sharing__url.wiki-surface-well(
          type='text'
          readonly
          :value='shareUrl'
          :aria-label='$t("common:socialSharing.canonicalUrl")'
          dir='ltr'
          @focus='selectUrl'
        )
      v-btn(variant='tonal', size='small', :disabled='!shareUrl', @click='copyUrl')
        v-icon.social-sharing__icon(start, size='small') {{ copied ? 'mdi-check-bold' : 'mdi-content-copy' }}
        | {{ $t('common:socialSharing.copyLink') }}
    v-list-item(tag='button', type='button', role='button', :disabled='!shareUrl', :aria-disabled='!shareUrl ? `true` : undefined', :tabindex='shareUrl ? 0 : -1', @click='copyMarkdown')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size='small') mdi-language-markdown-outline
      v-list-item-title.px-3 {{ $t('common:socialSharing.copyMarkdownLink') }}
    v-list-item(
      tag='button'
      type='button'
      role='button'
      :disabled='!sectionUrl'
      :aria-disabled='!sectionUrl ? `true` : undefined'
      :tabindex='sectionUrl ? 0 : -1'
      :title='sectionUrl ? undefined : $t("common:socialSharing.noCurrentSection")'
      @click='copySection'
    )
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size='small') mdi-link-variant
      v-list-item-title.px-3 {{ $t('common:socialSharing.copyCurrentSectionLink') }}
    v-list-item(v-if='offline', tag='button', type='button', role='button', tabindex='0', @click='copyText')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size='small') mdi-text-box-outline
      v-list-item-title.px-3 {{ $t('common:socialSharing.copyPageText') }}
    v-list-item(:href='shareUrl ? shareUrls.email : undefined', role='link', :disabled='!shareUrl', :aria-disabled='!shareUrl ? `true` : undefined', :tabindex='shareUrl ? 0 : -1')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size='small') mdi-email-outline
      v-list-item-title.px-3 {{ $t('common:socialSharing.shareViaEmail') }}
    p.social-sharing__notice {{ offline ? $t('common:socialSharing.localCopySavedDevice') : $t('common:socialSharing.linkAccessNotice') }}
    v-list-item(
      v-if='canUseNativeShare'
      tag='button'
      type='button'
      role='button'
      :disabled='nativeShareLoading'
      :aria-disabled='nativeShareLoading ? `true` : undefined'
      :tabindex='nativeShareLoading ? -1 : 0'
      @click='shareNative'
    )
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size='small') mdi-share-variant
      v-list-item-title.px-3 {{ $t('common:socialSharing.share') }}
    v-list-item(v-if='canUsePublicSharing', tag='button', type='button', role='button', tabindex='0', @click='openSocialPop(shareUrls.facebook)')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-facebook
      v-list-item-title.px-3 Facebook
    v-list-item(v-if='canUsePublicSharing', tag='button', type='button', role='button', tabindex='0', @click='openSocialPop(shareUrls.linkedin)')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-linkedin
      v-list-item-title.px-3 LinkedIn
    v-list-item(v-if='canUsePublicSharing', tag='button', type='button', role='button', tabindex='0', @click='openSocialPop(shareUrls.reddit)')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-reddit
      v-list-item-title.px-3 Reddit
    v-list-item(v-if='canUsePublicSharing', tag='button', type='button', role='button', tabindex='0', @click='openSocialPop(shareUrls.telegram)')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-send-circle-outline
      v-list-item-title.px-3 Telegram
    v-list-item(v-if='canUsePublicSharing', tag='button', type='button', role='button', tabindex='0', @click='openSocialPop(shareUrls.x)')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-alpha-x-box-outline
      v-list-item-title.px-3 X
    v-list-item(v-if='canUsePublicSharing', :href='shareUrls.viber', tabindex='0')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-phone-in-talk
      v-list-item-title.px-3 Viber
    v-list-item(v-if='canUsePublicSharing', tag='button', type='button', role='button', tabindex='0', @click='openSocialPop(shareUrls.weibo)')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-sina-weibo
      v-list-item-title.px-3 Weibo
    v-list-item(v-if='canUsePublicSharing', tag='button', type='button', role='button', tabindex='0', @click='openSocialPop(shareUrls.whatsapp)')
      template(v-slot:prepend)
        v-icon.social-sharing__icon(size="small") mdi-whatsapp
      v-list-item-title.px-3 WhatsApp
    p.social-sharing-status(role='status', aria-live='polite', aria-atomic='true') {{ copyStatus }}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { translate } from '@/modules/localization.ts'

type SharePayload = {
  title?: string
  text?: string
  url?: string
}
type ShareCapableNavigator = {
  share?: (data: SharePayload) => Promise<void>
  canShare?: (data?: SharePayload) => boolean
}

function copyWithLegacyFallback (text: string): boolean {
  const activeElement = document.activeElement
  const input = document.createElement('textarea')
  input.value = text
  input.readOnly = true
  input.style.position = 'fixed'
  input.style.opacity = '0'
  input.style.pointerEvents = 'none'
  document.body.append(input)
  input.select()
  try {
    return document.execCommand('copy')
  } finally {
    input.remove()
    if (activeElement instanceof HTMLElement && activeElement.isConnected) activeElement.focus({ preventScroll: true })
  }
}

function getShareNavigator (): ShareCapableNavigator | null {
  return typeof navigator === 'undefined' ? null : navigator as ShareCapableNavigator
}

function isAbortError (error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'name') === 'AbortError')
}

export default defineComponent({
  props: {
    url: {
      type: String,
      default: () => typeof window === 'undefined' ? '' : window.location.href
    },
    title: {
      type: String,
      default: () => translate('common:socialSharing.untitledPage')
    },
    description: {
      type: String,
      default: ''
    },
    sectionAnchor: {
      type: String,
      default: ''
    },
    publicContextEligible: {
      type: Boolean,
      default: false
    },
    offline: {
      type: Boolean,
      default: false
    },
    offlineUrl: {
      type: String,
      default: ''
    },
    offlineText: {
      type: String,
      default: ''
    }
  },
  data () {
    return {
      copied: false,
      copiedTimer: null as ReturnType<typeof setTimeout> | null,
      copyOperationId: 0,
      copyStatus: '',
      nativeShareLoading: false,
      shareOperationId: 0
    }
  },
  beforeUnmount () {
    this.invalidateCopyFeedback()
    this.shareOperationId += 1
  },
  watch: {
    url (): void {
      this.invalidateCopyFeedback()
    },
    title (): void {
      this.invalidateCopyFeedback()
    },
    sectionAnchor (): void {
      this.invalidateCopyFeedback()
    },
    canUsePublicSharing (): void {
      this.shareOperationId += 1
      this.nativeShareLoading = false
    },
    shareData: {
      handler (): void {
        this.shareOperationId += 1
        this.nativeShareLoading = false
      },
      deep: true
    },
    offlineText (): void {
      this.invalidateCopyFeedback()
    },
    description (): void {
      this.invalidateCopyFeedback()
    },
    offlineUrl (): void {
      this.invalidateCopyFeedback()
    },
    offline (): void {
      this.invalidateCopyFeedback()
    }
  },
  computed: {
    shareUrl (): string {
      const suppliedUrl = this.offline && this.offlineUrl.trim() ? this.offlineUrl.trim() : this.url.trim()
      if (!suppliedUrl) return ''
      try {
        const url = new URL(suppliedUrl, typeof window === 'undefined' ? undefined : window.location.origin)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.href
      } catch {
        return ''
      }
    },
    sectionUrl (): string {
      if (!this.shareUrl || !this.sectionAnchor) return ''
      try {
        return `${this.shareUrl}#${encodeURIComponent(this.sectionAnchor)}`
      } catch {
        return ''
      }
    },
    markdownLink (): string {
      const title = this.title.trim().replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]{}()<>]/g, '\\$&')
      const destination = this.shareUrl.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E')
      return `[${title}](${destination})`
    },
    canUsePublicSharing (): boolean {
      return typeof window !== 'undefined' && window.siteConfig?.publicSocialSharing === true &&
        this.publicContextEligible && !this.offline && Boolean(this.shareUrl)
    },
    shareText (): string {
      if (!this.offline) return [this.title.trim(), this.description.trim()].filter(Boolean).join('\n\n')
      const content = (this.offlineText || this.description).trim()
      const parts = [this.title.trim(), content].filter(Boolean)
      parts.push(this.$t('common:socialSharing.localCopySavedDevice'))
      return parts.join('\n\n')
    },
    shareData (): SharePayload {
      const data: SharePayload = {}
      const title = this.title.trim()
      const text = this.offline
        ? (this.offlineText || this.description).trim()
        : this.description.trim()
      if (title) data.title = title
      if (text) data.text = text
      if (this.offline) {
        data.text = [data.text, this.$t('common:socialSharing.localCopySavedDevice')].filter(Boolean).join('\n\n')
      }
      const url = this.shareUrl
      if (url) data.url = url
      return data
    },
    canUseNativeShare (): boolean {
      if (!this.canUsePublicSharing) return false
      const shareNavigator = getShareNavigator()
      if (!shareNavigator?.share) return false
      if (!shareNavigator.canShare) return true
      try {
        return shareNavigator.canShare(this.shareData)
      } catch {
        return false
      }
    },
    shareUrls() {
      const url = encodeURIComponent(this.shareUrl)
      const title = encodeURIComponent(this.title)
      const description = encodeURIComponent(this.offline ? this.shareText : this.description)

      return {
        email: `mailto:?subject=${title}&body=${url}%0D%0A%0D%0A${description}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
        linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
        reddit: `https://www.reddit.com/submit?url=${url}&title=${title}`,
        telegram: `https://t.me/share/url?url=${url}&text=${title}`,
        x: `https://x.com/intent/post?url=${url}&text=${title}`,
        viber: `viber://forward?text=${url} ${description}`,
        weibo: `https://service.weibo.com/share/share.php?url=${url}&title=${title}`,
        whatsapp: `https://api.whatsapp.com/send?text=${title}%0D%0A${url}`
      }
    }
  },
  methods: {
    selectUrl (event: FocusEvent): void {
      if (event.target instanceof HTMLInputElement) event.target.select()
    },
    clearCopiedTimer (): void {
      if (this.copiedTimer !== null) {
        clearTimeout(this.copiedTimer)
        this.copiedTimer = null
      }
    },
    invalidateCopyFeedback (): void {
      this.copyOperationId += 1
      this.copied = false
      this.copyStatus = ''
      this.clearCopiedTimer()
    },
    isCurrentCopyOperation (operationId: number): boolean {
      return this.copyOperationId === operationId
    },
    async copyValue (text: string, successMessage: string): Promise<void> {
      this.invalidateCopyFeedback()
      const operationId = this.copyOperationId
      try {
        let copied = false
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(text)
            copied = true
          } catch {
            if (!this.isCurrentCopyOperation(operationId)) return
          }
        }
        if (!copied) {
          if (!this.isCurrentCopyOperation(operationId)) return
          copied = copyWithLegacyFallback(text)
        }
        if (!copied) throw new Error('Clipboard copy was rejected')
        if (!this.isCurrentCopyOperation(operationId)) return
        this.copied = true
        this.copyStatus = successMessage
        this.copiedTimer = setTimeout(() => {
          if (!this.isCurrentCopyOperation(operationId)) return
          this.copied = false
          this.copyStatus = ''
          this.copiedTimer = null
        }, 2000)
        wikiStore.showNotification({
          style: 'success',
          message: successMessage,
          icon: 'content-copy'
        })
      } catch {
        if (!this.isCurrentCopyOperation(operationId)) return
        this.copyStatus = this.$t('common:socialSharing.failedCopyClipboard')
        wikiStore.showNotification({
          style: 'red',
          message: this.copyStatus,
          icon: 'alert'
        })
      }
    },
    async copyUrl (): Promise<void> {
      if (!this.shareUrl) return
      await this.copyValue(this.shareUrl, this.$t('common:socialSharing.urlCopiedSuccessfully'))
    },
    async copyMarkdown (): Promise<void> {
      if (!this.shareUrl) return
      await this.copyValue(this.markdownLink, this.$t('common:socialSharing.markdownLinkCopied'))
    },
    async copySection (): Promise<void> {
      if (!this.sectionUrl) return
      await this.copyValue(this.sectionUrl, this.$t('common:socialSharing.sectionLinkCopied'))
    },
    async copyText (): Promise<void> {
      await this.copyValue(this.shareText, this.$t('common:socialSharing.pageTextCopiedSuccessfully'))
    },
    async shareNative (): Promise<void> {
      const shareNavigator = getShareNavigator()
      if (!shareNavigator?.share || !this.canUseNativeShare || this.nativeShareLoading) return
      if (shareNavigator.canShare) {
        try {
          if (!shareNavigator.canShare(this.shareData)) return
        } catch {
          return
        }
      }
      const operationId = ++this.shareOperationId
      this.nativeShareLoading = true
      try {
        await shareNavigator.share(this.shareData)
      } catch (error) {
        if (isAbortError(error)) return
        if (operationId === this.shareOperationId) {
          wikiStore.showNotification({
            style: 'red',
            message: this.offline
              ? this.$t('common:socialSharing.unableShareExcerptLocal')
              : this.$t('common:socialSharing.unableSharePageUse'),
            icon: 'alert'
          })
        }
      } finally {
        if (operationId === this.shareOperationId) this.nativeShareLoading = false
      }
    },
    openSocialPop (url: string): void {
      if (!this.canUsePublicSharing) return
      const gutter = 12
      const availableWidth = window.innerWidth || window.screen.availWidth
      const availableHeight = window.innerHeight || window.screen.availHeight
      const width = Math.min(626, Math.max(1, availableWidth - (gutter * 2)))
      const height = Math.min(436, Math.max(1, availableHeight - (gutter * 2)))

      const left = window.screenX + Math.max(gutter, (availableWidth - width) / 2)
      const top = window.screenY + Math.max(gutter, (availableHeight - height) / 2)

      const popupWindow = window.open(
        '',
        '_blank',
        `status=no,height=${height},width=${width},resizable=yes,left=${left},top=${top},screenX=${left},screenY=${top},toolbar=no,menubar=no,scrollbars=yes,location=no,directories=no`
      )

      if (popupWindow) {
        popupWindow.opener = null
        popupWindow.location.replace(url)
        popupWindow.focus()
      } else {
        wikiStore.showNotification({
          style: 'red',
          message: this.$t('common:socialSharing.allowPopupsSharePage'),
          icon: 'alert'
        })
      }
    }
  }
})
</script>

<style scoped>
.social-sharing {
  max-inline-size: 100%;
  background: var(--wiki-surface-gradient);
  color: var(--wiki-text-primary);
}

.social-sharing__canonical {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-3);
}

.social-sharing__url-label {
  display: grid;
  flex: 1 1 12rem;
  gap: var(--wiki-space-1);
  min-inline-size: 0;
  font-size: 0.8125rem;
  color: var(--wiki-text-muted);
}

.social-sharing__url {
  inline-size: 100%;
  min-inline-size: 0;
  min-block-size: 44px;
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border-radius: var(--wiki-radius-sm);
  color: var(--wiki-text-primary);
  font: inherit;
  user-select: text;
}


.social-sharing__canonical :deep(.v-btn),
.social-sharing :deep(.v-list-item) {
  min-block-size: 44px;
}

.social-sharing :deep(.v-list-item-title) {
  white-space: normal;
  overflow-wrap: anywhere;
}

.social-sharing__icon {
  color: var(--wiki-text-muted);
}

.social-sharing__notice,
.social-sharing-status {
  padding-inline: var(--wiki-space-3);
  margin-block: var(--wiki-space-2);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.social-sharing__notice {
  color: var(--wiki-text-muted);
}
</style>
