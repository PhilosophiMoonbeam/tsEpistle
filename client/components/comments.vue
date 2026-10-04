<template lang="pug">
  div.comments(v-intersect.once='onIntersect')
    header.comments-heading
      h2 {{ $t('common:comments.title') }}
      span.comments-count(v-if='hasLoadedOnce') {{ comments.length }}
    v-alert.mb-4(v-if='availability && (availability.closed || !availability.enabled)', type='info', variant='tonal') {{ availability.closed ? $t('common:comments.closed') : $t('common:comments.unavailable') }}
    v-alert.mb-4(v-if='readinessBlocked', type='warning', variant='tonal', role='status', aria-live='polite')
      .d-flex.align-center.ga-2
        span {{ readinessMessage }}
        v-spacer
        v-btn(size='small', variant='text', prepend-icon='mdi-refresh', :loading='connectionRetrying', :disabled='connectionRetrying', @click='retryFetch') {{ readinessRetryLabel }}

    form.comments-composer(
      v-if='permissions.write && (connectionBlocked || !authorityReady || availability?.canPost)'
      :aria-label='$t(`common:comments.postComment`)'
      :aria-busy='isPosting'
      novalidate
      @submit.prevent='postComment'
    )
      h3.comments-composer-title {{ replyTo > 0 ? $t('common:comments.replyTo', { name: replyAuthor, interpolation: { escapeValue: false } }) : $t('common:comments.postComment') }}
      .comments-replying.d-flex.align-center.mb-3(v-if='replyTo > 0')
        v-icon.mr-2(size='18' aria-hidden='true') mdi-reply
        span.text-body-small
          | {{ replyingTo.before }}
          strong {{ replyAuthor }}
          | {{ replyingTo.after }}
        v-spacer
        v-btn(icon size='x-small' variant='text' type='button' :aria-label='$t(`common:comments.cancelReply`)' @click='cancelReply')
          v-icon(size='18') mdi-close
      v-textarea#discussion-new.comments-composer-field(
        ref='newCommentField'
        variant="outlined"
        :label='$t(`common:comments.fieldContent`)'
        :placeholder='$t(`common:comments.newPlaceholder`)'
        persistent-placeholder
        auto-grow
        density="compact"
        rows='3'
        hide-details
        v-model='newcomment'
        @input='handleComposerInput'
        @click='queueMentionSearch'
        @keyup='queueMentionSearch'
        @keydown='handleMentionKeydown'
        @compositionstart='handleMentionCompositionStart'
        @compositionend='handleMentionCompositionEnd'
        color="primary"
        bg-color='surface'
        :aria-label='$t(`common:comments.fieldContent`)'
        role='combobox'
        aria-autocomplete='list'
        aria-controls='comment-mention-options'
        :aria-expanded='mentionCandidates.length > 0'
        :aria-activedescendant='activeMentionOptionId'
        :disabled='isPosting'
        required
      )
      v-card.comments-mentions(v-if='mentionCandidates.length > 0' variant='outlined')
        v-list#comment-mention-options(density='compact', role='listbox', :aria-label='$t(`common:comments.mentionSuggestions`)')
          v-list-item(
            v-for='(candidate, candidateIndex) of mentionCandidates'
            :id='`mention-option-${candidate.id}`'
            :key='candidate.handle'
            :active='mentionIndex === candidateIndex'
            role='option'
            :aria-selected='mentionIndex === candidateIndex'
            prepend-icon='mdi-at'
            :title='`@${candidate.handle}`'
            :subtitle='candidate.name'
            @click='insertMention(candidate)'
            @mouseenter='mentionIndex = candidateIndex'
          )
      v-row.comments-guest-fields.mt-2(density="compact", v-if='!isAuthenticated')
        v-col(cols='12', lg='6')
          v-text-field(
            variant="outlined"
            color="primary"
            bg-color='surface'
            :label='$t(`common:comments.fieldName`)'
            hide-details
            density="compact"
            autocomplete='name'
            v-model='guestName'
            @input='noteComposerInput'
            :aria-label='$t(`common:comments.fieldName`)'
            :disabled='isPosting'
            required
          )
        v-col(cols='12', lg='6')
          v-text-field(
            variant="outlined"
            color="primary"
            bg-color='surface'
            :label='$t(`common:comments.fieldEmail`)'
            hide-details
            type='email'
            density="compact"
            autocomplete='email'
            v-model='guestEmail'
            @input='noteComposerInput'
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
          prepend-icon='mdi-comment'
          :aria-label='$t(`common:comments.postComment`)'
          :loading='isPosting'
          :disabled='isPosting || !commentReady'
        )
          span.text-none {{$t('common:comments.postComment')}}
    v-alert.mb-3(v-if='fetchError && !readinessBlocked && comments.length > 0', type='error', variant='tonal', role='alert')
      .d-flex.align-center.ga-2
        span {{ fetchError }}
        v-btn(variant='text', prepend-icon='mdi-refresh', :loading='isLoading', @click='retryFetch') {{ $t('common:actions.refresh') }}
    async-state.comments-loading(
      v-if='isLoading && (!hasLoadedOnce || comments.length === 0)'
      state='loading'
      :title='$t(`common:comments.loading`)'
    )
    async-state(
      v-else-if='fetchError && !readinessBlocked && comments.length === 0'
      state='error'
      :title='$t(`common:error.unexpected`)'
      :message='fetchError'
      :retry-label='$t(`common:actions.refresh`)'
      @retry='retryFetch'
    )
    section.comments-thread(
      v-else-if='comments.length > 0'
      :aria-label='$t(`common:comments.title`)'
    )
      .comments-thread-status(role='status' aria-live='polite')
        span {{ batchStart + 1 }}–{{ batchStart + visibleComments.length }} / {{ orderedComments.length }}
        span {{ $t('common:comments.loadedDiscussion') }}
      .comments-post(
        v-for='cm of visibleComments'
        :class='{ "comments-post--reply": cm.replyTo > 0 }'
        :key='`comment-` + cm.id'
        :id='`comment-post-id-` + cm.id'
      )
        v-card.comments-post-card(
          variant='flat'
          tag='article'
          :aria-labelledby='`comment-author-${cm.id}`'
        )
          v-card-text
            .comments-post-actions(v-if='!isBusy && commentEditId === 0')
              v-btn(
                v-if='commentReady'
                icon
                size='small'
                variant='text'
                :aria-label='$t(`common:comments.replyTo`, { name: cm.authorName, interpolation: { escapeValue: false } })'
                @click='startReply(cm)'
              ): v-icon(size="small") mdi-reply
              v-btn(
                v-if='permissions.manage'
                icon
                size='small'
                variant='text'
                :aria-label='$t(`common:comments.updateComment`) + `: ` + cm.authorName'
                :disabled='!managementReady'
                @click='editComment(cm)'
              ): v-icon(size="small") mdi-pencil
              v-btn(
                icon
                v-if='permissions.manage'
                size='small'
                variant='text'
                :aria-label='$t(`common:comments.deleteConfirmTitle`) + `: ` + cm.authorName'
                :disabled='!managementReady'
                @click='deleteCommentConfirm(cm)'
              ): v-icon(size="small") mdi-delete
            .comments-post-name.text-body-small(:id='`comment-author-${cm.id}`'): strong {{cm.authorName}}
            .comments-post-date.text-label-small {{ $helpers.formatMoment(cm.createdAt, 'from') }} #[em(v-if='cm.createdAt !== cm.updatedAt') - {{$t('common:comments.modified', { reldate: $helpers.formatMoment(cm.updatedAt, 'from') })}}]
            button.comments-parent-link(v-if='cm.replyTo > 0', type='button', @click='openParentComment(cm.replyTo)')
              v-icon(size='16' aria-hidden='true') mdi-subdirectory-arrow-right
              span {{ $t('common:comments.replyTo', { name: commentAuthor(cm.replyTo), interpolation: { escapeValue: false } }) }}
            .comments-post-content.mt-3(v-if='commentEditId !== cm.id', v-html='cm.render')
            form.comments-post-editcontent.mt-3(v-else, novalidate, @submit.prevent='updateComment')
              v-textarea(
                variant="outlined"
                :label='$t(`common:comments.updateComment`)'
                auto-grow
                density="compact"
                rows='3'
                hide-details
                v-model='commentEditContent'
                @input='noteEditInput'
                :disabled='isBusy'
                color="primary"
                bg-color='surface'
                :aria-label='$t(`common:comments.fieldContent`)'
                required
              )
              .d-flex.align-center.pt-3
                v-spacer
                v-btn.me-3(
                  color="primary"
                  type='button'
                  @click='editCommentCancel'
                  variant="outlined"
                  prepend-icon='mdi-close'
                  :disabled='isBusy'
                )
                  span.text-none {{$t('common:actions.cancel')}}
                v-btn(
                  prepend-icon='mdi-comment'
                  type='submit'
                  variant="flat"
                  :loading='isBusy'
                  :disabled='isBusy || !managementReady'
                )
                  span.text-none {{$t('common:comments.updateComment')}}
      nav.comments-batches(v-if='orderedComments.length > commentBatchSize', :aria-label='$t(`common:comments.loadedDiscussionBatches`)')
        v-btn(variant='outlined', prepend-icon='mdi-chevron-left', :disabled='batchStart === 0 || isBusy || commentEditId > 0', @click='changeCommentBatch(-1)') {{ $t('common:comments.previousComments') }}
        span {{ Math.floor(batchStart / commentBatchSize) + 1 }} / {{ Math.ceil(orderedComments.length / commentBatchSize) }}
        v-btn(variant='outlined', append-icon='mdi-chevron-right', :disabled='batchStart + visibleComments.length >= orderedComments.length || isBusy || commentEditId > 0', @click='changeCommentBatch(1)') {{ $t('common:comments.nextComments') }}
    async-state.comments-empty(
      v-else-if='permissions.write && availability?.canPost'
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
          v-btn(color='error', variant='flat', @click='deleteComment', :loading='isBusy', :disabled='isBusy || !managementReady') {{$t('common:actions.delete')}}
</template>

<script lang='ts'>
import { defineComponent, markRaw } from 'vue'
import { useGoTo } from 'vuetify'
import { CommentApiError, createComment, deleteComment, fetchComment, fetchComments, fetchDiscussionAvailability, fetchMentionCandidates, updateComment } from '../helpers/comments-api'
import type { CommentOutcomeKind, CommentRow, MentionCandidate } from '../helpers/comments-api'
import { wikiStore } from '@/store/index.ts'
import validateValues from '../../shared/validation'
import { getErrorMessage, showNotification } from '../helpers/root-ui-store'
import { pwaState, retryServerConnection } from '../helpers/pwa'
import AsyncState from '@/components/common/async-state.vue'

type CommentWithInitials = CommentRow & {
  initials: string
}

type CommentAvailability = {
  enabled: boolean
  closed: boolean
  canPost: boolean
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

type MentionRange = { start: number; end: number }

type CommentContext = {
  pageId: number
  ownerId: number
  pageGeneration: number
  ownerGeneration: number
  componentGeneration: number
  transportGeneration: number
}

type ComposerSnapshot = {
  pageId: number
  replyTo: number
  content: string
  guestName: string
  guestEmail: string
  revision: number
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
      availability: null as CommentAvailability | null,
      authorityReady: false,
      authorityError: '',
      authorityErrorKind: null as CommentOutcomeKind | null,
      activeContextKey: '',
      activePageId: null as number | null,
      activeOwnerId: null as number | null,
      pageGeneration: 0,
      ownerGeneration: 0,
      componentGeneration: 1,
      transportGeneration: 0,
      newcomment: '',
      replyTo: 0,
      replyAuthor: '',
      mentionCandidates: [] as MentionCandidate[],
      mentionRange: null as MentionRange | null,
      mentionGeneration: 0,
      mentionIndex: -1,
      mentionTimer: null as number | null,
      mentionController: null as AbortController | null,
      mentionComposing: false,
      isLoading: true,
      hasLoadedOnce: false,
      fetchError: '',
      fetchGeneration: 0,
      fetchController: null as AbortController | null,
      hasIntersected: false,
      reportedUnavailableAnchor: '',
      isPosting: false,
      postGeneration: 0,
      composerRevision: 0,
      uncertainCreate: false,
      comments: [] as CommentWithInitials[],
      commentBatchSize: 40,
      commentBatchOffset: 0,
      guestName: '',
      guestEmail: '',
      commentToDelete: null as CommentWithInitials | null,
      deleteGeneration: 0,
      commentEditId: 0,
      commentEditContent: null as string | null,
      commentEditRevision: 0,
      editGeneration: 0,
      deleteCommentDialogShown: false,
      isBusy: false,
      connectionRetrying: false,
      retryGeneration: 0,
      connectionPaused: false,
      scrollOpts: {
        duration: 1500,
        offset: 0,
        easing: 'easeInOutCubic'
      } as CommentScrollOptions
    }
  },
  computed: {
    pageId(): number { return wikiStore.page.id },
    ownerId(): number {
      const id = wikiStore.user.id
      return this.isAuthenticated && Number.isSafeInteger(id) && id > 0 ? id : 0
    },
    contextKey(): string { return `${this.ownerId}:${this.pageId}` },
    permissions(): CommentPermissions { return wikiStore.page.effectivePermissions.comments },
    pwaConnectionState(): string { return pwaState.connectionState },
    connectionUnavailable(): boolean {
      return pwaState.connectionState !== 'online'
    },
    connectionBlocked(): boolean {
      return this.connectionPaused || this.connectionUnavailable
    },
    readinessBlocked(): boolean {
      return this.connectionBlocked || this.authorityError.length > 0
    },
    readinessMessage(): string {
      if (this.connectionBlocked) {
        if (this.pwaConnectionState === 'checking') return this.$t('common:comments.checkingConnection')
        if (this.pwaConnectionState === 'server-unavailable') return this.$t('common:comments.serverUnavailable')
        return this.$t('common:comments.connectionRequiredChange')
      }
      return this.authorityError || this.$t('common:comments.accessNotReady')
    },
    readinessRetryLabel(): string {
      return this.connectionBlocked ? this.$t('common:comments.retryConnection') : this.$t('common:comments.retry')
    },
    // Keeps the author in its own <strong> wherever the locale puts {{name}}.
    replyingTo(): { before: string; after: string } {
      const marker = this.$t('common:comments.name')
      const sentence = String(this.$t('common:comments.replyingTo', { name: marker, interpolation: { escapeValue: false } }))
      const index = sentence.indexOf(marker)
      if (index < 0) return { before: `${sentence} `, after: '' }
      return { before: sentence.slice(0, index), after: sentence.slice(index + marker.length) }
    },
    commentReady(): boolean {
      return this.authorityReady && !this.connectionBlocked && this.permissions.write && this.availability?.canPost === true
    },
    managementReady(): boolean {
      return this.authorityReady && !this.connectionBlocked && this.permissions.manage
    },
    isAuthenticated(): boolean { return wikiStore.user.authenticated },
    userDisplayName(): string { return wikiStore.user.name },
    activeMentionOptionId(): string | undefined {
      const candidate = this.mentionCandidates[this.mentionIndex]
      return candidate ? `mention-option-${candidate.id}` : undefined
    },
    orderedComments(): CommentWithInitials[] {
      const replies = new Map<number, CommentWithInitials[]>()
      const ids = new Set(this.comments.map(comment => comment.id))
      for (const comment of this.comments) {
        const siblings = replies.get(comment.replyTo)
        if (siblings) siblings.push(comment)
        else replies.set(comment.replyTo, [comment])
      }
      const ordered: CommentWithInitials[] = []
      const visited = new Set<number>()
      const append = (root: CommentWithInitials): void => {
        const pending = [root]
        while (pending.length > 0) {
          const comment = pending.pop()!
          if (visited.has(comment.id)) continue
          visited.add(comment.id)
          ordered.push(comment)
          const children = replies.get(comment.id) ?? []
          for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!)
        }
      }
      this.comments.filter(comment => comment.replyTo === 0 || !ids.has(comment.replyTo)).forEach(append)
      this.comments.forEach(append)
      return ordered
    },
    batchStart(): number {
      const lastBatch = Math.max(0, Math.ceil(this.orderedComments.length / this.commentBatchSize) - 1)
      return Math.min(this.commentBatchOffset, lastBatch) * this.commentBatchSize
    },
    visibleComments(): CommentWithInitials[] {
      return this.orderedComments.slice(this.batchStart, this.batchStart + this.commentBatchSize)
    }
  },
  watch: {
    contextKey: {
      handler (value: string, previous: string) {
        if (value === previous && value === this.activeContextKey) return
        this.rotateContext(value)
        if (this.hasIntersected && !this.connectionBlocked) void this.fetch(true)
      },
      flush: 'sync'
    },
    pwaConnectionState: {
      handler (state: string, previous: string) {
        if (state === previous) return
        this.transportGeneration += 1
        if (state !== 'online') {
          this.connectionPaused = true
          this.authorityReady = false
          this.availability = null
          this.authorityErrorKind = 'transport'
          this.authorityError = state === 'server-unavailable'
            ? this.$t('common:comments.serverUnavailable')
            : state === 'checking'
              ? this.$t('common:comments.checkingConnection')
              : this.$t('common:comments.connectionRequired')
          this.fetchController?.abort()
          this.fetchController = null
          this.fetchGeneration += 1
          this.isLoading = false
          this.fetchError = this.authorityError
          return
        }
        if (this.connectionPaused) {
          this.connectionPaused = false
          if (this.authorityErrorKind === 'transport') {
            this.authorityError = ''
            this.authorityErrorKind = null
          }
          if (this.hasIntersected) void this.fetch(true)
        }
      },
      flush: 'sync'
    }
  },
  beforeUnmount () {
    this.componentGeneration += 1
    this.transportGeneration += 1
    this.fetchGeneration += 1
    this.postGeneration += 1
    this.editGeneration += 1
    this.deleteGeneration += 1
    this.retryGeneration += 1
    this.fetchController?.abort()
    this.fetchController = null
    this.mentionController?.abort()
    this.mentionController = null
    if (this.mentionTimer !== null) window.clearTimeout(this.mentionTimer)
    this.mentionTimer = null
    wikiStore.stopLoading('comments-edit')
    wikiStore.stopLoading('comments-delete')
  },
  methods: {
    revealComment (id: number): void {
      const index = this.orderedComments.findIndex(comment => comment.id === id)
      if (index >= 0) this.commentBatchOffset = Math.floor(index / this.commentBatchSize)
    },
    commentAuthor (id: number): string {
      return this.comments.find(comment => comment.id === id)?.authorName ?? `#${id}`
    },
    openParentComment (id: number): void {
      if (this.commentEditId > 0 || this.isBusy) return
      const context = this.captureContext()
      this.revealComment(id)
      this.$nextTick(() => {
        if (!this.isCurrentContext(context)) return
        const target = this.$el.querySelector(`#comment-post-id-${id}`)
        if (!target) return
        void this.goTo(target, this.scrollOptions(250))
        target.setAttribute('tabindex', '-1')
        target.focus({ preventScroll: true })
      })
    },
    changeCommentBatch (direction: number): void {
      if (this.isBusy || this.commentEditId > 0) return
      const context = this.captureContext()
      this.commentBatchOffset = Math.max(0, Math.floor(this.batchStart / this.commentBatchSize) + direction)
      this.$nextTick(() => {
        if (!this.isCurrentContext(context)) return
        const thread = this.$el.querySelector('.comments-thread')
        if (!thread) return
        void this.goTo(thread, this.scrollOptions(250))
        thread.setAttribute('tabindex', '-1')
        thread.focus({ preventScroll: true })
      })
    },
    rotateContext (value: string): void {
      const pageId = this.pageId
      const ownerId = this.ownerId
      const firstContext = this.activeContextKey.length === 0
      const pageChanged = !firstContext && this.activePageId !== pageId
      const ownerChanged = !firstContext && this.activeOwnerId !== ownerId
      if (!firstContext && !pageChanged && !ownerChanged && this.activeContextKey === value) return

      this.activeContextKey = value
      this.activePageId = pageId
      this.activeOwnerId = ownerId
      if (!firstContext && pageChanged) this.pageGeneration += 1
      if (!firstContext && ownerChanged) this.ownerGeneration += 1
      if (firstContext) {
        this.pageGeneration = 1
        this.ownerGeneration = 1
        return
      }

      this.fetchController?.abort()
      this.fetchController = null
      this.mentionController?.abort()
      this.mentionController = null
      if (this.mentionTimer !== null) window.clearTimeout(this.mentionTimer)
      this.mentionTimer = null
      this.fetchGeneration += 1
      this.mentionGeneration += 1
      this.postGeneration += 1
      this.editGeneration += 1
      this.deleteGeneration += 1
      this.retryGeneration += 1
      this.authorityReady = false
      this.authorityError = ''
      this.authorityErrorKind = null
      this.availability = null
      this.comments = []
      this.commentBatchOffset = 0
      this.isLoading = false
      this.hasLoadedOnce = false
      this.fetchError = ''
      this.newcomment = ''
      this.guestName = ''
      this.guestEmail = ''
      this.composerRevision += 1
      this.uncertainCreate = false
      this.replyTo = 0
      this.replyAuthor = ''
      this.mentionRange = null
      this.mentionIndex = -1
      this.mentionCandidates = []
      this.commentToDelete = null
      this.commentEditId = 0
      this.commentEditContent = null
      this.commentEditRevision += 1
      this.deleteCommentDialogShown = false
      this.isPosting = false
      this.isBusy = false
      this.connectionRetrying = false
      this.reportedUnavailableAnchor = ''
      wikiStore.stopLoading('comments-edit')
      wikiStore.stopLoading('comments-delete')
    },
    ensureContext (): void {
      if (this.activeContextKey !== this.contextKey) this.rotateContext(this.contextKey)
    },
    captureContext (): CommentContext {
      this.ensureContext()
      return {
        pageId: this.pageId,
        ownerId: this.ownerId,
        pageGeneration: this.pageGeneration,
        ownerGeneration: this.ownerGeneration,
        componentGeneration: this.componentGeneration,
        transportGeneration: this.transportGeneration
      }
    },
    isCurrentContext (context: CommentContext): boolean {
      this.ensureContext()
      return (
        context.pageId === this.pageId &&
        context.ownerId === this.ownerId &&
        context.pageGeneration === this.pageGeneration &&
        context.ownerGeneration === this.ownerGeneration &&
        context.componentGeneration === this.componentGeneration &&
        context.transportGeneration === this.transportGeneration &&
        context.pageId === this.activePageId &&
        context.ownerId === this.activeOwnerId
      )
    },
    isCurrentIdentityContext (context: CommentContext): boolean {
      this.ensureContext()
      return (
        context.pageId === this.pageId &&
        context.ownerId === this.ownerId &&
        context.pageGeneration === this.pageGeneration &&
        context.ownerGeneration === this.ownerGeneration &&
        context.componentGeneration === this.componentGeneration &&
        context.pageId === this.activePageId &&
        context.ownerId === this.activeOwnerId
      )
    },
    newCommentTextarea (): HTMLTextAreaElement | null {
      const field = this.$refs.newCommentField as { $el?: Element } | undefined
      return field?.$el?.querySelector('textarea') ?? null
    },
    clearMentionSearch (): void {
      this.mentionGeneration += 1
      this.mentionController?.abort()
      this.mentionController = null
      if (this.mentionTimer !== null) window.clearTimeout(this.mentionTimer)
      this.mentionTimer = null
      this.mentionRange = null
      this.mentionIndex = -1
      this.mentionCandidates = []
    },
    handleComposerInput (event?: Event): void {
      this.composerRevision += 1
      this.uncertainCreate = false
      this.queueMentionSearch(event)
    },
    noteComposerInput (): void {
      this.composerRevision += 1
      this.uncertainCreate = false
      this.clearMentionSearch()
    },
    handleMentionCompositionStart (): void {
      this.mentionComposing = true
      this.clearMentionSearch()
    },
    handleMentionCompositionEnd (event?: Event): void {
      this.mentionComposing = false
      this.queueMentionSearch(event)
    },
    queueMentionSearch (event?: Event): void {
      const keyboardEvent = event as KeyboardEvent | undefined
      if (this.mentionComposing || keyboardEvent?.isComposing || keyboardEvent?.keyCode === 229) return
      if (keyboardEvent && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(keyboardEvent.key)) return
      this.clearMentionSearch()
      if (!this.isAuthenticated || this.connectionBlocked) return
      const context = this.captureContext()
      const textarea = this.newCommentTextarea()
      const cursor = textarea?.selectionStart ?? this.newcomment.length
      const match = this.newcomment.slice(0, cursor).match(/(?:^|[^\w@/])@([a-z0-9_-]{2,32})$/i)
      const query = (match?.[1] ?? '').toLowerCase()
      if (!query) return
      const range = { start: cursor - query.length - 1, end: cursor }
      const generation = this.mentionGeneration
      this.mentionRange = range
      this.mentionTimer = window.setTimeout(async () => {
        this.mentionTimer = null
        if (!this.isCurrentContext(context) || generation !== this.mentionGeneration || this.connectionBlocked) return
        const controller = markRaw(new AbortController())
        this.mentionController = controller
        try {
          const fetch = (url: string, options?: RequestInit) => window.fetch(url, { ...options, signal: controller.signal })
          const candidates = await fetchMentionCandidates(fetch, context.pageId, query)
          if (
            !this.isCurrentContext(context) ||
            generation !== this.mentionGeneration ||
            this.mentionController !== controller ||
            this.mentionRange?.start !== range.start ||
            this.mentionRange?.end !== range.end ||
            this.newcomment.slice(range.start, range.end).toLowerCase() !== `@${query}`
          ) return
          this.mentionCandidates = candidates
          this.mentionIndex = candidates.length > 0 ? 0 : -1
        } catch (error) {
          if (!this.isCurrentContext(context) || generation !== this.mentionGeneration || this.mentionController !== controller) return
          this.mentionCandidates = []
          const kind = this.commentErrorKind(error)
          if (kind === 'auth' || kind === 'permission' || kind === 'not-found') this.setAuthorityFailure(error)
        } finally {
          if (this.mentionController === controller) this.mentionController = null
        }
      }, 150)
    },
    handleMentionKeydown (event: KeyboardEvent): void {
      if (event.isComposing || event.keyCode === 229 || this.mentionComposing || this.mentionCandidates.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        this.mentionIndex = (this.mentionIndex + direction + this.mentionCandidates.length) % this.mentionCandidates.length
      } else if (event.key === 'Enter' && this.mentionIndex >= 0) {
        event.preventDefault()
        const candidate = this.mentionCandidates[this.mentionIndex]
        if (candidate) this.insertMention(candidate)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.clearMentionSearch()
      }
    },
    insertMention (candidate: MentionCandidate): void {
      const range = this.mentionRange
      if (!range) return
      const context = this.captureContext()
      const insertion = `@${candidate.handle} `
      this.newcomment = this.newcomment.slice(0, range.start) + insertion + this.newcomment.slice(range.end)
      this.composerRevision += 1
      const cursor = range.start + insertion.length
      this.clearMentionSearch()
      this.$nextTick(() => {
        if (!this.isCurrentContext(context)) return
        const textarea = this.newCommentTextarea()
        textarea?.focus()
        textarea?.setSelectionRange(cursor, cursor)
      })
    },
    startReply (comment: CommentWithInitials): void {
      if (!this.commentReady) return
      const context = this.captureContext()
      this.replyTo = comment.id
      this.replyAuthor = comment.authorName
      if (comment.authorHandle && !this.newcomment.trim()) {
        this.newcomment = `@${comment.authorHandle} `
        this.composerRevision += 1
      }
      this.clearMentionSearch()
      this.$nextTick(() => {
        if (!this.isCurrentContext(context)) return
        void this.goTo('#discussion-new', this.scrollOptions(250))
        this.newCommentTextarea()?.focus()
      })
    },
    cancelReply (): void {
      if (this.replyTo !== 0 || this.replyAuthor.length > 0) this.composerRevision += 1
      this.replyTo = 0
      this.replyAuthor = ''
    },
    onIntersect (isIntersecting: boolean, _entries: IntersectionObserverEntry[], _observer: IntersectionObserver): void {
      if (!isIntersecting) return
      this.ensureContext()
      this.hasIntersected = true
      void this.fetch(true)
    },
    focusRequestedComment (expectedContext?: CommentContext): void {
      const context = expectedContext ?? this.captureContext()
      if (this.commentEditId > 0) {
        this.revealComment(this.commentEditId)
        return
      }
      const anchor = window.location.hash
      if (!/^#comment-post-id-[1-9]\d*$/.test(anchor)) return
      this.revealComment(Number(anchor.slice('#comment-post-id-'.length)))
      const batchOffset = this.commentBatchOffset
      this.$nextTick(() => {
        if (!this.isCurrentContext(context) || batchOffset !== this.commentBatchOffset) return
        const target = document.querySelector<HTMLElement>(anchor)
        if (target) {
          void this.goTo(anchor, this.scrollOptions(250))
          target.setAttribute('tabindex', '-1')
          target.focus({ preventScroll: true })
        } else if (this.reportedUnavailableAnchor !== anchor) {
          this.reportedUnavailableAnchor = anchor
          showNotification(wikiStore, { style: 'warning', message: this.$t('common:comments.commentCannotOpened'), icon: 'alert' })
        }
      })
    },
    scrollOptions (duration?: number): CommentScrollOptions {
      const scrollDuration = duration === undefined ? this.scrollOpts.duration : duration
      const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      return {
        ...this.scrollOpts,
        duration: reduceMotion ? 0 : scrollDuration
      }
    },
    commentErrorKind (error: unknown): CommentOutcomeKind | null {
      if (error instanceof CommentApiError) return error.kind
      if (!error || typeof error !== 'object') return null
      const status = Reflect.get(error, 'status')
      if (typeof status !== 'number' || !Number.isSafeInteger(status)) return null
      if (status === 401) return 'auth'
      if (status === 403) return 'permission'
      if (status === 404) return 'not-found'
      if (status === 409) return 'conflict'
      if (status === 400 || status === 422) return 'validation'
      if (status === 429) return 'rate-limit'
      if (status >= 500) return 'server'
      return 'server'
    },
    commentErrorMessage (error: unknown): string {
      const kind = this.commentErrorKind(error)
      if (kind === 'auth') return this.$t('common:comments.sessionExpired')
      if (kind === 'permission' || kind === 'not-found') return this.$t('common:comments.unavailableForPage')
      if (kind === 'transport') return this.$t('common:comments.connectionRequiredChange')
      if (kind === 'transport-unknown') return this.$t('common:comments.outcomeUnknown')
      return getErrorMessage(error)
    },
    setAuthorityFailure (error: unknown): void {
      const kind = this.commentErrorKind(error) ?? 'server'
      this.authorityReady = false
      this.availability = null
      this.authorityErrorKind = kind
      this.authorityError = this.commentErrorMessage(error)
      this.fetchError = this.authorityError
      if (kind === 'auth' || kind === 'permission' || kind === 'not-found') this.comments = []
    },
    isUnknownMutationOutcome (error: unknown): boolean {
      if (error instanceof CommentApiError) return error.outcome === 'unknown'
      const kind = this.commentErrorKind(error)
      return kind === null || kind === 'transport' || kind === 'transport-unknown' || kind === 'server'
    },
    composerMatches (snapshot: ComposerSnapshot): boolean {
      return (
        this.composerRevision === snapshot.revision &&
        this.newcomment === snapshot.content &&
        this.guestName === snapshot.guestName &&
        this.guestEmail === snapshot.guestEmail &&
        this.replyTo === snapshot.replyTo &&
        this.pageId === snapshot.pageId
      )
    },
    clearComposerIfUnchanged (snapshot: ComposerSnapshot): boolean {
      if (!this.composerMatches(snapshot)) return false
      this.newcomment = ''
      this.guestName = ''
      this.guestEmail = ''
      this.replyTo = 0
      this.replyAuthor = ''
      this.composerRevision += 1
      this.uncertainCreate = false
      this.clearMentionSearch()
      return true
    },
    async fetch (silent = false): Promise<boolean> {
      const context = this.captureContext()
      if (this.connectionBlocked) {
        this.connectionPaused = true
        this.authorityReady = false
        this.availability = null
        this.authorityErrorKind = 'transport'
        this.authorityError = this.readinessMessage
        this.isLoading = false
        this.fetchError = this.authorityError
        return false
      }
      this.fetchController?.abort()
      const controller = markRaw(new AbortController())
      this.fetchController = controller
      const requestId = ++this.fetchGeneration
      this.authorityReady = false
      this.authorityError = ''
      this.authorityErrorKind = null
      this.isLoading = true
      this.fetchError = ''
      try {
        const fetch = (url: string, options?: RequestInit) => window.fetch(url, { ...options, signal: controller.signal })
        const [comments, availability] = await Promise.all([
          fetchComments(fetch, context.pageId),
          fetchDiscussionAvailability(fetch, context.pageId)
        ])
        if (!this.isCurrentContext(context) || requestId !== this.fetchGeneration || controller.signal.aborted || this.connectionBlocked) return false
        this.availability = availability
        this.comments = comments.map(comment => {
          const nameParts = comment.authorName.trim().toUpperCase().split(/\s+/)
          const firstInitial = nameParts[0]?.charAt(0) ?? ''
          const lastInitial = nameParts.length > 1 ? nameParts[nameParts.length - 1]?.charAt(0) ?? '' : ''
          return {
            ...comment,
            initials: firstInitial + lastInitial
          }
        })
        this.authorityReady = true
        this.authorityError = ''
        this.authorityErrorKind = null
        this.fetchError = ''
        this.focusRequestedComment(context)
        return true
      } catch (error) {
        if (!this.isCurrentContext(context) || requestId !== this.fetchGeneration) return false
        if (error instanceof CommentApiError && error.kind === 'transport-unknown') return false
        console.warn(error)
        this.setAuthorityFailure(error)
        if (!silent) {
          showNotification(wikiStore, {
            style: 'red',
            message: this.authorityError,
            icon: 'alert'
          })
        }
        return false
      } finally {
        if (this.isCurrentContext(context) && requestId === this.fetchGeneration) {
          this.fetchController = null
          this.isLoading = false
          this.hasLoadedOnce = true
        }
      }
    },
    async retryConnection (): Promise<void> {
      if (this.connectionRetrying) return
      const context = this.captureContext()
      const generation = ++this.retryGeneration
      this.connectionRetrying = true
      try {
        const reachable = await retryServerConnection()
        if (!this.isCurrentContext(context) || generation !== this.retryGeneration) return
        if (!reachable) {
          this.authorityReady = false
          this.authorityErrorKind = 'transport'
          this.authorityError = this.pwaConnectionState === 'server-unavailable'
            ? this.$t('common:comments.serverUnavailable')
            : this.$t('common:comments.connectionRequired')
          this.fetchError = this.authorityError
          return
        }
        this.connectionPaused = false
        if (this.hasIntersected) await this.fetch(false)
      } catch (error) {
        if (!this.isCurrentContext(context) || generation !== this.retryGeneration) return
        this.setAuthorityFailure(error)
      } finally {
        if (this.isCurrentIdentityContext(context) && generation === this.retryGeneration) this.connectionRetrying = false
      }
    },
    retryFetch (): void {
      if (this.connectionBlocked) {
        void this.retryConnection()
        return
      }
      void this.fetch(false)
    },
    async reconcileCreate (context: CommentContext, snapshot: ComposerSnapshot, generation: number): Promise<void> {
      if (!this.isCurrentContext(context) || generation !== this.postGeneration) return
      const refreshed = await this.fetch(false)
      if (!this.isCurrentContext(context) || generation !== this.postGeneration) return
      const reconciled = refreshed && this.comments.some(comment =>
        comment.content === snapshot.content && comment.replyTo === snapshot.replyTo
      )
      if (reconciled) {
        this.clearComposerIfUnchanged(snapshot)
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.commentWasFoundAfter'),
          icon: 'check'
        })
        return
      }
      this.uncertainCreate = true
      wikiStore.showNotification({
        style: 'warning',
        message: this.$t('common:comments.commentRequestOutcomeUnknown'),
        icon: 'alert'
      })
    },
    /**
     * Post New Comment
     */
    async postComment (): Promise<void> {
      this.ensureContext()
      if (!this.commentReady || this.isPosting) return
      const context = this.captureContext()
      const snapshot: ComposerSnapshot = {
        pageId: context.pageId,
        replyTo: this.replyTo,
        content: this.newcomment,
        guestName: this.guestName,
        guestEmail: this.guestEmail,
        revision: this.composerRevision
      }
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
        comment: snapshot.content,
        name: snapshot.guestName,
        email: snapshot.guestEmail
      }, rules, { format: 'flat' }) as string[] | undefined
      if (validationResults) {
        wikiStore.showNotification({
          style: 'red',
          message: validationResults[0],
          icon: 'alert'
        })
        return
      }

      const generation = ++this.postGeneration
      this.isPosting = true
      try {
        const response = await createComment(window.fetch.bind(window), {
          pageId: snapshot.pageId,
          replyTo: snapshot.replyTo,
          content: snapshot.content,
          guestName: snapshot.guestName,
          guestEmail: snapshot.guestEmail
        })
        if (!this.isCurrentContext(context) || generation !== this.postGeneration) return
        const cleared = this.clearComposerIfUnchanged(snapshot)
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.postSuccess'),
          icon: 'check'
        })
        const refreshed = await this.fetch(false)
        if (!this.isCurrentContext(context) || generation !== this.postGeneration || !refreshed || !cleared) return
        if (!this.comments.some(comment => comment.id === response.id)) return
        this.revealComment(response.id)
        this.$nextTick(() => {
          if (!this.isCurrentContext(context) || generation !== this.postGeneration) return
          void this.goTo(`#comment-post-id-${response.id}`, this.scrollOptions())
        })
      } catch (error) {
        if (!this.isCurrentContext(context) || generation !== this.postGeneration) return
        if (this.isUnknownMutationOutcome(error)) {
          await this.reconcileCreate(context, snapshot, generation)
          return
        }
        this.setAuthorityFailure(error)
        if (this.hasIntersected) await this.fetch(true)
        if (!this.isCurrentContext(context) || generation !== this.postGeneration) return
        wikiStore.showNotification({
          style: 'red',
          message: this.commentErrorMessage(error),
          icon: 'alert'
        })
      } finally {
        if (this.isCurrentIdentityContext(context) && generation === this.postGeneration) this.isPosting = false
      }
    },
    /**
     * Show Comment Editing Form
     */
    async editComment (cm: CommentWithInitials): Promise<void> {
      this.ensureContext()
      if (!this.managementReady || this.isBusy) return
      const context = this.captureContext()
      const generation = ++this.editGeneration
      wikiStore.startLoading('comments-edit')
      this.isBusy = true
      try {
        const comment = await fetchComment(window.fetch.bind(window), cm.id)
        if (!this.isCurrentContext(context) || generation !== this.editGeneration || comment.id !== cm.id) return
        this.commentEditContent = comment.content
        this.commentEditId = cm.id
        this.commentEditRevision += 1
        this.$nextTick(() => {
          if (!this.isCurrentContext(context) || generation !== this.editGeneration || this.commentEditId !== cm.id || this.isBusy) return
          this.$el.querySelector(`#comment-post-id-${cm.id} .comments-post-editcontent textarea`)?.focus()
        })
      } catch (error) {
        if (!this.isCurrentContext(context) || generation !== this.editGeneration) return
        this.setAuthorityFailure(error)
        console.warn(error)
        wikiStore.showNotification({
          style: 'red',
          message: this.commentErrorMessage(error),
          icon: 'alert'
        })
      } finally {
        if (this.isCurrentIdentityContext(context) && generation === this.editGeneration) {
          this.isBusy = false
          wikiStore.stopLoading('comments-edit')
        }
      }
    },
    noteEditInput (): void {
      this.commentEditRevision += 1
    },
    /**
     * Cancel Comment Edit
     */
    editCommentCancel (): void {
      this.editGeneration += 1
      this.commentEditId = 0
      this.commentEditContent = null
      this.commentEditRevision += 1
    },
    /**
     * Update Comment with new content
     */
    async updateComment (): Promise<void> {
      this.ensureContext()
      if (!this.managementReady || this.isBusy || this.commentEditId < 1) return
      const context = this.captureContext()
      const commentId = this.commentEditId
      const content = this.commentEditContent
      const editRevision = this.commentEditRevision
      if (content === null || content.trim().length < 2) {
        wikiStore.showNotification({
          style: 'red',
          message: this.$t('common:comments.contentMissingError'),
          icon: 'alert'
        })
        return
      }
      const generation = ++this.editGeneration
      wikiStore.startLoading('comments-edit')
      this.isBusy = true
      try {
        const response = await updateComment(window.fetch.bind(window), commentId, content)
        if (!this.isCurrentContext(context) || generation !== this.editGeneration || commentId !== this.commentEditId) return
        const cm = this.comments.find(comment => comment.id === commentId)
        if (cm) {
          cm.render = response.render
          cm.updatedAt = (new Date()).toISOString()
        }
        const unchanged = this.commentEditRevision === editRevision && this.commentEditContent === content
        if (unchanged) {
          this.commentEditId = 0
          this.commentEditContent = null
          this.commentEditRevision += 1
        }
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.updateSuccess'),
          icon: 'check'
        })
      } catch (error) {
        if (!this.isCurrentContext(context) || generation !== this.editGeneration) return
        this.setAuthorityFailure(error)
        console.warn(error)
        wikiStore.showNotification({
          style: 'red',
          message: this.commentErrorMessage(error),
          icon: 'alert'
        })
      } finally {
        if (this.isCurrentIdentityContext(context) && generation === this.editGeneration) {
          this.isBusy = false
          wikiStore.stopLoading('comments-edit')
        }
      }
    },
    /**
     * Show Delete Comment Confirmation Dialog
     */
    deleteCommentConfirm (cm: CommentWithInitials): void {
      if (!this.managementReady) return
      this.commentToDelete = cm
      this.deleteCommentDialogShown = true
    },
    /**
     * Delete Comment
     */
    async deleteComment (): Promise<void> {
      this.ensureContext()
      if (!this.managementReady || this.isBusy) return
      const commentToDelete = this.commentToDelete
      if (!commentToDelete) return
      const context = this.captureContext()
      const commentId = commentToDelete.id
      const generation = ++this.deleteGeneration
      wikiStore.startLoading('comments-delete')
      this.isBusy = true
      this.deleteCommentDialogShown = false

      try {
        await deleteComment(window.fetch.bind(window), commentId)
        if (!this.isCurrentContext(context) || generation !== this.deleteGeneration || this.commentToDelete?.id !== commentId) return
        wikiStore.showNotification({
          style: 'success',
          message: this.$t('common:comments.deleteSuccess'),
          icon: 'check'
        })
        this.comments = this.comments
          .filter(comment => comment.id !== commentId)
          .map(comment => comment.replyTo === commentId ? { ...comment, replyTo: 0 } : comment)
        this.commentToDelete = null
      } catch (error) {
        if (!this.isCurrentContext(context) || generation !== this.deleteGeneration) return
        this.setAuthorityFailure(error)
        wikiStore.showNotification({
          style: 'red',
          message: this.commentErrorMessage(error),
          icon: 'alert'
        })
      } finally {
        if (this.isCurrentIdentityContext(context) && generation === this.deleteGeneration) {
          this.isBusy = false
          wikiStore.stopLoading('comments-delete')
        }
      }
    }
  }
})
</script>

<style lang="scss">
.comments {
  min-width: 0;
  color: rgb(var(--v-theme-on-surface));
}
.comments-heading,
.comments-thread-status,
.comments-batches {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--wiki-space-3);
}
.comments-heading {
  margin-bottom: var(--wiki-space-4);
  padding-bottom: var(--wiki-space-3);
  border-bottom: 1px solid var(--wiki-surface-border);
  h2 { margin: 0; font-size: 1.125rem; font-weight: 650; }
}
.comments-count,
.comments-thread-status,
.comments-post-date,
.comments-format,
.comments-posting-as {
  color: var(--wiki-text-muted);
  font-size: .8125rem;
}
.comments-composer {
  padding: var(--wiki-space-4);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
  .v-field { border-radius: var(--wiki-control-radius); }
}
.comments-composer-title { margin: 0 0 var(--wiki-space-3); font-size: .9375rem; font-weight: 650; }
.comments-composer-field textarea { line-height: var(--wiki-leading-body); }
.comments-replying {
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border-inline-start: 3px solid var(--wiki-focus-color);
  background: var(--wiki-surface-sunken);
}
.comments-mentions {
  max-height: 16rem;
  overflow: auto;
  margin-top: var(--wiki-space-2);
  background: var(--wiki-surface-raised);
}
.comments-guest-fields .v-col { min-width: 0; }
.comments-actions { flex-wrap: wrap; gap: var(--wiki-space-3); }
.comments .v-btn { border-radius: var(--wiki-control-radius); text-transform: none; letter-spacing: normal; }
.comments-loading,
.comments-empty,
.comments-thread { margin-top: var(--wiki-space-4); }
.comments-thread {
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  overflow: hidden;
  background: var(--wiki-surface-raised);
}
.comments-thread-status,
.comments-batches { padding: var(--wiki-space-3) var(--wiki-space-4); background: var(--wiki-surface-sunken); }
.comments-post { min-width: 0; border-top: 1px solid var(--wiki-surface-border); }
.comments-post--reply { border-inline-start: 3px solid var(--wiki-surface-border-strong); }
.comments-post-card {
  background: var(--wiki-surface-raised);
  border-radius: 0 !important;
  > .v-card-text { padding: var(--wiki-space-4); }
}
.comments-post-actions {
  display: flex;
  flex-wrap: wrap;
  float: inline-end;
  margin-inline-start: var(--wiki-space-2);
  .v-btn { color: var(--wiki-text-muted); }
}
.comments-post-name { overflow-wrap: anywhere; font-size: .875rem !important; }
.comments-post-date { margin-top: var(--wiki-space-1); }
.comments-parent-link {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-1);
  margin-top: var(--wiki-space-2);
  padding: var(--wiki-space-1) 0;
  max-width: 100%;
  text-align: start;
  overflow-wrap: anywhere;
  color: var(--wiki-primary-ink);
  font-size: .8125rem;
}
.comments-parent-link:focus-visible,
.comments-post:focus-visible,
.comments-thread:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.comments-post-content {
  clear: both;
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: var(--wiki-leading-body);
  p { margin-bottom: 0; padding-top: var(--wiki-space-3); }
  > p:first-child { padding-top: 0; }
  a { color: var(--wiki-primary-ink); text-underline-offset: .15em; }
  img { max-width: 100%; }
  table { display: block; max-width: 100%; overflow: auto; }
  code { background: var(--wiki-surface-sunken); box-shadow: none; }
  pre { max-width: 100%; overflow: auto; margin-top: var(--wiki-space-3); }
  pre > code {
    display: block;
    width: max-content;
    min-width: 100%;
    padding: var(--wiki-space-3);
    font-family: var(--wiki-font-mono);
    color: rgb(var(--v-theme-on-surface));
  }
}
.comment-mention { color: var(--wiki-primary-ink); background: var(--wiki-surface-sunken); font-weight: 650; }
.comments-post-editcontent { clear: both; padding-top: var(--wiki-space-3); border-top: 1px solid var(--wiki-surface-border); }
.comments-delete-dialog { border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius) !important; background: var(--wiki-surface-raised); }
.comments-delete-header { padding: var(--wiki-space-4); border-bottom: 1px solid var(--wiki-surface-border); font-size: 1.125rem; font-weight: 650; }
@media (max-width: 599px) {
  .comments-composer,
  .comments-post-card > .v-card-text { padding: var(--wiki-space-3); }
  .comments-submit { flex: 1 0 100%; }
  .comments .v-btn { min-height: 44px; min-width: 44px; }
  .comments-batches { justify-content: center; }
}
@media (forced-colors: active) {
  .comments-composer, .comments-post, .comments-thread, .comments-delete-dialog { border-color: CanvasText; }
}
</style>
