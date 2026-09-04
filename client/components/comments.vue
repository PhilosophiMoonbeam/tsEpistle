<template lang="pug">
  div.comments(v-intersect.once='onIntersect')
    form.comments-composer(
      v-if='permissions.write'
      :aria-label='$t(`common:comments.postComment`)'
      :aria-busy='isPosting'
      novalidate
      @submit.prevent='postComment'
    )
      v-textarea#discussion-new.comments-composer-field(
        variant="outlined"
        :placeholder='$t(`common:comments.newPlaceholder`)'
        auto-grow
        density="compact"
        rows='3'
        hide-details
        v-model='newcomment'
        color="primary"
        bg-color='surface'
        :aria-label='$t(`common:comments.fieldContent`)'
        :disabled='isPosting'
        required
      )
      v-row.comments-guest-fields.mt-2(density="compact", v-if='!isAuthenticated')
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
            :disabled='isPosting'
            required
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
            :disabled='isPosting'
            required
          )
      .comments-actions.d-flex.align-center.pt-3
        .comments-format.d-flex.align-center
          v-icon.mr-1(color='primary') mdi-language-markdown-outline
          .text-body-small.text-medium-emphasis {{$t('common:comments.markdownFormat')}}
        v-spacer
        .comments-posting-as.text-body-small(v-if='isAuthenticated')
          i18next(tag='span', path='common:comments.postingAs')
            strong(place='name') {{userDisplayName}}
        v-btn.comments-submit(
          color="primary"
          type='submit'
          variant="flat"
          :aria-label='$t(`common:comments.postComment`)'
          :loading='isPosting'
          :disabled='isPosting'
        )
          v-icon(start) mdi-comment
          span.text-none {{$t('common:comments.postComment')}}
    async-state.comments-loading(
      v-if='isLoading && (!hasLoadedOnce || comments.length === 0)'
      state='loading'
      :title='$t(`common:comments.loading`)'
    )
    async-state(
      v-else-if='fetchError'
      state='error'
      :title='$t(`common:error.unexpected`)'
      :message='fetchError'
      :retry-label='$t(`common:actions.refresh`)'
      @retry='fetch(false)'
    )
    v-timeline.comments-thread(
      density="compact"
      v-else-if='comments.length > 0'
      :aria-label='$t(`common:comments.title`)'
    )
      v-timeline-item.comments-post(
        dot-color="primary"
        size="large"
        v-for='cm of comments'
        :key='`comment-` + cm.id'
        :id='`comment-post-id-` + cm.id'
        )
        template(v-slot:icon)
          v-avatar(color='primary', aria-hidden='true')
            //- v-img(src='http://i.pravatar.cc/64')
            span.text-on-primary.text-headline-small {{cm.initials}}
        v-card.comments-post-card(
          variant='flat'
          tag='article'
          :aria-labelledby='`comment-author-${cm.id}`'
        )
          v-card-text
            .comments-post-actions(v-if='permissions.manage && !isBusy && commentEditId === 0')
              v-btn(
                icon
                size='small'
                variant='text'
                :aria-label='$t(`common:comments.updateComment`) + `: ` + cm.authorName'
                @click='editComment(cm)'
              ): v-icon(size="small") mdi-pencil
              v-btn(
                icon
                size='small'
                variant='text'
                :aria-label='$t(`common:comments.deleteConfirmTitle`) + `: ` + cm.authorName'
                @click='deleteCommentConfirm(cm)'
              ): v-icon(size="small") mdi-delete
            .comments-post-name.text-body-small(:id='`comment-author-${cm.id}`'): strong {{cm.authorName}}
            .comments-post-date.text-label-small {{ $helpers.formatMoment(cm.createdAt, 'from') }} #[em(v-if='cm.createdAt !== cm.updatedAt') - {{$t('common:comments.modified', { reldate: $helpers.formatMoment(cm.updatedAt, 'from') })}}]
            .comments-post-content.mt-3(v-if='commentEditId !== cm.id', v-html='cm.render')
            form.comments-post-editcontent.mt-3(v-else, novalidate, @submit.prevent='updateComment')
              v-textarea(
                variant="outlined"
                auto-grow
                density="compact"
                rows='3'
                hide-details
                v-model='commentEditContent'
                :disabled='isBusy'
                color="primary"
                bg-color='surface'
                :aria-label='$t(`common:comments.fieldContent`)'
                required
              )
              .d-flex.align-center.pt-3
                v-spacer
                v-btn.mr-3(
                  color="primary"
                  type='button'
                  @click='editCommentCancel'
                  variant="outlined"
                  :disabled='isBusy'
                )
                  v-icon(start) mdi-close
                  span.text-none {{$t('common:actions.cancel')}}
                v-btn(
                  color="primary"
                  type='submit'
                  variant="flat"
                  :loading='isBusy'
                  :disabled='isBusy'
                )
                  v-icon(start) mdi-comment
                  span.text-none {{$t('common:comments.updateComment')}}
    async-state.comments-empty(
      v-else-if='permissions.write'
      state='empty'
      :title='$t(`common:comments.beFirst`)'
    )
    async-state.comments-empty(
      v-else
      state='empty'
      :title='$t(`common:comments.none`)'
    )

    v-dialog(
      v-model='deleteCommentDialogShown'
      max-width='500'
      :aria-label='$t(`common:comments.deleteConfirmTitle`)'
    )
      v-card.comments-delete-dialog
        .dialog-header.comments-delete-header {{$t('common:comments.deleteConfirmTitle')}}
        v-card-text.pt-5
          span {{$t('common:comments.deleteWarn')}}
          .text-body-small: strong {{$t('common:comments.deletePermanentWarn')}}
        v-card-actions
          v-spacer
          v-btn(variant="text", @click='deleteCommentDialogShown = false', :disabled='isBusy') {{$t('common:actions.cancel')}}
          v-btn(color='error', variant='flat', @click='deleteComment', :loading='isBusy', :disabled='isBusy') {{$t('common:actions.delete')}}
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { markRaw } from 'vue'
import { useGoTo } from 'vuetify'
import { createComment, deleteComment, fetchComment, fetchComments, updateComment } from '../helpers/comments-api'
import type { CommentRow } from '../helpers/comments-api'
import { wikiStore } from '@/store/index.ts'
import validateValues from '../../shared/validation'
import { getErrorMessage, showNotification } from '../helpers/root-ui-store'
import AsyncState from '@/components/common/async-state.vue'
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
  components: {
    AsyncState
  },
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
      fetchError: '',
      fetchGeneration: 0,
      fetchController: null as AbortController | null,
      hasIntersected: false,
      isPosting: false,
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
  watch: {
    pageId (pageId: number, previousPageId: number) {
      if (pageId === previousPageId) return
      this.fetchController?.abort()
      this.fetchController = null
      this.fetchGeneration += 1
      this.comments = []
      this.hasLoadedOnce = false
      this.fetchError = ''
      this.commentToDelete = null
      this.commentEditId = 0
      this.commentEditContent = null
      this.deleteCommentDialogShown = false
      if (this.hasIntersected) void this.fetch(true)
    }
  },
  beforeUnmount () {
    this.fetchGeneration += 1
    this.fetchController?.abort()
    this.fetchController = null
  },
  methods: {
    onIntersect (isIntersecting: boolean, _entries: IntersectionObserverEntry[], _observer: IntersectionObserver): void {
      if (!isIntersecting) return
      this.hasIntersected = true
      void this.fetch(true)
    },
    async fetch (silent = false) {
      this.fetchController?.abort()
      const controller = markRaw(new AbortController())
      this.fetchController = controller
      const requestId = ++this.fetchGeneration
      this.isLoading = true
      this.fetchError = ''
      try {
        const comments = await fetchComments(
          (url, options) => window.fetch(url, { ...options, signal: controller.signal }),
          this.pageId
        )
        if (requestId !== this.fetchGeneration) return
        this.comments = comments.map(comment => {
          const nameParts = comment.authorName.trim().toUpperCase().split(/\s+/)
          const firstInitial = nameParts[0]?.charAt(0) ?? ''
          const lastInitial = nameParts.length > 1 ? nameParts[nameParts.length - 1]?.charAt(0) ?? '' : ''
          return {
            ...comment,
            initials: firstInitial + lastInitial
          }
        })
      } catch (err) {
        if (requestId !== this.fetchGeneration) return
        console.warn(err)
        this.fetchError = getErrorMessage(err)
        if (!silent) {
          showNotification(wikiStore, {
            style: 'red',
            message: this.fetchError,
            icon: 'alert'
          })
        }
      } finally {
        if (requestId === this.fetchGeneration) {
          this.fetchController = null
          this.isLoading = false
          this.hasLoadedOnce = true
        }
      }
    },
    /**
     * Post New Comment
     */
    async postComment () {
      if (this.isPosting) return
      const pageId = this.pageId
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

      this.isPosting = true
      try {
        const response = await createComment(window.fetch.bind(window), {
          pageId,
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
        if (pageId !== this.pageId) return
        this.newcomment = ''
        await this.fetch()
        if (pageId !== this.pageId || !this.comments.some(comment => comment.id === response.id)) return
        this.$nextTick(() => {
          void this.goTo(`#comment-post-id-${response.id}`, this.scrollOpts)
        })
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      } finally {
        this.isPosting = false
      }
    },
    /**
     * Show Comment Editing Form
     */
    async editComment (cm: CommentWithInitials) {
      if (this.isBusy) return
      const pageId = this.pageId
      wikiStore.startLoading('comments-edit')
      this.isBusy = true
      try {
        const comment = await fetchComment(window.fetch.bind(window), cm.id)
        if (pageId !== this.pageId) return
        this.commentEditContent = comment.content
        this.commentEditId = cm.id
      } catch (err) {
        if (pageId !== this.pageId) return
        console.warn(err)
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      } finally {
        this.isBusy = false
        wikiStore.stopLoading('comments-edit')
      }
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
      if (this.isBusy) return
      const pageId = this.pageId
      const commentId = this.commentEditId
      wikiStore.startLoading('comments-edit')
      this.isBusy = true
      try {
        const content = this.commentEditContent
        if (content === null || content.trim().length < 2) {
          throw new Error(this.$t('common:comments.contentMissingError'))
        }
        const response = await updateComment(
          window.fetch.bind(window),
          commentId,
          content
        )
        if (pageId !== this.pageId || commentId !== this.commentEditId) return
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.updateSuccess'),
          icon: 'check'
        })
        const cm = this.comments.find(comment => comment.id === commentId)
        if (cm) {
          cm.render = response.render
          cm.updatedAt = (new Date()).toISOString()
        }
        this.editCommentCancel()
      } catch (err) {
        console.warn(err)
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      } finally {
        this.isBusy = false
        wikiStore.stopLoading('comments-edit')
      }
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
      if (this.isBusy) return
      const commentToDelete = this.commentToDelete
      if (!commentToDelete) return
      const pageId = this.pageId
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
        if (pageId === this.pageId) {
          this.comments = this.comments.filter(comment => comment.id !== commentToDelete.id)
        }
        this.commentToDelete = null
      } catch (err) {
        wikiStore.showNotification({
          style: 'red',
          message: getErrorMessage(err),
          icon: 'alert'
        })
      } finally {
        this.isBusy = false
        wikiStore.stopLoading('comments-delete')
      }
    }
  }
})
</script>

<style lang="scss">
.comments {
  min-width: 0;
}

.comments-composer {
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--wiki-accent-spectral) 5%, transparent), transparent 55%),
    var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-xs), var(--wiki-shadow-inset);

  .v-field {
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken);
  }
}

.comments-composer-field textarea {
  line-height: var(--wiki-leading-body);
}

.comments-guest-fields {
  gap: var(--wiki-space-2);

  .v-col {
    min-width: 0;
  }
}

.comments-actions {
  flex-wrap: wrap;
  gap: var(--wiki-space-3);

  .v-btn {
    border-radius: var(--wiki-control-radius);
    font-weight: 650;
    text-transform: none;
  }
}

.comments-format,
.comments-posting-as {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
}

.comments-loading,
.comments-empty {
  margin-top: var(--wiki-space-4);
}

.comments-thread {
  margin-top: var(--wiki-space-4);

  .v-timeline-divider__dot {
    border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 28%, transparent);
    box-shadow: var(--wiki-shadow-xs);
  }

  .v-timeline-divider__inner-dot {
    background: var(--wiki-accent-warm) !important;
  }

  .v-timeline-item__body {
    min-width: 0;
  }
}

.comments-post {
  position: relative;

  &:hover,
  &:focus-within {
    .comments-post-actions {
      opacity: 1;
    }

    .comments-post-card {
      border-color: var(--wiki-surface-border-strong);
      box-shadow: var(--wiki-shadow-sm);
    }
  }

  &-card {
    overflow: hidden;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius) !important;
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-xs);
    transition:
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);

    > .v-card-text {
      padding: var(--wiki-space-4);
    }
  }

  &-actions {
    position: absolute;
    z-index: 1;
    inset-block-start: var(--wiki-space-3);
    inset-inline-end: var(--wiki-space-3);
    display: flex;
    gap: var(--wiki-space-1);
    padding: var(--wiki-space-1);
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-raised);
    box-shadow: var(--wiki-shadow-xs);
    transition: opacity var(--wiki-motion-fast) var(--wiki-motion-ease);

    .v-btn {
      min-width: var(--wiki-control-height);
      min-height: var(--wiki-control-height);
      color: var(--wiki-accent-warm);
    }
  }

  &-name {
    max-width: calc(100% - 7rem);
    color: rgb(var(--v-theme-on-surface));
    font-size: .875rem !important;
  }

  &-date {
    margin-top: var(--wiki-space-1);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
  }

  &-content {
    min-width: 0;
    overflow-wrap: anywhere;
    color: rgb(var(--v-theme-on-surface));
    line-height: var(--wiki-leading-body);

    > p:first-child {
      padding-top: 0;
    }

    p {
      margin-bottom: 0;
      padding-top: var(--wiki-space-4);
    }

    a {
      color: var(--wiki-accent-warm);
      text-underline-offset: var(--wiki-space-1);
    }

    img {
      max-width: 100%;
      border-radius: var(--wiki-control-radius);
    }

    code {
      border-radius: var(--wiki-radius-xs);
      background: color-mix(in srgb, var(--wiki-accent-spectral) 10%, transparent);
      box-shadow: none;
    }

    pre {
      max-width: 100%;
      overflow: auto;
      margin-top: var(--wiki-space-4);
    }

    pre > code {
      display: block;
      width: max-content;
      min-width: 100%;
      margin-top: 0;
      padding: var(--wiki-space-4);
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-control-radius);
      background: var(--wiki-surface-sunken);
      color: rgb(var(--v-theme-on-surface));
      font-family: var(--wiki-font-mono);
      font-size: .85rem;
      font-weight: 400;
    }
  }
}

.comments-post-editcontent {
  padding-top: var(--wiki-space-2);
  border-top: 1px solid var(--wiki-surface-border);
}

.comments-delete-dialog {
  overflow: hidden;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius) !important;
  background: var(--wiki-surface-raised);
  box-shadow: var(--wiki-shadow-lg);
}

.comments-delete-header {
  border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-error)) 22%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 10%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-on-surface));
}

@media (hover: hover) and (pointer: fine) {
  .comments-post-actions {
    opacity: 0;
  }
}

@media (max-width: 599px) {
  .comments-composer {
    padding: var(--wiki-space-3);
    border-radius: var(--wiki-control-radius);
  }

  .comments-actions {
    align-items: stretch !important;
  }

  .comments-format {
    flex: 1 1 auto;
  }

  .comments-posting-as {
    margin-inline-start: auto;
  }

  .comments-submit {
    flex: 1 0 100%;
  }

  .comments-thread {
    .v-timeline-divider {
      min-width: calc(var(--wiki-control-height) + var(--wiki-space-2));
    }

    .v-timeline-item__body {
      padding-inline-start: var(--wiki-space-2);
    }
  }

  .comments-post-card > .v-card-text {
    padding: var(--wiki-space-3);
  }

  .comments-post-actions {
    position: static;
    width: fit-content;
    margin: 0 0 var(--wiki-space-2);
    margin-inline-start: auto;
    opacity: 1;
  }

  .comments-post-name {
    max-width: none;
  }
}

@media (forced-colors: active) {
  .comments-composer,
  .comments-post-card,
  .comments-post-actions,
  .comments-delete-dialog {
    border-color: CanvasText;
  }
}

@media (prefers-reduced-motion: reduce) {
  .comments-post-actions,
  .comments-post-card {
    transition-duration: .01ms !important;
  }
}
</style>
