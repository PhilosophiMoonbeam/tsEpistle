<template lang="pug">
  v-list(nav, density="compact", :aria-label='$t(`common:page.share`)')
    v-list-item(tag='button', @click='copyUrl')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-content-copy
      v-list-item-title.px-3 {{$t('common:actions.copy')}} URL
    v-list-item(:href='`mailto:?subject=` + encodeURIComponent(title) + `&body=` + encodeURIComponent(url) + `%0D%0A%0D%0A` + encodeURIComponent(description)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-email-outline
      v-list-item-title.px-3 Email
    v-list-item(@click='openSocialPop(`https://www.facebook.com/sharer/sharer.php?u=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title) + `&description=` + encodeURIComponent(description))')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-facebook
      v-list-item-title.px-3 Facebook
    v-list-item(@click='openSocialPop(`https://www.linkedin.com/shareArticle?mini=true&url=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title) + `&summary=` + encodeURIComponent(description))')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-linkedin
      v-list-item-title.px-3 LinkedIn
    v-list-item(@click='openSocialPop(`https://www.reddit.com/submit?url=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title))')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-reddit
      v-list-item-title.px-3 Reddit
    v-list-item(@click='openSocialPop(`https://t.me/share/url?url=` + encodeURIComponent(url) + `&text=` + encodeURIComponent(title))')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-telegram
      v-list-item-title.px-3 Telegram
    v-list-item(@click='openSocialPop(`https://x.com/intent/post?url=` + encodeURIComponent(url) + `&text=` + encodeURIComponent(title))')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-alpha-x-box-outline
      v-list-item-title.px-3 X
    v-list-item(:href='`viber://forward?text=` + encodeURIComponent(url) + ` ` + encodeURIComponent(description)')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-phone-in-talk
      v-list-item-title.px-3 Viber
    v-list-item(@click='openSocialPop(`https://service.weibo.com/share/share.php?url=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title))')
      template(v-slot:prepend)
        v-icon(color='grey', size="small") mdi-sina-weibo
      v-list-item-title.px-3 Weibo
    v-list-item(@click='openSocialPop(`https://api.whatsapp.com/send?text=` + encodeURIComponent(title) + `%0D%0A` + encodeURIComponent(url))')
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
      default: () => window.location.href
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
  data () {
    return {
      width: 626,
      height: 436,
      left: 0,
      top: 0
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
      this.width = Math.min(626, Math.max(1, availableWidth - (gutter * 2)))
      this.height = Math.min(436, Math.max(1, availableHeight - (gutter * 2)))

      this.left = window.screenX + Math.max(gutter, (availableWidth - this.width) / 2)
      this.top = window.screenY + Math.max(gutter, (availableHeight - this.height) / 2)

      const popupWindow = window.open(
        url,
        'sharer',
        `status=no,height=${this.height},width=${this.width},resizable=yes,left=${this.left},top=${this.top},screenX=${this.left},screenY=${this.top},toolbar=no,menubar=no,scrollbars=no,location=no,directories=no`
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
