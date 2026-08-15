<template lang="pug">
  div(v-intersect.once='onIntersect')
    v-textarea#discussion-new(
      outlined
      flat
      :placeholder='$t(`common:comments.newPlaceholder`)'
      auto-grow
      dense
      rows='3'
      hide-details
      v-model='newcomment'
      color='blue-grey darken-2'
      :background-color='$vuetify.theme.current.dark ? `grey darken-5` : `white`'
      v-if='permissions.write'
      :aria-label='$t(`common:comments.fieldContent`)'
    )
    v-row.mt-2(dense, v-if='!isAuthenticated && permissions.write')
      v-col(cols='12', lg='6')
        v-text-field(
          outlined
          color='blue-grey darken-2'
          :background-color='$vuetify.theme.current.dark ? `grey darken-5` : `white`'
          :placeholder='$t(`common:comments.fieldName`)'
          hide-details
          dense
          autocomplete='name'
          v-model='guestName'
          :aria-label='$t(`common:comments.fieldName`)'
        )
      v-col(cols='12', lg='6')
        v-text-field(
          outlined
          color='blue-grey darken-2'
          :background-color='$vuetify.theme.current.dark ? `grey darken-5` : `white`'
          :placeholder='$t(`common:comments.fieldEmail`)'
          hide-details
          type='email'
          dense
          autocomplete='email'
          v-model='guestEmail'
          :aria-label='$t(`common:comments.fieldEmail`)'
        )
    .comments-actions.d-flex.align-center.pt-3(v-if='permissions.write')
      v-icon.mr-1(color='blue-grey') mdi-language-markdown-outline
      .caption.blue-grey--text {{$t('common:comments.markdownFormat')}}
      v-spacer
      .comments-posting-as.caption(v-if='isAuthenticated')
        i18next(tag='span', path='common:comments.postingAs')
          strong(place='name') {{userDisplayName}}
      v-btn.comments-submit(
        dark
        color='blue-grey darken-2'
        @click='postComment'
        depressed
        :aria-label='$t(`common:comments.postComment`)'
        )
        v-icon(left) mdi-comment
        span.text-none {{$t('common:comments.postComment')}}
    v-divider.mt-3(v-if='permissions.write')
    .pa-5.d-flex.align-center.justify-center(v-if='isLoading && !hasLoadedOnce')
      v-progress-circular(
        indeterminate
        size='20'
        width='1'
        color='blue-grey'
        :aria-label='$t(`common:comments.loading`)'
      )
      .caption.blue-grey--text.pl-3: em {{$t('common:comments.loading')}}
    v-timeline(
      dense
      v-else-if='comments && comments.length > 0'
      )
      v-timeline-item.comments-post(
        color='pink darken-4'
        large
        v-for='cm of comments'
        :key='`comment-` + cm.id'
        :id='`comment-post-id-` + cm.id'
        )
        template(v-slot:icon)
          v-avatar(color='blue-grey')
            //- v-img(src='http://i.pravatar.cc/64')
            span.white--text.title {{cm.initials}}
        v-card.elevation-1
          v-card-text
            .comments-post-actions(v-if='permissions.manage && !isBusy && commentEditId === 0')
              v-icon.mr-3(small, @click='editComment(cm)') mdi-pencil
              v-icon(small, @click='deleteCommentConfirm(cm)') mdi-delete
            .comments-post-name.caption: strong {{cm.authorName}}
            .comments-post-date.overline.grey--text {{ $helpers.formatMoment(cm.createdAt, 'from') }} #[em(v-if='cm.createdAt !== cm.updatedAt') - {{$t('common:comments.modified', { reldate: $helpers.formatMoment(cm.updatedAt, 'from') })}}]
            .comments-post-content.mt-3(v-if='commentEditId !== cm.id', v-html='cm.render')
            .comments-post-editcontent.mt-3(v-else)
              v-textarea(
                outlined
                flat
                auto-grow
                dense
                rows='3'
                hide-details
                v-model='commentEditContent'
                color='blue-grey darken-2'
                :background-color='$vuetify.theme.current.dark ? `grey darken-5` : `white`'
              )
              .d-flex.align-center.pt-3
                v-spacer
                v-btn.mr-3(
                  dark
                  color='blue-grey darken-2'
                  @click='editCommentCancel'
                  outlined
                  )
                  v-icon(left) mdi-close
                  span.text-none {{$t('common:actions.cancel')}}
                v-btn(
                  dark
                  color='blue-grey darken-2'
                  @click='updateComment'
                  depressed
                  )
                  v-icon(left) mdi-comment
                  span.text-none {{$t('common:comments.updateComment')}}
    .pt-5.text-center.body-2.blue-grey--text(v-else-if='permissions.write') {{$t('common:comments.beFirst')}}
    .text-center.body-2.blue-grey--text(v-else) {{$t('common:comments.none')}}

    v-dialog(v-model='deleteCommentDialogShown', max-width='500')
      v-card
        .dialog-header.is-red {{$t('common:comments.deleteConfirmTitle')}}
        v-card-text.pt-5
          span {{$t('common:comments.deleteWarn')}}
          .caption: strong {{$t('common:comments.deletePermanentWarn')}}
        div.v-card-chin
          v-spacer
          v-btn(text, @click='deleteCommentDialogShown = false') {{$t('common:actions.cancel')}}
          v-btn(color='red', dark, @click='deleteComment') {{$t('common:actions.delete')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { useGoTo } from 'vuetify'
import { createComment, deleteComment, fetchComment, fetchComments, updateComment } from '../helpers/comments-api'
import type { CommentRow } from '../helpers/comments-api'
import { wikiStore } from '@/store/index.ts'
import validateValues from '../../shared/validation'
import { getErrorMessage, showNotification } from '../helpers/root-ui-store'

type CommentWithInitials = CommentRow & {
  initials: string
}

type CommentPermissions = {
  write: boolean
  manage: boolean
}

type CommentValidationRule = {
  presence: {
    allowEmpty: boolean
  }
  length?: {
    minimum: number
    maximum?: number
  }
  email?: boolean
}

type CommentValidationRules = {
  comment: CommentValidationRule
  name?: CommentValidationRule
  email?: CommentValidationRule
}

type CommentScrollOptions = {
  duration: number
  offset: number
  easing: 'easeInOutCubic'
}

export default defineComponent({
  setup () {
    return {
      goTo: useGoTo()
    }
  },
  data () {
    return {
      newcomment: '',
      isLoading: true,
      hasLoadedOnce: false,
      comments: [] as CommentWithInitials[],
      guestName: '',
      guestEmail: '',
      commentToDelete: null as CommentWithInitials | null,
      commentEditId: 0,
      commentEditContent: null as string | null,
      deleteCommentDialogShown: false,
      isBusy: false,
      scrollOpts: {
        duration: 1500,
        offset: 0,
        easing: 'easeInOutCubic'
      } as CommentScrollOptions
    }
  },
  computed: {
    pageId(): number { return wikiStore.page.id },
    permissions(): CommentPermissions { return wikiStore.page.effectivePermissions.comments },
    isAuthenticated(): boolean { return wikiStore.user.authenticated },
    userDisplayName(): string { return wikiStore.user.name }
  },
  methods: {
    onIntersect (isIntersecting: boolean, _entries: IntersectionObserverEntry[], _observer: IntersectionObserver): void {
      if (isIntersecting) {
        this.fetch(true)
      }
    },
    async fetch (silent = false) {
      this.isLoading = true
      try {
        const comments = await fetchComments(
          window.fetch.bind(window),
          this.pageId
        )
        this.comments = comments.map(comment => {
          const nameParts = comment.authorName.toUpperCase().split(' ')
          const firstInitial = nameParts[0].charAt(0)
          const lastInitial = nameParts.length > 1 ? nameParts[nameParts.length - 1].charAt(0) : ''
          return {
            ...comment,
            initials: firstInitial + lastInitial
          }
        })
      } catch (err) {
        console.warn(err)
        if (!silent) {
          showNotification(wikiStore, {
            style: 'red',
            message: getErrorMessage(err),
            icon: 'alert'
          })
        }
      }
      this.isLoading = false
      this.hasLoadedOnce = true
    },
    /**
     * Post New Comment
     */
    async postComment () {
      const rules: CommentValidationRules = {
        comment: {
          presence: {
            allowEmpty: false
          },
          length: {
            minimum: 2
          }
        }
      }
      if (!this.isAuthenticated && this.permissions.write) {
        rules.name = {
          presence: {
            allowEmpty: false
          },
          length: {
            minimum: 2,
            maximum: 255
          }
        }
        rules.email = {
          presence: {
            allowEmpty: false
          },
          email: true
        }
      }
      const validationResults = validateValues({
        comment: this.newcomment,
        name: this.guestName,
        email: this.guestEmail
      }, rules, { format: 'flat' }) as string[] | undefined

      if (validationResults) {
        wikiStore.showNotification({
          style: 'red',
          message: validationResults[0],
          icon: 'alert'
        })
        return
      }

      try {
        const response = await createComment(window.fetch.bind(window), {
          pageId: this.pageId,
          replyTo: 0,
          content: this.newcomment,
          guestName: this.guestName,
          guestEmail: this.guestEmail
        })
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.postSuccess'),
          icon: 'check'
        })
        this.newcomment = ''
        await this.fetch()
        this.$nextTick(() => {
          this.goTo(`#comment-post-id-${response.id}`, this.scrollOpts)
        })
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
    },
    /**
     * Show Comment Editing Form
     */
    async editComment (cm: CommentWithInitials) {
      wikiStore.startLoading('comments-edit')
      this.isBusy = true
      try {
        const comment = await fetchComment(window.fetch.bind(window), cm.id)
        this.commentEditContent = comment.content
      } catch (err) {
        console.warn(err)
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      this.commentEditId = cm.id
      this.isBusy = false
      wikiStore.stopLoading('comments-edit')
    },
    /**
     * Cancel Comment Edit
     */
    editCommentCancel () {
      this.commentEditId = 0
      this.commentEditContent = null
    },
    /**
     * Update Comment with new content
     */
    async updateComment () {
      wikiStore.startLoading('comments-edit')
      this.isBusy = true
      try {
        const content = this.commentEditContent
        if (content === null || content.length < 2) {
          throw new Error(this.$t('common:comments.contentMissingError'))
        }
        const response = await updateComment(
          window.fetch.bind(window),
          this.commentEditId,
          content
        )
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.updateSuccess'),
          icon: 'check'
        })

        const cm = this.comments.find(comment => comment.id === this.commentEditId)
        if (!cm) throw new Error('Updated comment is missing from the current comments.')
        cm.render = response.render
        cm.updatedAt = (new Date()).toISOString()
        this.editCommentCancel()
      } catch (err) {
        console.warn(err)
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      this.isBusy = false
      wikiStore.stopLoading('comments-edit')
    },
    /**
     * Show Delete Comment Confirmation Dialog
     */
    deleteCommentConfirm (cm: CommentWithInitials) {
      this.commentToDelete = cm
      this.deleteCommentDialogShown = true
    },
    /**
     * Delete Comment
     */
    async deleteComment () {
      const commentToDelete = this.commentToDelete
      if (!commentToDelete) return
      wikiStore.startLoading('comments-delete')
      this.isBusy = true
      this.deleteCommentDialogShown = false

      try {
        await deleteComment(window.fetch.bind(window), commentToDelete.id)
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.deleteSuccess'),
          icon: 'check'
        })
        this.comments = this.comments.filter(comment => comment.id !== commentToDelete.id)
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      }
      this.isBusy = false
      wikiStore.stopLoading('comments-delete')
    }
  }
})
</script>

<style lang="scss">
.comments-actions {
  flex-wrap: wrap;
  gap: 12px;
}

@media (max-width: 600px) {
  .comments-posting-as {
    margin-left: auto;
  }

  .comments-submit {
    flex: 1 0 100%;
  }
}

.comments-post {
  position: relative;

  &:hover {
    .comments-post-actions {
      opacity: 1;
    }
  }

  &-actions {
    position: absolute;
    top: 16px;
    right: 16px;
    opacity: 0;
    transition: opacity .4s ease;
  }

  &-content {
    > p:first-child {
      padding-top: 0;
    }

    p {
      padding-top: 1rem;
      margin-bottom: 0;
    }

    img {
      max-width: 100%;
      border-radius: 5px;
    }

    code {
      background-color: rgba(mc('pink', '500'), .1);
      box-shadow: none;
    }

    pre > code {
      margin-top: 1rem;
      padding: 12px;
      background-color: #111;
      box-shadow: none;
      border-radius: 5px;
      width: 100%;
      color: #FFF;
      font-weight: 400;
      font-size: .85rem;
      font-family: Roboto Mono, monospace;
    }
  }
}
</style>
