<template lang="pug">
  v-list(nav, density="compact", :aria-label='$t(`common:page.share`)')
    v-list-item(tag='button', type='button', role='button', @click='copyUrl')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-content-copy
      v-list-item-title.px-3 {{$t('common:actions.copy')}} URL
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
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import ClipboardJS from 'clipboard'
import { wikiStore } from '@/store/index.ts'

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
    }
  },
  computed: {
    shareUrls() {
      const url = encodeURIComponent(this.url)
      const title = encodeURIComponent(this.title)
      const description = encodeURIComponent(this.description)

      return {
        email: `mailto:?subject=${title}&body=${url}%0D%0A%0D%0A${description}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}&title=${title}&description=${description}`,
        linkedin: `https://www.linkedin.com/shareArticle?mini=true&url=${url}&title=${title}&summary=${description}`,
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
    copyUrl (): void {
      try {
        ClipboardJS.copy(this.url)
        wikiStore.showNotification({
          style: 'success',
          message: `URL copied successfully`,
          icon: 'content-copy'
        })
      } catch {
        wikiStore.showNotification({
          style: 'red',
          message: `Failed to copy to clipboard`,
          icon: 'alert'
        })
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
        url,
        'sharer',
        `status=no,height=${height},width=${width},resizable=yes,left=${left},top=${top},screenX=${left},screenY=${top},toolbar=no,menubar=no,scrollbars=no,location=no,directories=no`
      )

      if (popupWindow) {
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
