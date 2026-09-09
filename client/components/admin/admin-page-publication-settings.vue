<template>
  <form class="page-publication-settings" @submit.prevent="save">
    <div class="page-section-intro"><span class="pages-kicker">Publication &amp; scheduling</span><h2>Decide when this page is available.</h2><p>Publication controls reader availability. Page rules and private ownership still determine who can read it.</p></div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-5">{{ error }}</v-alert>
    <div class="page-publication-grid"><section><v-switch v-model="enabled" color="primary" label="Enable publication" :disabled="busy" hide-details /><p>{{ enabled ? 'Readers with access can open this page inside the window below.' : 'This page is a draft. People with edit access can still review it.' }}</p><v-alert v-if="page.visibility === 'private'" type="info" variant="tonal">This page remains private to owner #{{ page.ownerId }}. Publication does not make it a workspace page.</v-alert></section><section><v-text-field v-model="start" type="datetime-local" label="Available from" variant="outlined" :disabled="busy" hint="Leave empty for no start boundary." persistent-hint /><v-text-field v-model="end" type="datetime-local" label="Available until" variant="outlined" :disabled="busy" hint="Leave empty for no end boundary." persistent-hint /><p class="page-settings-note">Times are shown in {{ timezone }}.</p></section></div>
    <div class="page-publication-result"><span class="pages-kicker">After saving</span><strong>{{ preview }}</strong><span>Based on the current time. Schedule boundaries continue to apply as time passes.</span></div>
    <p v-if="validation" role="alert" class="text-error">{{ validation }}</p>
    <div class="page-settings-actions"><span>{{ dirty ? 'Unsaved changes' : 'Matches the saved page' }}</span><v-spacer /><v-btn type="button" variant="text" :disabled="busy || !dirty" @click="reset">Reset</v-btn><v-btn type="submit" variant="flat" color="primary" :loading="busy" :disabled="busy || !dirty || Boolean(validation)">Save publication</v-btn></div>
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
    validation(): string { if (!this.available) return ''; if ((this.start && !Number.isFinite(Date.parse(this.start))) || (this.end && !Number.isFinite(Date.parse(this.end)))) return 'Enter valid publication dates.'; return this.start && this.end && Date.parse(this.end) <= Date.parse(this.start) ? 'The end must be after the start.' : '' },
    preview(): string { if (!this.available) return 'Unavailable'; return this.validation ? 'Resolve the schedule before saving' : publicationState({ isPublished: this.enabled, publishStartDate: this.start, publishEndDate: this.end }, this.now) }
  },
  methods: {
    reset() { if (!this.available) { this.error = ''; return }; this.enabled = this.page.isPublished!; this.start = localDate(this.page.publishStartDate); this.end = localDate(this.page.publishEndDate); this.error = '' },
    async save() { if (this.busy || !this.available || !this.dirty || this.validation) return; this.busy = true; this.error = ''; try { await savePublication(this.page.id, this.page.sourceRevision, { isPublished: this.enabled, publishStartDate: this.start === localDate(this.page.publishStartDate) ? this.page.publishStartDate : this.start ? new Date(this.start).toISOString() : '', publishEndDate: this.end === localDate(this.page.publishEndDate) ? this.page.publishEndDate : this.end ? new Date(this.end).toISOString() : '' }); this.$emit('saved') } catch (error) { this.error = error instanceof Error ? error.message : 'Publication could not be saved.' } finally { this.busy = false } }
  },
  watch: { page: { handler() { this.reset() }, immediate: true }, dirty(value: boolean) { this.$emit('dirty', value) }, busy(value: boolean) { this.$emit('busy', value) } },
  beforeUnmount() { this.$emit('dirty', false); this.$emit('busy', false) }
})
</script>
<style scoped lang="scss">
.page-publication-settings { padding:2rem; }.page-section-intro { max-width:45rem; margin-bottom:2rem; }h2 { font:500 2rem/1.2 var(--font-family-serif,Georgia,serif); margin:.7rem 0; }p { line-height:1.7; margin-bottom:1rem; color:rgb(var(--v-theme-on-surface-variant)); }.pages-kicker { font-size:.7rem; text-transform:uppercase; letter-spacing:.13em; }.page-publication-grid { display:grid; grid-template-columns:1fr 1fr; gap:3rem; }.page-settings-note { font-size:.8rem; }.page-publication-result { border-left:3px solid rgb(var(--v-theme-primary)); padding:.5rem 1.2rem; margin:1.5rem 0; }.page-publication-result>* { display:block; }.page-publication-result strong { font-size:1.4rem; margin:.3rem 0; }.page-publication-result>span:last-child { font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }.page-settings-actions { display:flex; flex-wrap:wrap; align-items:center; gap:.7rem; border-top:1px solid rgba(var(--v-border-color),.2); padding-top:1.5rem; }.page-settings-actions>span { font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }@media(max-width:700px) { .page-publication-settings { padding:1.2rem; }.page-publication-grid { grid-template-columns:1fr; gap:1rem; } }
</style>
