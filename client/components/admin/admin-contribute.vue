<template lang='pug'>
  v-container.admin-contribute(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-heart-health.svg', alt='Contribute', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft {{ $t('admin:contribute.title') }}
            .text-body-large.text-grey.animated.fadeInLeft.wait-p4s {{ $t('admin:contribute.subtitle') }}
        v-card.mt-3.animated.fadeInUp
          v-card-text
            i18next.text-body-medium.pl-3(path='admin:contribute.openSource', tag='div')
              v-icon(color='red') mdi-heart
              a(href='https://requarks.io', target='_blank') requarks.io
              a(href='https://github.com/Requarks/wiki/graphs/contributors', target='_blank') {{ $t('admin:contribute.openSourceContributors') }}
            .text-body-medium.pt-3.pl-3 {{ $t('admin:contribute.needYourHelp') }}
            v-divider.mt-3
            v-list-subheader.text-label-large {{ $t('admin:contribute.fundOurWork') }}
            v-tabs.mx-3.radius-7.admin-contribute-tabs.text-white(
              v-model='contributeTab'
              align-tabs="center"
              :fixed-tabs='$vuetify.display.mdAndUp'
              show-arrows
              bg-color='primary'
              color='white'
              slider-color='#FFF'
              stacked
              )
              v-tab(value='github')
                span GitHub
                v-icon.my-1(size='24') mdi-github
              v-tab(value='patreon')
                span Patreon
                img.my-1(src='/_assets/svg/icon-patreon.svg', style='height: 24px;')
              v-tab(value='open-collective')
                span OpenCollective
                img.my-1(src='/_assets/svg/icon-opencollective.svg', style='height: 24px;')
              v-tab(value='paypal')
                span PayPal
                img.my-1(src='/_assets/svg/icon-paypal.svg', style='height: 24px;')
              v-tab(value='ethereum')
                span Ethereum
                img.my-1(src='/_assets/svg/icon-ethereum.svg', style='height: 24px;')
              v-tab(value='tshirts')
                span T-Shirts
                img.my-1(src='/_assets/svg/icon-t-shirt.svg', style='height: 24px;')
            v-tabs-window(v-model='contributeTab')
              v-tabs-window-item(value='github', :transition='false', :reverse-transition='false')
                .text-body-medium.pa-3 {{ $t('admin:contribute.github') }}
                a.ml-3(href='https://github.com/users/NGPixel/sponsorship', :title='$t(`admin:contribute.becomeASponsor`)')
                  img.admin-contribute-media(src='/_assets/img/donate_github.svg', :alt='$t(`admin:contribute.becomeASponsor`)')
              v-tabs-window-item(value='patreon', :transition='false', :reverse-transition='false')
                .text-body-medium.pa-3 {{ $t('admin:contribute.patreon') }}
                a.ml-3(href='https://www.patreon.com/bePatron?u=16744039', :title='$t(`admin:contribute.becomeAPatron`)')
                  img.admin-contribute-media(src='/_assets/img/donate_patreon.png', :alt='$t(`admin:contribute.becomeAPatron`)')
              v-tabs-window-item(value='open-collective', :transition='false', :reverse-transition='false')
                .text-body-medium.pa-3 {{ $t('admin:contribute.openCollective') }}
                a.ml-3(href='https://opencollective.com/wikijs/donate', :title='$t(`admin:contribute.makeADonation`)')
                  img.admin-contribute-media.admin-contribute-media-wide(src='/_assets/img/donate_opencollective.png', :alt='$t(`admin:contribute.makeADonation`)')
              v-tabs-window-item(value='paypal', :transition='false', :reverse-transition='false')
                .text-body-medium.pa-3 {{ $t('admin:contribute.paypal') }}
                .ml-3
                  form(action='https://www.paypal.com/cgi-bin/webscr', method='post', target='_top')
                    input(type='hidden', name='cmd', value='_s-xclick')
                    input(type='hidden', name='hosted_button_id', value='FLV5X255Z9CJU')
                    input(type='image', src='/_assets/img/donate_paypal.png', border='0', name='submit', title='PayPal - The safer, easier way to pay online!', alt='Donate with PayPal button')
                    img(alt='', border='0', src='https://www.paypal.com/en_CA/i/scr/pixel.gif', width='1', height='1')
              v-tabs-window-item(value='ethereum', :transition='false', :reverse-transition='false')
                .text-body-medium.pa-3 {{ $t('admin:contribute.ethereum') }}
                .ml-3
                  .admin-contribute-ethaddress
                    strong Ethereum Address
                    code {{ ethereumAddress }}
                    v-btn.mt-2(size='small', variant='outlined', color='primary', @click='copyAddress')
                      v-icon(start, aria-hidden='true') mdi-content-copy
                      span {{ addressCopied ? 'Copied' : 'Copy address' }}
                  div: img.admin-contribute-media(src='/_assets/img/donate_eth_qr.png', alt='Ethereum donation address QR code')
              v-tabs-window-item(value='tshirts', :transition='false', :reverse-transition='false')
                .text-body-medium.pa-3 {{ $t('admin:contribute.tshirts') }}
                v-card-actions.ml-2
                  v-btn(variant="outlined", :color='$vuetify.theme.current.dark ? `blue-lighten-1` : `primary`', href='https://wikijs.threadless.com', size="large")
                    v-icon(start) mdi-tshirt-crew
                    span {{ $t('admin:contribute.shop') }}
            v-divider.mt-3
            v-list-subheader.text-label-large  {{ $t('admin:contribute.contribute') }}
            .text-body-medium.pl-3
              ul
                i18next(path='admin:contribute.submitAnIdea', tag='li')
                  a(href='https://github.com/PhilosophiMoonbeam/wiki/issues', target='_blank') GitHub issues
                i18next(path='admin:contribute.foundABug', tag='li')
                  a(href='https://github.com/PhilosophiMoonbeam/wiki/issues', target='_blank') GitHub
                i18next(path='admin:contribute.helpTranslate', tag='li')
                  a(href='https://wiki.requarks.io/slack', target='_blank') Slack
            v-divider.mt-3
            v-list-subheader.text-label-large  {{ $t('admin:contribute.spreadTheWord') }}
            .text-body-medium.pl-3
              ul
                li {{ $t('admin:contribute.talkToFriends') }}
                i18next(path='admin:contribute.followUsOnTwitter', tag='li')
                  a(href='https://twitter.com/requarks', target='_blank') Twitter
          v-toolbar(color='indigo', density="compact")
            .text-body-large Sponsors &amp; Backers
          v-container.pa-5(fluid, :class='$vuetify.theme.current.dark ? `bg-grey-darken-3` : `bg-grey-lighten-4`')
            async-state(
              v-if='backersLoading'
              state='loading'
              title='Loading sponsors and backers'
              message='Fetching the latest contributors.'
            )
            async-state(
              v-else-if='backersError'
              state='error'
              title='Sponsors and backers could not be loaded'
              :message='backersError'
              retry-label='Try again'
              @retry='loadBackers'
            )
            async-state(
              v-else-if='backersLoaded && backers.length < 1'
              state='empty'
              title='No sponsors or backers to display'
              message='There are no public contributors to show right now.'
            )
            v-row(v-else density="compact")
              v-col(cols='12', lg='6', xl='4', v-for='backer in backers', :key='backer.id')
                v-card(flat, :class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-grey-lighten-2`')
                  v-list-item
                    template(v-slot:prepend)
                      v-avatar
                        img(v-if='backer.avatar', :src='backer.avatar')
                        v-avatar(v-else, color='blue-grey', size='40')
                          span.text-white.text-body-large {{backer.name[0].toUpperCase()}}
                    v-list-item-title {{backer.name}}
                    v-list-item-subtitle: .text-body-small Since {{ $helpers.formatMoment(backer.joined, 'MMMM DD, YYYY') }} on {{backer.source}}
                    template(v-slot:append)
                      v-btn(v-if='backer.twitter', icon, :href='backer.twitter', target='_blank', :aria-label='`Open ${backer.name} Twitter profile`', :title='`Open ${backer.name} Twitter profile`')
                        v-icon(color='grey', aria-hidden='true') mdi-twitter
                      v-btn(v-if='backer.website', icon, :href='backer.website', target='_blank', :aria-label='`Open ${backer.name} website`', :title='`Open ${backer.name} website`')
                        v-icon(color='grey', aria-hidden='true') mdi-earth
          v-toolbar(color='primary', density="compact")
            .text-body-large Special Thanks
          v-list(lines="two")
            v-list-item
              template(v-slot:prepend)
                v-avatar
                  img(src='https://static.requarks.io/logo/algolia.svg', alt='Algolia')
              v-list-item-title Algolia
              v-list-item-subtitle Algolia is a powerful search-as-a-service solution, made easy to use with API clients, UI libraries, and pre-built integrations.
              template(v-slot:append)
                v-btn(icon, href='https://www.algolia.com/', target='_blank', aria-label='Open Algolia website', title='Open Algolia website')
                  v-icon(color='grey', aria-hidden='true') mdi-earth
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar
                  img(src='https://static.requarks.io/logo/browserstack.svg', alt='Browserstack')
              v-list-item-title BrowserStack
              v-list-item-subtitle BrowserStack is a cloud web and mobile testing platform that enables developers to test their websites and mobile applications.
              template(v-slot:append)
                v-btn(icon, href='https://www.browserstack.com/', target='_blank', aria-label='Open BrowserStack website', title='Open BrowserStack website')
                  v-icon(color='grey', aria-hidden='true') mdi-earth
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar
                  img(src='https://static.requarks.io/logo/cloudflare.svg', alt='Cloudflare')
              v-list-item-title Cloudflare
              v-list-item-subtitle Providing content delivery network services, DDoS mitigation, Internet security and distributed domain name server services.
              template(v-slot:append)
                v-btn(icon, href='https://www.cloudflare.com/', target='_blank', aria-label='Open Cloudflare website', title='Open Cloudflare website')
                  v-icon(color='grey', aria-hidden='true') mdi-earth
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar
                  img(src='https://static.requarks.io/logo/digitalocean.svg', alt='DigitalOcean')
              v-list-item-title DigitalOcean
              v-list-item-subtitle Providing developers and businesses a reliable, easy-to-use cloud computing platform of virtual servers (Droplets), object storage (Spaces), and more.
              template(v-slot:append)
                v-btn(icon, href='https://m.do.co/c/5f7445bfa4d0', target='_blank', aria-label='Open DigitalOcean website', title='Open DigitalOcean website')
                  v-icon(color='grey', aria-hidden='true') mdi-earth
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(rounded='0')
                  img(src='/_assets/svg/logo-icons8.svg', alt='Icons8')
              v-list-item-title Icons8
              v-list-item-subtitle All the Icons You Need. Guaranteed.
              template(v-slot:append)
                v-btn(icon, href='https://icons8.com', target='_blank', aria-label='Open Icons8 website', title='Open Icons8 website')
                  v-icon(color='grey', aria-hidden='true') mdi-earth
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(rounded='0')
                  img(src='https://static.requarks.io/logo/lokalise.png', alt='Lokalise')
              v-list-item-title Lokalise
              v-list-item-subtitle Lokalise is a translation management system built for agile teams who want to automate their localization process.
              template(v-slot:append)
                v-btn(icon, href='https://lokalise.co', target='_blank', aria-label='Open Lokalise website', title='Open Lokalise website')
                  v-icon(color='grey', aria-hidden='true') mdi-earth
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(rounded='0')
                  img(src='https://static.requarks.io/logo/netlify.svg', alt='Netlify')
              v-list-item-title Netlify
              v-list-item-subtitle Deploy modern static websites with Netlify. Get CDN, Continuous deployment, 1-click HTTPS, and all the services you need.
              template(v-slot:append)
                v-btn(icon, href='https://www.netlify.com', target='_blank', aria-label='Open Netlify website', title='Open Netlify website')
                  v-icon(color='grey', aria-hidden='true') mdi-earth
</template>

<script lang='ts'>
import { wikiStore } from '@/store/index.ts'
import { fetchContributors, type ContributorRow } from '../../helpers/contribute-api'
import { getErrorMessage, loadingStart, loadingStop, showNotification } from '../../helpers/root-ui-store'

export default {
  data() {
    return {
      contributeTab: 'github',
      backers: [] as ContributorRow[],
      backersLoading: true,
      backersLoaded: false,
      backersError: '',
      addressCopied: false,
      ethereumAddress: '0xE1d55C19aE86f6Bcbfb17e7f06aCe96BdBb22Cb5'
    }
  },
  created() {
    this.loadBackers().catch(() => {})
  },
  methods: {
    async loadBackers({ notifyError = true }: { notifyError?: boolean } = {}) {
      this.backersLoading = true
      this.backersLoaded = false
      this.backersError = ''
      loadingStart(wikiStore, 'admin-contribute-refresh')
      try {
        this.backers = await fetchContributors(window.fetch.bind(window), 'Contributors response is invalid')
        this.backersLoaded = true
        return true
      } catch (err) {
        this.backers = []
        this.backersLoaded = true
        this.backersError = getErrorMessage(err)
        if (notifyError) {
          showNotification(wikiStore, {
            message: this.backersError,
            style: 'red',
            icon: 'alert'
          })
        }
        throw err
      } finally {
        this.backersLoading = false
        loadingStop(wikiStore, 'admin-contribute-refresh')
      }
    },
    async copyAddress() {
      try {
        await navigator.clipboard.writeText(this.ethereumAddress)
        this.addressCopied = true
        showNotification(wikiStore, {
          message: 'Ethereum address copied.',
          style: 'success',
          icon: 'content-copy'
        })
      } catch (err) {
        showNotification(wikiStore, {
          message: `Unable to copy address: ${getErrorMessage(err)}`,
          style: 'red',
          icon: 'alert'
        })
      }
    }
  }
}
</script>

<style lang='scss'>
.admin-contribute {

  &-tabs {
    .v-tab img {
      height: 24px;
      margin-bottom: 5px;
    }
  }

  &-media {
    display: block;
    width: auto;
    max-width: min(100%, 300px);
    height: auto;

    &-wide {
      width: auto;
    }
  }

  &-ethaddress {
    display: inline-flex;
    max-width: 100%;
    flex-direction: column;
    margin-bottom: 12px;
    border-radius: var(--wiki-control-radius);
    background-color: rgb(var(--v-theme-surface-variant));
    color: rgba(var(--v-theme-on-surface), .72);
    padding: 12px;

    strong {
      display: block;
    }

    code {
      overflow-wrap: anywhere;
      user-select: text;
    }
  }

  ul {
    margin-left: 1rem;
    list-style-type: square;
  }
}
</style>
