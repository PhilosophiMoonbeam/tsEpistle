<template lang="pug">
  v-list(nav, dense)
    v-list-item(@click='', ref='copyUrlButton')
      v-icon(color='grey', small) mdi-content-copy
      v-list-item-title.px-3 Copy URL
    v-list-item(:href='`mailto:?subject=` + encodeURIComponent(title) + `&body=` + encodeURIComponent(url) + `%0D%0A%0D%0A` + encodeURIComponent(description)')
      v-icon(color='grey', small) mdi-email-outline
      v-list-item-title.px-3 Email
    v-list-item(@click='openSocialPop(`https://www.facebook.com/sharer/sharer.php?u=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title) + `&description=` + encodeURIComponent(description))')
      v-icon(color='grey', small) mdi-facebook
      v-list-item-title.px-3 Facebook
    v-list-item(@click='openSocialPop(`https://www.linkedin.com/shareArticle?mini=true&url=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title) + `&summary=` + encodeURIComponent(description))')
      v-icon(color='grey', small) mdi-linkedin
      v-list-item-title.px-3 LinkedIn
    v-list-item(@click='openSocialPop(`https://www.reddit.com/submit?url=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title))')
      v-icon(color='grey', small) mdi-reddit
      v-list-item-title.px-3 Reddit
    v-list-item(@click='openSocialPop(`https://t.me/share/url?url=` + encodeURIComponent(url) + `&text=` + encodeURIComponent(title))')
      v-icon(color='grey', small) mdi-telegram
      v-list-item-title.px-3 Telegram
    v-list-item(@click='openSocialPop(`https://twitter.com/intent/tweet?url=` + encodeURIComponent(url) + `&text=` + encodeURIComponent(title))')
      v-icon(color='grey', small) mdi-twitter
      v-list-item-title.px-3 Twitter
    v-list-item(:href='`viber://forward?text=` + encodeURIComponent(url) + ` ` + encodeURIComponent(description)')
      v-icon(color='grey', small) mdi-phone-in-talk
      v-list-item-title.px-3 Viber
    v-list-item(@click='openSocialPop(`http://service.weibo.com/share/share.php?url=` + encodeURIComponent(url) + `&title=` + encodeURIComponent(title))')
      v-icon(color='grey', small) mdi-sina-weibo
      v-list-item-title.px-3 Weibo
    v-list-item(@click='openSocialPop(`https://api.whatsapp.com/send?text=` + encodeURIComponent(title) + `%0D%0A` + encodeURIComponent(url))')
      v-icon(color='grey', small) mdi-whatsapp
      v-list-item-title.px-3 Whatsapp
</template>

<script lang='ts'>
import { defineComponent, type ComponentPublicInstance } from 'vue'
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
      top: 0,
      clipboard: null as ClipboardJS | null
    }
  },
  methods: {
    openSocialPop (url: string): void {
      const popupWindow = window.open(
        url,
        'sharer',
        `status=no,height=${this.height},width=${this.width},resizable=yes,left=${this.left},top=${this.top},screenX=${this.left},screenY=${this.top},toolbar=no,menubar=no,scrollbars=no,location=no,directories=no`
      )

      popupWindow?.focus()
    }
  },
  mounted () {
    const copyUrlButton = this.$refs.copyUrlButton as ComponentPublicInstance
    const copyUrlElement = copyUrlButton.$el as Element
    this.clipboard = new ClipboardJS(copyUrlElement, {
      text: () => this.url
    })

    this.clipboard.on('success', () => {
      wikiStore.showNotification({
        style: 'success',
        message: `URL copied successfully`,
        icon: 'content-copy'
      })
    })
    this.clipboard.on('error', () => {
      wikiStore.showNotification({
        style: 'red',
        message: `Failed to copy to clipboard`,
        icon: 'alert'
      })
    })

    /**
     * Center the popup on dual screens
     * http://stackoverflow.com/questions/4068373/center-a-popup-window-on-screen/32261263
     */
    const dualScreenLeft = window.screenX
    const dualScreenTop = window.screenY

    const width = window.innerWidth ? window.innerWidth : (document.documentElement.clientWidth ? document.documentElement.clientWidth : screen.width)
    const height = window.innerHeight ? window.innerHeight : (document.documentElement.clientHeight ? document.documentElement.clientHeight : screen.height)

    this.left = ((width / 2) - (this.width / 2)) + dualScreenLeft
    this.top = ((height / 2) - (this.height / 2)) + dualScreenTop
  },
  beforeUnmount () {
    this.clipboard?.destroy()
  }
})
</script>
