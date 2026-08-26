<template lang="pug">
  div(v-intersect.once='onIntersect')
    v-textarea#discussion-new(
      variant="outlined"
      flat
      :placeholder='$t(`common:comments.newPlaceholder`)'
      auto-grow
      density="compact"
      rows='3'
      hide-details
      v-model='newcomment'
      color="primary"
      bg-color='surface'
      v-if='permissions.write'
      :aria-label='$t(`common:comments.fieldContent`)'
    )
    v-row.mt-2(density="compact", v-if='!isAuthenticated && permissions.write')
      v-col(cols='12', lg='6')
        v-text-field(
          variant="outlined"
          color="primary"
          bg-color='surface'
          :placeholder='$t(`common:comments.fieldName`)'
          hide-details
          density="compact"
          autocomplete='name'
          v-model='guestName'
          :aria-label='$t(`common:comments.fieldName`)'
        )
      v-col(cols='12', lg='6')
        v-text-field(
          variant="outlined"
          color="primary"
          bg-color='surface'
          :placeholder='$t(`common:comments.fieldEmail`)'
          hide-details
          type='email'
          density="compact"
          autocomplete='email'
          v-model='guestEmail'
          :aria-label='$t(`common:comments.fieldEmail`)'
        )
    .comments-actions.d-flex.align-center.pt-3(v-if='permissions.write')
      v-icon.mr-1(color='primary') mdi-language-markdown-outline
      .text-body-small.text-medium-emphasis {{$t('common:comments.markdownFormat')}}
      v-spacer
      .comments-posting-as.text-body-small(v-if='isAuthenticated')
        i18next(tag='span', path='common:comments.postingAs')
          strong(place='name') {{userDisplayName}}
      v-btn.comments-submit(
        color="primary"
        @click='postComment'
        variant="flat"
        :aria-label='$t(`common:comments.postComment`)'
        )
        v-icon(start) mdi-comment
        span.text-none {{$t('common:comments.postComment')}}
    v-divider.mt-3(v-if='permissions.write')
    .pa-5.d-flex.align-center.justify-center(v-if='isLoading && !hasLoadedOnce')
      v-progress-circular(
        indeterminate
        size='20'
        width='1'
        color='primary'
        :aria-label='$t(`common:comments.loading`)'
      )
      .text-body-small.text-medium-emphasis.pl-3: em {{$t('common:comments.loading')}}
    v-timeline(
      density="compact"
      v-else-if='comments && comments.length > 0'
      )
      v-timeline-item.comments-post(
        dot-color="primary"
        size="large"
        v-for='cm of comments'
        :key='`comment-` + cm.id'
        :id='`comment-post-id-` + cm.id'
        )
        template(v-slot:icon)
          v-avatar(color='primary')
            //- v-img(src='http://i.pravatar.cc/64')
            span.text-white.text-headline-small {{cm.initials}}
        v-card.comments-post-card(variant='flat')
          v-card-text
            .comments-post-actions(v-if='permissions.manage && !isBusy && commentEditId === 0')
              v-icon.mr-3(size="small", @click='editComment(cm)') mdi-pencil
              v-icon(size="small", @click='deleteCommentConfirm(cm)') mdi-delete
            .comments-post-name.text-body-small: strong {{cm.authorName}}
            .comments-post-date.text-label-small.text-grey {{ $helpers.formatMoment(cm.createdAt, 'from') }} #[em(v-if='cm.createdAt !== cm.updatedAt') - {{$t('common:comments.modified', { reldate: $helpers.formatMoment(cm.updatedAt, 'from') })}}]
            .comments-post-content.mt-3(v-if='commentEditId !== cm.id', v-html='cm.render')
            .comments-post-editcontent.mt-3(v-else)
              v-textarea(
                variant="outlined"
                flat
                auto-grow
                density="compact"
                rows='3'
                hide-details
                v-model='commentEditContent'
                color="primary"
                bg-color='surface'
              )
              .d-flex.align-center.pt-3
                v-spacer
                v-btn.mr-3(
                  color="primary"
                  @click='editCommentCancel'
                  variant="outlined"
                  )
                  v-icon(start) mdi-close
                  span.text-none {{$t('common:actions.cancel')}}
                v-btn(
                  color="primary"
                  @click='updateComment'
                  variant="flat"
                  )
                  v-icon(start) mdi-comment
                  span.text-none {{$t('common:comments.updateComment')}}
    .comments-empty.pt-5.text-center.text-body-medium.text-medium-emphasis(v-else-if='permissions.write') {{$t('common:comments.beFirst')}}
    .comments-empty.text-center.text-body-medium.text-medium-emphasis(v-else) {{$t('common:comments.none')}}

    v-dialog(v-model='deleteCommentDialogShown', max-width='500')
      v-card
        .dialog-header.is-red {{$t('common:comments.deleteConfirmTitle')}}
        v-card-text.pt-5
          span {{$t('common:comments.deleteWarn')}}
          .text-body-small: strong {{$t('common:comments.deletePermanentWarn')}}
        div.v-card-chin
          v-spacer
          v-btn(variant="text", @click='deleteCommentDialogShown = false') {{$t('common:actions.cancel')}}
          v-btn(color='red', @click='deleteComment') {{$t('common:actions.delete')}}
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

  .v-btn {
    border-radius: 10px;
    font-weight: 650;
  }
}

.comments-post {
  position: relative;

  &:hover,
  &:focus-within {
    .comments-post-actions {
      opacity: 1;
    }
  }

  &-card {
    border: 1px solid rgba(var(--v-border-color), .1);
    border-radius: 14px !important;
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 98%, rgb(var(--v-theme-background)));
  }

  &-actions {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    gap: 4px;
    padding: 5px;
    border: 1px solid rgba(var(--v-border-color), .1);
    border-radius: 9px;
    background: rgb(var(--v-theme-surface));
    opacity: 0;
    transition: opacity .18s ease;

    .v-icon {
      color: rgb(var(--v-theme-primary));
      cursor: pointer;
    }
  }

  &-name {
    color: rgb(var(--v-theme-on-surface));
    font-size: .84rem !important;
  }

  &-date {
    margin-top: 2px;
    color: rgb(var(--v-theme-on-surface)) !important;
    opacity: .52;
  }

  &-content {
    color: rgb(var(--v-theme-on-surface));
    line-height: 1.65;

    > p:first-child {
      padding-top: 0;
    }

    p {
      margin-bottom: 0;
      padding-top: 1rem;
    }

    img {
      max-width: 100%;
      border-radius: 10px;
    }

    code {
      border-radius: 5px;
      background: color-mix(in srgb, rgb(var(--v-theme-primary)) 8%, transparent);
      box-shadow: none;
    }

    pre > code {
      display: block;
      width: 100%;
      margin-top: 1rem;
      padding: 14px;
      border-radius: 10px;
      background: #111827;
      color: #fff;
      font-family: 'Roboto Mono', monospace;
      font-size: .85rem;
      font-weight: 400;
    }
  }
}

.comments-empty {
  padding-block: 26px 8px;
}

@media (max-width: 599.98px) {
  .comments-posting-as {
    margin-left: auto;
  }

  .comments-submit {
    flex: 1 0 100%;
  }

  .comments-post-actions {
    position: static;
    width: fit-content;
    margin: 0 0 10px auto;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .comments-post-actions {
    transition-duration: .01ms !important;
  }
}
</style>
