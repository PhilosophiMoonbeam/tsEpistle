<template lang="pug">
  div.comments(v-intersect.once='onIntersect')
    v-alert.mb-4(v-if='availability && (availability.closed || !availability.enabled)', type='info', variant='tonal') {{ availability.closed ? 'This discussion is closed to new comments.' : 'Discussions are currently unavailable.' }}
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
      .comments-replying.d-flex.align-center.mb-3(v-if='replyTo > 0')
        v-icon.mr-2(size='18' aria-hidden='true') mdi-reply
        span.text-body-small Replying to #[strong {{ replyAuthor }}]
        v-spacer
        v-btn(icon size='x-small' variant='text' type='button' aria-label='Cancel reply' @click='cancelReply')
          v-icon(size='18') mdi-close
      v-textarea#discussion-new.comments-composer-field(
        ref='newCommentField'
        variant="outlined"
        :placeholder='$t(`common:comments.newPlaceholder`)'
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
        v-list#comment-mention-options(density='compact', role='listbox', aria-label='Mention suggestions')
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
            :placeholder='$t(`common:comments.fieldName`)'
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
            :placeholder='$t(`common:comments.fieldEmail`)'
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
    async-state.comments-loading(
      v-if='isLoading && (!hasLoadedOnce || comments.length === 0)'
      state='loading'
      :title='$t(`common:comments.loading`)'
    )
    async-state(
      v-else-if='fetchError && !readinessBlocked'
      state='error'
      :title='$t(`common:error.unexpected`)'
      :message='fetchError'
      :retry-label='$t(`common:actions.refresh`)'
      @retry='retryFetch'
    )
    v-timeline.comments-thread(
      density="compact"
      v-else-if='comments.length > 0'
      :aria-label='$t(`common:comments.title`)'
    )
      v-timeline-item.comments-post(
        :class='{ "comments-post--reply": cm.replyTo > 0 }'
        dot-color="primary"
        size="large"
        v-for='cm of orderedComments'
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
            .comments-post-actions(v-if='!isBusy && commentEditId === 0')
              v-btn(
                v-if='commentReady'
                icon
                size='small'
                variant='text'
                :aria-label='`Reply to ${cm.authorName}`'
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
            .comments-post-content.mt-3(v-if='commentEditId !== cm.id', v-html='cm.render')
            form.comments-post-editcontent.mt-3(v-else, novalidate, @submit.prevent='updateComment')
              v-textarea(
                variant="outlined"
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
        if (this.pwaConnectionState === 'checking') return 'Checking the connection before loading comments.'
        if (this.pwaConnectionState === 'server-unavailable') return 'Connection required. The server is unavailable right now.'
        return 'Connection required to load or change comments.'
      }
      return this.authorityError || 'Comment access is not ready. Refresh before trying again.'
    },
    readinessRetryLabel(): string {
      return this.connectionBlocked ? 'Retry connection' : 'Retry comments'
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
      const roots: CommentWithInitials[] = []
      const replies = new Map<number, CommentWithInitials[]>()
      for (const comment of this.comments) {
        if (comment.replyTo === 0) roots.push(comment)
        else replies.set(comment.replyTo, [...(replies.get(comment.replyTo) ?? []), comment])
      }
      return roots.flatMap(root => [root, ...(replies.get(root.id) ?? [])])
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
            ? 'Connection required. The server is unavailable right now.'
            : state === 'checking'
              ? 'Checking the connection before loading comments.'
              : 'Connection required to load comments.'
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
      const anchor = window.location.hash
      if (!/^#comment-post-id-[1-9]\d*$/.test(anchor)) return
      this.$nextTick(() => {
        if (!this.isCurrentContext(context)) return
        const target = document.querySelector<HTMLElement>(anchor)
        if (target) {
          void this.goTo(anchor, this.scrollOptions(250))
          target.setAttribute('tabindex', '-1')
          target.focus({ preventScroll: true })
        } else if (this.reportedUnavailableAnchor !== anchor) {
          this.reportedUnavailableAnchor = anchor
          showNotification(wikiStore, { style: 'warning', message: 'This comment cannot be opened.', icon: 'alert' })
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
      if (kind === 'auth') return 'Your session is no longer authorized to load or change comments. Sign in again, then retry.'
      if (kind === 'permission' || kind === 'not-found') return 'Comments are unavailable for this page.'
      if (kind === 'transport') return 'Connection required to load or change comments.'
      if (kind === 'transport-unknown') return 'The comment request outcome is unknown. Refresh comments before trying again; it was not sent again.'
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
            ? 'Connection required. The server is unavailable right now.'
            : 'Connection required to load comments.'
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
          message: 'Your comment was found after the connection was restored.',
          icon: 'check'
        })
        return
      }
      this.uncertainCreate = true
      wikiStore.showNotification({
        style: 'warning',
        message: 'The comment request outcome is unknown. Comments were refreshed and the request was not sent again. Review the thread before trying again.',
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
.comments-replying {
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 30%, var(--wiki-surface-border));
  border-radius: var(--wiki-control-radius);
  background: color-mix(in srgb, var(--wiki-accent-warm) 7%, var(--wiki-surface-raised));
}

.comments-mentions {
  max-height: 16rem;
  overflow: auto;
  margin-top: var(--wiki-space-2);
  border-color: var(--wiki-surface-border-strong) !important;
  background: var(--wiki-surface-raised);
}

.comments-post--reply .v-timeline-item__body {
  margin-inline-start: var(--wiki-space-6);
}

.comment-mention {
  padding: .08em .34em;
  border-radius: var(--wiki-radius-xs);
  background: color-mix(in srgb, var(--wiki-accent-warm) 12%, transparent);
  color: var(--wiki-accent-warm);
  font-weight: 650;
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
