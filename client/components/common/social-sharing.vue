<template lang="pug">
  v-list(nav, density="compact", :aria-label='$t(`common:page.share`)')
    v-list-item(
      v-if='canUseNativeShare'
      tag='button'
      type='button'
      role='button'
      :disabled='nativeShareLoading'
      @click='shareNative'
    )
      template(v-slot:prepend)
        v-icon(color='primary', size="small") mdi-share-variant
      v-list-item-title.px-3 {{ offline ? 'Share saved copy' : 'Share' }}
    v-list-item(tag='button', type='button', role='button', @click='copyUrl')
      template(v-slot:prepend)
        v-icon(
          :key='copied ? "check" : "copy"'
          :class='{ "icon-tactile-bounce": copied }'
          :color='copied ? "success" : "grey"'
          size="small"
        ) {{ copied ? 'mdi-check-bold' : 'mdi-content-copy' }}
      v-list-item-title.px-3 {{$t('common:actions.copy')}} URL
    v-list-item(tag='button', type='button', role='button', @click='copyText')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-text-box-outline
      v-list-item-title.px-3 Copy page text
    v-list-item(:href='shareUrls.email')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-email-outline
      v-list-item-title.px-3 Email
    v-list-item(tag='button', type='button', role='button', @click='openSocialPop(shareUrls.facebook)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-facebook
      v-list-item-title.px-3 Facebook
    v-list-item(tag='button', type='button', role='button', @click='openSocialPop(shareUrls.linkedin)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-linkedin
      v-list-item-title.px-3 LinkedIn
    v-list-item(tag='button', type='button', role='button', @click='openSocialPop(shareUrls.reddit)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-reddit
      v-list-item-title.px-3 Reddit
    v-list-item(tag='button', type='button', role='button', @click='openSocialPop(shareUrls.telegram)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-telegram
      v-list-item-title.px-3 Telegram
    v-list-item(tag='button', type='button', role='button', @click='openSocialPop(shareUrls.x)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-alpha-x-box-outline
      v-list-item-title.px-3 X
    v-list-item(:href='shareUrls.viber')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-phone-in-talk
      v-list-item-title.px-3 Viber
    v-list-item(tag='button', type='button', role='button', @click='openSocialPop(shareUrls.weibo)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-sina-weibo
      v-list-item-title.px-3 Weibo
    v-list-item(tag='button', type='button', role='button', @click='openSocialPop(shareUrls.whatsapp)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-whatsapp
      v-list-item-title.px-3 WhatsApp
    span.social-sharing-status.sr-only(role='status', aria-live='polite') {{ copyStatus }}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'

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
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true })
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
      default: 'Untitled Page'
    },
    description: {
      type: String,
      default: ''
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
      const localUrl = this.offlineUrl.trim()
      return this.offline && localUrl ? localUrl : this.url.trim()
    },
    shareText (): string {
      const content = (this.offlineText || this.description).trim()
      const parts = [this.title.trim(), content].filter(Boolean)
      if (this.offline) parts.push('This is a local copy saved on this device.')
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
        data.text = [data.text, 'This is a local copy saved on this device.'].filter(Boolean).join('\n\n')
      }
      const url = this.shareUrl
      if (url) data.url = url
      return data
    },
    canUseNativeShare (): boolean {
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
        this.copyStatus = 'Failed to copy to clipboard'
        wikiStore.showNotification({
          style: 'red',
          message: this.copyStatus,
          icon: 'alert'
        })
      }
    },
    async copyUrl (): Promise<void> {
      await this.copyValue(this.shareUrl, 'URL copied successfully')
    },
    async copyText (): Promise<void> {
      await this.copyValue(this.shareText, 'Page text copied successfully')
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
            message: 'Unable to share this page. Use Copy URL or Copy page text instead.',
            icon: 'alert'
          })
        }
      } finally {
        if (operationId === this.shareOperationId) this.nativeShareLoading = false
      }
    },
    openSocialPop (url: string): void {
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
          message: `Allow popups to share this page.`,
          icon: 'alert'
        })
      }
    }
  }
})
</script>

<style scoped>
.icon-tactile-bounce {
  animation: tactile-bounce 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  transform-origin: center;
}

@keyframes tactile-bounce {
  0% {
    transform: scale(0.92);
  }
  50% {
    transform: scale(1.08);
  }
  100% {
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .icon-tactile-bounce {
    animation: none !important;
  }
}
</style>
