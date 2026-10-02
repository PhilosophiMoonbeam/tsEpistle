<template>
  <form class="page-publication-settings" @submit.prevent="save">
    <div class="page-section-intro"><span class="pages-kicker">{{ $t('admin:pagePublicationSettings.publicationScheduling') }}</span><h2>{{ $t('admin:pagePublicationSettings.decideWhenPageAvailable') }}</h2><p>{{ $t('admin:pagePublicationSettings.publicationControlsReaderAvailability') }}</p></div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
    <div class="page-publication-grid"><section><v-switch v-model="enabled" color="primary" :label="$t('admin:pagePublicationSettings.enablePublication')" :disabled="busy" hide-details /><p>{{ enabled ? $t('admin:pagePublicationSettings.readersAccessCanOpen') : $t('admin:pagePublicationSettings.pageDraftPeopleEdit') }}</p><v-alert v-if="page.visibility === 'private'" type="info" variant="tonal">{{ $t('admin:pagePublicationSettings.pageRemainsPrivateOwner', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) }}</v-alert></section><section><v-text-field v-model="start" type="datetime-local" :label="$t('admin:pagePublicationSettings.available')" variant="outlined" :disabled="busy" :hint="$t('admin:pagePublicationSettings.leaveEmptyNoStart')" persistent-hint /><v-text-field v-model="end" type="datetime-local" :label="$t('admin:pagePublicationSettings.availableUntil')" variant="outlined" :disabled="busy" :hint="$t('admin:pagePublicationSettings.leaveEmptyNoEnd')" persistent-hint /><p class="page-settings-note">{{ $t('admin:pagePublicationSettings.timesShown', { timezone, interpolation: { escapeValue: false } }) }}</p></section></div>
    <div class="page-publication-result"><span class="pages-kicker">{{ $t('admin:pagePublicationSettings.afterSaving') }}</span><strong>{{ preview }}</strong><span>{{ $t('admin:pagePublicationSettings.basedCurrentTimeSchedule') }}</span></div>
    <p v-if="validation" role="alert" class="text-error">{{ validation }}</p>
    <div class="page-settings-actions"><span>{{ dirty ? $t('admin:pagePublicationSettings.unsavedChanges') : $t('admin:pagePublicationSettings.matchesSavedPage') }}</span><v-spacer /><v-btn type="button" variant="text" :disabled="busy || !dirty" @click="reset">{{ $t('admin:pagePublicationSettings.reset') }}</v-btn><v-btn type="submit" variant="flat" color="primary" :loading="busy" :disabled="busy || !dirty || Boolean(validation)">{{ $t('admin:pagePublicationSettings.savePublication') }}</v-btn></div>
  </form>
</template>
<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { PageDetails } from '../../helpers/pages-api'
import { publicationState, savePublication } from '../../helpers/admin-pages'
const localDate = (value: string | null | undefined): string => { if (!value) return ''; const date = new Date(value); if (!Number.isFinite(date.valueOf())) return ''; return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
export default defineComponent({
  props: { now: { type: Number, default: () => Date.now() }, page: { type: Object as PropType<PageDetails>, required: true } }, emits: ['dirty', 'busy', 'saved'],
  data: () => ({ enabled: false, start: '', end: '', error: '', busy: false }),
  computed: {
    timezone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone },
    available(): boolean { return this.page.capabilities?.viewStewardContacts === true && this.page.isPublished !== undefined && this.page.publishStartDate !== undefined && this.page.publishEndDate !== undefined },
    dirty(): boolean { return this.available && (this.enabled !== this.page.isPublished || this.start !== localDate(this.page.publishStartDate) || this.end !== localDate(this.page.publishEndDate)) },
    validation(): string { if (!this.available) return ''; if ((this.start && !Number.isFinite(Date.parse(this.start))) || (this.end && !Number.isFinite(Date.parse(this.end)))) return this.$t('admin:pagePublicationSettings.enterValidPublicationDates'); return this.start && this.end && Date.parse(this.end) <= Date.parse(this.start) ? this.$t('admin:pagePublicationSettings.endMustAfterStart') : '' },
    preview(): string { if (!this.available) return this.$t('admin:pagePublicationSettings.unavailable'); return this.validation ? this.$t('admin:pagePublicationSettings.resolveScheduleBeforeSaving') : publicationState({ isPublished: this.enabled, publishStartDate: this.start, publishEndDate: this.end }, this.now) }
  },
  methods: {
    reset() { if (!this.available) { this.error = ''; return }; this.enabled = this.page.isPublished!; this.start = localDate(this.page.publishStartDate); this.end = localDate(this.page.publishEndDate); this.error = '' },
    async save() { if (this.busy || !this.available || !this.dirty || this.validation) return; this.busy = true; this.error = ''; try { await savePublication(this.page.id, this.page.sourceRevision, { isPublished: this.enabled, publishStartDate: this.start === localDate(this.page.publishStartDate) ? this.page.publishStartDate : this.start ? new Date(this.start).toISOString() : '', publishEndDate: this.end === localDate(this.page.publishEndDate) ? this.page.publishEndDate : this.end ? new Date(this.end).toISOString() : '' }); this.$emit('saved') } catch (error) { this.error = error instanceof Error ? error.message : this.$t('admin:pagePublicationSettings.publicationCouldNotSaved') } finally { this.busy = false } }
  },
  watch: { page: { handler() { this.reset() }, immediate: true }, dirty(value: boolean) { this.$emit('dirty', value) }, busy(value: boolean) { this.$emit('busy', value) } },
  beforeUnmount() { this.$emit('dirty', false); this.$emit('busy', false) }
})
</script>
<style scoped lang="scss">
.page-publication-settings { padding:2rem; }.page-section-intro { max-width:45rem; margin-bottom:2rem; }h2 { font:500 2rem/1.2 var(--font-family-serif,Georgia,serif); margin:.7rem 0; }p { line-height:1.7; margin-bottom:1rem; color:rgb(var(--v-theme-on-surface-variant)); }.pages-kicker { font-size:.7rem; text-transform:uppercase; letter-spacing:.13em; }.page-publication-grid { display:grid; grid-template-columns:1fr 1fr; gap:3rem; }.page-settings-note { font-size:.8rem; }.page-publication-result { border-left:3px solid rgb(var(--v-theme-primary)); padding:.5rem 1.2rem; margin:1.5rem 0; }.page-publication-result>* { display:block; }.page-publication-result strong { font-size:1.4rem; margin:.3rem 0; }.page-publication-result>span:last-child { font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }.page-settings-actions { display:flex; flex-wrap:wrap; align-items:center; gap:.7rem; border-top:1px solid rgba(var(--v-border-color),.2); padding-top:1.5rem; }.page-settings-actions>span { font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }@media(max-width:700px) { .page-publication-settings { padding:1.2rem; }.page-publication-grid { grid-template-columns:1fr; gap:1rem; } }
</style>
