<template>
  <section class="control-panel" aria-labelledby="decision-title">
    <header><div><h2 id="decision-title">{{ t('agentDecisionProviders') }}</h2><p>{{ t('structuredClassificationForAutomaticRoutingSeparateFrom') }}</p></div><div><v-btn variant="text" :disabled="busy || loading" :loading="loading" @click="load">{{ t('refresh') }}</v-btn><v-btn color="primary" :disabled="busy || loading || denied || !loaded" @click="open()">{{ t('addDecisionProvider') }}</v-btn></div></header>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <v-alert type="info" variant="tonal">{{ t('nativeTypeSafeJevUsesItsNativeDecision') }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" :aria-label="t('loadingDecisionProviders')" />
    <p v-if="loaded && !providers.length">{{ t('noDecisionProvidersConfiguredAddAProvider') }}</p>
    <v-alert v-if="loaded && !providers.some(p => p.isDefault && p.enabled && p.secretConfigured && p.checkedAt && p.config.kind === 'typesafe' && p.config.pricing && ['jev-1.13.0', 'jev-latest', 'jev-preview'].includes(p.config.model))" type="warning" variant="tonal">{{ t('noReadyDecisionDefaultIsConfiguredAutomatic') }}</v-alert>
    <article v-for="p in providers" :key="p.id" class="entry">
      <h3>{{ p.displayName }} <v-chip v-if="p.isDefault" size="small" color="primary">{{ t('default') }}</v-chip></h3>
      <p>{{ t('revision', { dialect: p.config.kind === 'typesafe' ? t('nativeTypeSafeJev') : t('customDialect', { dialect: p.config.dialect }), model: p.config.model, revision: p.revision, Disabled: p.enabled ? t('enabled') : t('disabled') }) }}</p>
      <p>{{ t('credentialLastCheck', { credentialSource: p.credentialSource, configured: p.secretConfigured ? t('configured') : t('notConfigured'), value: p.checkedAt || t('never') }) }}</p>
      <p>{{ t('pricing', { estimate: p.config.pricing ? t('pricingEstimate', { input: p.config.pricing.inputPerMillion, output: p.config.pricing.outputPerMillion, request: p.config.pricing.perRequest, revision: p.config.pricing.revision }) : t('unknownNoCostEstimate') }) }}</p>
      <p v-if="checks[p.id]" role="status">{{ checks[p.id] }}</p>
      <div class="actions"><v-btn v-for="action in providerActions" :key="action.id" :variant="action.variant" :color="action.color" :disabled="busy || loading || denied || (action.id === 'check' && !p.secretConfigured) || (action.id === 'toggle' && !p.enabled && (!p.secretConfigured || !p.checkedAt)) || (action.id === 'default' && (!p.enabled || !p.secretConfigured || !p.checkedAt || p.isDefault))" @click="runProviderAction(action.id,p)">{{ action.id === 'toggle' ? (p.enabled ? t('disable') : t('enable')) : action.label }}</v-btn></div>
    </article>
    <v-dialog aria-labelledby="decisionProviders-dialog-1" :model-value="dialog" max-width="760" :persistent="busy" @update:model-value="close"><v-card><v-card-title id="decisionProviders-dialog-1">{{ editing ? t('editDecisionProvider') : t('addDecisionProvider') }}</v-card-title><v-card-text>
      <v-alert v-if="formError" type="error" variant="tonal" role="alert">{{ formError }}</v-alert>
      <v-alert v-if="editingStale" type="warning" variant="tonal">{{ t('thisProviderChangedOrWasRemovedYour') }}</v-alert>
      <v-form @submit.prevent="save">
      <template v-for="field in decisionFields" :key="field.key">
        <template v-if="field.scope === 'custom' ? draft.kind === 'openai-compatible' : field.scope === 'pricing' ? draft.knownPricing : true">
          <v-text-field v-if="field.control === 'text'" v-model="draft[field.key]" :label="field.label" :type="field.type" :error-messages="fieldErrors[field.key]" :autofocus="field.autofocus" :autocomplete="field.key === 'secret' ? 'new-password' : undefined" :disabled="busy || denied || (field.key === 'secret' && draft.clearSecret)" />
          <v-text-field v-else-if="field.control === 'number'" v-model.number="draft[field.key]" type="number" step="any" :label="field.label" :error-messages="fieldErrors[field.key]" :disabled="busy || denied" />
          <v-checkbox v-else-if="field.control === 'checkbox'" v-model="draft[field.key]" :label="field.label" :disabled="busy || denied" />
          <v-select v-else-if="field.control === 'kind'" v-model="draft.kind" :label="field.label" :items="providerKinds" :disabled="busy || denied" />
          <v-select v-else v-model="draft.dialect" :label="field.label" :items="['chat-completions','completions']" :disabled="busy || denied" />
        </template>
      </template>
      <v-card-actions><v-btn :disabled="busy" @click="close(false)">{{ t('cancel') }}</v-btn><v-spacer /><v-btn type="submit" color="primary" :loading="busy" :disabled="denied || loading || editingStale || JSON.stringify(draft) === baseline">{{ t('saveConfiguration') }}</v-btn></v-card-actions></v-form>
    </v-card-text></v-card></v-dialog>
    <v-dialog aria-labelledby="decisionProviders-dialog-2" v-model="discard" max-width="440"><v-card><v-card-title id="decisionProviders-dialog-2">{{ t('discardUnsavedChanges') }}</v-card-title><v-card-text>{{ t('yourNewCredentialAndConfigurationHaveNot') }}</v-card-text><v-card-actions><v-btn @click="discard=false">{{ t('keepEditing') }}</v-btn><v-btn color="error" @click="discard=false;dialog=false;draft.secret=''">{{ t('discard') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog aria-labelledby="decisionProviders-dialog-3" :model-value="Boolean(remove)" max-width="440" :persistent="busy" @update:model-value="value => { if (!value && !busy) remove=null }"><v-card><v-card-title id="decisionProviders-dialog-3">{{ t('deleteDecisionProvider') }}</v-card-title><v-card-text>{{ t('willNoLongerBeAvailableForRouting', { displayName: remove?.displayName }) }}</v-card-text><v-card-actions><v-btn :disabled="busy" @click="remove=null">{{ t('cancel') }}</v-btn><v-btn color="error" :loading="busy" :disabled="denied || loading" @click="removeProvider">{{ t('delete') }}</v-btn></v-card-actions></v-card></v-dialog>
  </section>
</template>
<script setup lang="ts">
import { useTranslate } from '../../helpers/use-translate.ts'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { DecisionProviderWriteSchema } from '../../../shared/agents/decision-providers.ts'
import { listDecisionProviders,createDecisionProvider,updateDecisionProvider,deleteDecisionProvider,enableDecisionProvider,defaultDecisionProvider,checkDecisionProvider,type DecisionProviderView } from '../../helpers/agent-control-api.ts'
const {csrfToken,refreshKey=0}=defineProps<{csrfToken:string;refreshKey?:number}>()
const emit=defineEmits<{state:[providers:DecisionProviderView[]|null]}>()
const t = useTranslate('admin:decisionProviders')
const fetcher:typeof fetch=(...args)=>window.fetch(...args)
const providers=ref<DecisionProviderView[]>([]),loading=ref(false),loaded=ref(false),busy=ref(false),denied=ref(false),error=ref(''),formError=ref(''),dialog=ref(false),discard=ref(false),editing=ref<DecisionProviderView|null>(null),remove=ref<DecisionProviderView|null>(null),baseline=ref('')
const checks=reactive<Record<string,string>>({})
const editingStale=computed(()=>Boolean(editing.value)&&providers.value.find(p=>p.id===editing.value?.id)?.revision!==editing.value?.revision)
let controller:AbortController|null=null
const draft=reactive({displayName:'',kind:'typesafe' as 'typesafe'|'openai-compatible',model:'jev-latest',baseUrl:'',dialect:'chat-completions' as 'chat-completions'|'completions',timeoutMs:5000,maxOutputTokens:1024,secret:'',clearSecret:false,knownPricing:false,inputPerMillion:0,outputPerMillion:0,perRequest:0,pricingRevision:'',source:'',verifiedAt:''})
const validationAttempted = ref(false)
const providerValidation = computed(() => {
  const pricing=draft.knownPricing?{currency:'USD' as const,inputPerMillion:draft.inputPerMillion,outputPerMillion:draft.outputPerMillion,perRequest:draft.perRequest,revision:draft.pricingRevision,source:draft.source,verifiedAt:draft.verifiedAt}:null;const config=draft.kind==='typesafe'?{kind:'typesafe' as const,model:draft.model,timeoutMs:draft.timeoutMs,pricing}:{kind:'openai-compatible' as const,model:draft.model,baseUrl:draft.baseUrl,dialect:draft.dialect,timeoutMs:draft.timeoutMs,maxOutputTokens:draft.maxOutputTokens,pricing}
  return DecisionProviderWriteSchema.safeParse({displayName:draft.displayName,config,...(draft.clearSecret?{secretValue:null}:draft.secret?{secretValue:draft.secret}:{})})
})
const fieldErrors = computed(() => {
  const errors: Record<string, string> = {}
  if (!validationAttempted.value || providerValidation.value.success) return errors
  for (const issue of providerValidation.value.error.issues) {
    const last = String(issue.path.at(-1) ?? '')
    const field = last === 'secretValue' ? 'secret' : last === 'revision' ? 'pricingRevision' : last
    errors[field] = providerFieldMessage(field)
  }
  return errors
})
function providerFieldMessage(field: string) {
  const messages: Record<string, string> = {
    displayName: t('invalidDisplayName'),
    model: t('invalidModel'),
    baseUrl: t('invalidBaseUrl'),
    timeoutMs: t('invalidTimeoutMs'),
    maxOutputTokens: t('invalidMaxOutputTokens'),
    inputPerMillion: t('invalidInputPerMillion'),
    outputPerMillion: t('invalidOutputPerMillion'),
    perRequest: t('invalidPerRequest'),
    pricingRevision: t('invalidPricingRevision'),
    source: t('invalidSource'),
    verifiedAt: t('invalidVerifiedAt'),
    secret: t('invalidSecret'),
  }
  return messages[field] ?? t('invalidConfiguration')
}
type DecisionField = {label:string;scope?:'custom'|'pricing'} & (
  | {control:'text';key:'displayName'|'model'|'baseUrl'|'secret'|'pricingRevision'|'source'|'verifiedAt';type?:'password'|'date';autofocus?:boolean}
  | {control:'number';key:'maxOutputTokens'|'timeoutMs'|'inputPerMillion'|'outputPerMillion'|'perRequest'}
  | {control:'checkbox';key:'clearSecret'|'knownPricing'}
  | {control:'kind';key:'kind'}
  | {control:'dialect';key:'dialect'}
)
const providerKinds=[{title:t('nativeTypeSafeJev'),value:'typesafe'},{title:t('customOpenAICompatible'),value:'openai-compatible'}]
const decisionFields:readonly DecisionField[]=[
  {control:'text',key:'displayName',label:t('displayName'),autofocus:true},
  {control:'kind',key:'kind',label:t('providerKind')},
  {control:'text',key:'model',label:t('explicitModel')},
  {control:'text',key:'baseUrl',label:t('publicHTTPSBaseURL'),scope:'custom'},
  {control:'dialect',key:'dialect',label:t('explicitAPIDialect'),scope:'custom'},
  {control:'number',key:'maxOutputTokens',label:t('maximumOutputTokens644096'),scope:'custom'},
  {control:'number',key:'timeoutMs',label:t('timeoutMilliseconds10030000')},
  {control:'text',key:'secret',label:t('newCredentialBlankRetainsCurrentCredential'),type:'password'},
  {control:'checkbox',key:'clearSecret',label:t('clearManagedCredentialNativeProviderMayUse')},
  {control:'checkbox',key:'knownPricing',label:t('configureVerifiedUSDPricingOtherwiseUnknown')},
  {control:'number',key:'inputPerMillion',label:t('usdPerMillionInputTokens'),scope:'pricing'},
  {control:'number',key:'outputPerMillion',label:t('usdPerMillionOutputTokens'),scope:'pricing'},
  {control:'number',key:'perRequest',label:t('usdPerRequest'),scope:'pricing'},
  {control:'text',key:'pricingRevision',label:t('pricingRevision'),scope:'pricing'},
  {control:'text',key:'source',label:t('pricingSource'),scope:'pricing'},
  {control:'text',key:'verifiedAt',label:t('verifiedDate'),type:'date',scope:'pricing'}
]
type ProviderActionId='edit'|'check'|'toggle'|'default'|'delete'
const providerActions:readonly {id:ProviderActionId;label:string;variant:'text'|'tonal';color?:string}[]=[
  {id:'edit',label:t('edit'),variant:'text'},
  {id:'check',label:t('checkConnection'),variant:'tonal'},
  {id:'toggle',label:t('enable'),variant:'text'},
  {id:'default',label:t('setDefault'),variant:'text'},
  {id:'delete',label:t('delete'),variant:'text',color:'error'}
]
function runProviderAction(action:ProviderActionId,p:DecisionProviderView){
  if(busy.value||loading.value||denied.value)return
  switch(action){
    case 'edit':return open(p)
    case 'check':return check(p)
    case 'toggle':return act(()=>enableDecisionProvider(fetcher,csrfToken,p.id,p.revision,!p.enabled))
    case 'default':return act(()=>defaultDecisionProvider(fetcher,csrfToken,p.id,p.revision))
    case 'delete':remove.value=p
  }
}
async function load(){controller?.abort();const request=new AbortController();controller=request;loading.value=true;try{const current=await listDecisionProviders(fetcher,csrfToken,request.signal);if(request.signal.aborted)return;for(const p of current){const previous=providers.value.find(provider=>provider.id===p.id);if(previous&&previous.revision!==p.revision)delete checks[p.id]}providers.value=current;loaded.value=true;denied.value=false;error.value='';emit('state',current)}catch(e){if(request.signal.aborted)return;denied.value=e instanceof AgentApiError && e.status===403;error.value=denied.value?t('systemAdministrationPermissionIsRequired'):e instanceof Error?e.message:t('unableToLoadDecisionProviders');emit('state',null)}finally{if(controller===request)loading.value=false}}
function open(p?:DecisionProviderView){editing.value=p??null;Object.assign(draft,{displayName:p?.displayName??'',kind:p?.config.kind??'typesafe',model:p?.config.model??'jev-latest',baseUrl:p?.config.kind==='openai-compatible'?p.config.baseUrl:'',dialect:p?.config.kind==='openai-compatible'?p.config.dialect:'chat-completions',timeoutMs:p?.config.timeoutMs??5000,maxOutputTokens:p?.config.kind==='openai-compatible'?p.config.maxOutputTokens:1024,secret:'',clearSecret:false,knownPricing:Boolean(p?.config.pricing),inputPerMillion:p?.config.pricing?.inputPerMillion??0,outputPerMillion:p?.config.pricing?.outputPerMillion??0,perRequest:p?.config.pricing?.perRequest??0,pricingRevision:p?.config.pricing?.revision??'',source:p?.config.pricing?.source??'',verifiedAt:p?.config.pricing?.verifiedAt??''});baseline.value=JSON.stringify(draft);validationAttempted.value=false;formError.value='';dialog.value=true}
function close(value:boolean){if(value||busy.value)return;if(JSON.stringify(draft)!==baseline.value)discard.value=true;else{dialog.value=false;draft.secret=''}}
async function act(operation:()=>Promise<unknown>){if(busy.value||loading.value||denied.value)return;busy.value=true;error.value='';try{await operation();await load()}catch(e){if(e instanceof AgentApiError&&e.status===403)denied.value=true;error.value=e instanceof Error?e.message:t('operationFailed');if(e instanceof AgentApiError&&e.status===409){await load();remove.value=null;error.value=t('configurationChangedElsewhereRefreshedCurrentRevisionsReview')}}finally{busy.value=false}}
async function save(){if(busy.value||loading.value||denied.value||editingStale.value)return;validationAttempted.value=true;const validated=providerValidation.value;if(!validated.success){formError.value=t('invalidConfiguration');return}busy.value=true;formError.value='';try{const input=validated.data;if(editing.value){await updateDecisionProvider(fetcher,csrfToken,editing.value.id,{...input,expectedRevision:editing.value.revision});delete checks[editing.value.id]}else await createDecisionProvider(fetcher,csrfToken,input);dialog.value=false;draft.secret='';await load()}catch(e){if(e instanceof AgentApiError&&e.status===403)denied.value=true;formError.value=e instanceof Error?e.message:t('unableToSave');if(e instanceof AgentApiError&&e.status===409){await load();formError.value=t('staleRevisionCloseThisDialogAndReopen')}}finally{busy.value=false}}
async function check(p:DecisionProviderView){await act(async()=>{const result=await checkDecisionProvider(fetcher,csrfToken,p.id,p.revision);checks[p.id]=t('checkResult',{availability:result.configuredModelAvailable?t('modelAvailable'):t('modelUnavailable'),latency:result.latencyMs,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,cost:result.estimatedCostMicros===null?t('costUnknown'):t('costEstimate',{amount:result.estimatedCostMicros}),models:result.availableModels.join(', ')||t('noModels')})})}
async function removeProvider(){const p=remove.value;if(!p)return;await act(async()=>{await deleteDecisionProvider(fetcher,csrfToken,p.id,p.revision);remove.value=null})}
watch(()=>refreshKey,()=>{void load()})
onBeforeUnmount(()=>controller?.abort())
onMounted(load)
</script>
<style scoped lang="scss">
@use "../admin/admin-workspace.scss" as workspace;
.control-panel { @include workspace.admin-agent-control; }
h4 { color: rgb(var(--v-theme-on-surface)); overflow-wrap: anywhere; }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: var(--wiki-space-4); }
</style>
