<template>
  <section class="control-panel" aria-labelledby="decision-title">
    <header><div><h2 id="decision-title">{{ t('admin:decisionProviders.agentDecisionProviders') }}</h2><p>{{ t('admin:decisionProviders.structuredClassificationForAutomaticRoutingSeparateFrom') }}</p></div><div><v-btn variant="text" :disabled="busy || loading" :loading="loading" @click="load">{{ t('admin:decisionProviders.refresh') }}</v-btn><v-btn color="primary" :disabled="busy || loading || denied || !loaded" @click="open()">{{ t('admin:decisionProviders.addDecisionProvider') }}</v-btn></div></header>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <v-alert type="info" variant="tonal">{{ t('admin:decisionProviders.nativeTypeSafeJevUsesItsNativeDecision') }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" :aria-label="t('admin:decisionProviders.loadingDecisionProviders')" />
    <p v-if="loaded && !providers.length">{{ t('admin:decisionProviders.noDecisionProvidersConfiguredAddAProvider') }}</p>
    <v-alert v-if="loaded && providers.length && !providers.some(p => p.isDefault && p.enabled && p.secretConfigured && p.checkedAt)" type="warning" variant="tonal">{{ t('admin:decisionProviders.noReadyDecisionDefaultIsConfiguredAutomatic') }}</v-alert>
    <article v-for="p in providers" :key="p.id" class="entry">
      <h3>{{ p.displayName }} <v-chip v-if="p.isDefault" size="small" color="primary">{{ t('admin:decisionProviders.default') }}</v-chip></h3>
      <p>{{ t('admin:decisionProviders.revision', { dialect: p.config.kind === 'typesafe' ? t('admin:decisionProviders.nativeTypeSafeJev') : t('admin:decisionProviders.customDialect', { dialect: p.config.dialect }), model: p.config.model, revision: p.revision, Disabled: p.enabled ? t('admin:decisionProviders.enabled') : t('admin:decisionProviders.disabled') }) }}</p>
      <p>{{ t('admin:decisionProviders.credentialLastCheck', { credentialSource: p.credentialSource, configured: p.secretConfigured ? t('admin:decisionProviders.configured') : t('admin:decisionProviders.notConfigured'), value: p.checkedAt || t('admin:decisionProviders.never') }) }}</p>
      <p>{{ t('admin:decisionProviders.pricing', { estimate: p.config.pricing ? t('admin:decisionProviders.pricingEstimate', { input: p.config.pricing.inputPerMillion, output: p.config.pricing.outputPerMillion, request: p.config.pricing.perRequest, revision: p.config.pricing.revision }) : t('admin:decisionProviders.unknownNoCostEstimate') }) }}</p>
      <p v-if="checks[p.id]" role="status">{{ checks[p.id] }}</p>
      <div class="actions"><v-btn v-for="action in providerActions" :key="action.id" :variant="action.variant" :color="action.color" :disabled="busy || loading || denied || (action.id === 'check' && !p.secretConfigured) || (action.id === 'toggle' && !p.enabled && (!p.secretConfigured || !p.checkedAt)) || (action.id === 'default' && (!p.enabled || !p.secretConfigured || !p.checkedAt || p.isDefault))" @click="runProviderAction(action.id,p)">{{ action.id === 'toggle' ? (p.enabled ? t('admin:decisionProviders.disable') : t('admin:decisionProviders.enable')) : action.label }}</v-btn></div>
    </article>
    <v-dialog aria-labelledby="decisionProviders-dialog-1" :model-value="dialog" max-width="760" :persistent="busy" @update:model-value="close"><v-card><v-card-title id="decisionProviders-dialog-1">{{ editing ? t('admin:decisionProviders.editDecisionProvider') : t('admin:decisionProviders.addDecisionProvider') }}</v-card-title><v-card-text>
      <v-alert v-if="formError" type="error" variant="tonal" role="alert">{{ formError }}</v-alert>
      <v-alert v-if="editingStale" type="warning" variant="tonal">{{ t('admin:decisionProviders.thisProviderChangedOrWasRemovedYour') }}</v-alert>
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
      <v-card-actions><v-btn :disabled="busy" @click="close(false)">{{ t('admin:decisionProviders.cancel') }}</v-btn><v-spacer /><v-btn type="submit" color="primary" :loading="busy" :disabled="denied || loading || editingStale || JSON.stringify(draft) === baseline">{{ t('admin:decisionProviders.saveConfiguration') }}</v-btn></v-card-actions></v-form>
    </v-card-text></v-card></v-dialog>
    <v-dialog aria-labelledby="decisionProviders-dialog-2" v-model="discard" max-width="440"><v-card><v-card-title id="decisionProviders-dialog-2">{{ t('admin:decisionProviders.discardUnsavedChanges') }}</v-card-title><v-card-text>{{ t('admin:decisionProviders.yourNewCredentialAndConfigurationHaveNot') }}</v-card-text><v-card-actions><v-btn @click="discard=false">{{ t('admin:decisionProviders.keepEditing') }}</v-btn><v-btn color="error" @click="discard=false;dialog=false;draft.secret=''">{{ t('admin:decisionProviders.discard') }}</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog aria-labelledby="decisionProviders-dialog-3" :model-value="Boolean(remove)" max-width="440" :persistent="busy" @update:model-value="value => { if (!value && !busy) remove=null }"><v-card><v-card-title id="decisionProviders-dialog-3">{{ t('admin:decisionProviders.deleteDecisionProvider') }}</v-card-title><v-card-text>{{ t('admin:decisionProviders.willNoLongerBeAvailableForRouting', { displayName: remove?.displayName }) }}</v-card-text><v-card-actions><v-btn :disabled="busy" @click="remove=null">{{ t('admin:decisionProviders.cancel') }}</v-btn><v-btn color="error" :loading="busy" :disabled="denied || loading" @click="removeProvider">{{ t('admin:decisionProviders.delete') }}</v-btn></v-card-actions></v-card></v-dialog>
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
const t = useTranslate()
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
    displayName: t('admin:decisionProviders.invalidDisplayName'),
    model: t('admin:decisionProviders.invalidModel'),
    baseUrl: t('admin:decisionProviders.invalidBaseUrl'),
    timeoutMs: t('admin:decisionProviders.invalidTimeoutMs'),
    maxOutputTokens: t('admin:decisionProviders.invalidMaxOutputTokens'),
    inputPerMillion: t('admin:decisionProviders.invalidInputPerMillion'),
    outputPerMillion: t('admin:decisionProviders.invalidOutputPerMillion'),
    perRequest: t('admin:decisionProviders.invalidPerRequest'),
    pricingRevision: t('admin:decisionProviders.invalidPricingRevision'),
    source: t('admin:decisionProviders.invalidSource'),
    verifiedAt: t('admin:decisionProviders.invalidVerifiedAt'),
    secret: t('admin:decisionProviders.invalidSecret'),
  }
  return messages[field] ?? t('admin:decisionProviders.invalidConfiguration')
}
type DecisionField = {label:string;scope?:'custom'|'pricing'} & (
  | {control:'text';key:'displayName'|'model'|'baseUrl'|'secret'|'pricingRevision'|'source'|'verifiedAt';type?:'password'|'date';autofocus?:boolean}
  | {control:'number';key:'maxOutputTokens'|'timeoutMs'|'inputPerMillion'|'outputPerMillion'|'perRequest'}
  | {control:'checkbox';key:'clearSecret'|'knownPricing'}
  | {control:'kind';key:'kind'}
  | {control:'dialect';key:'dialect'}
)
const providerKinds=[{title:t('admin:decisionProviders.nativeTypeSafeJev'),value:'typesafe'},{title:t('admin:decisionProviders.customOpenAICompatible'),value:'openai-compatible'}]
const decisionFields:readonly DecisionField[]=[
  {control:'text',key:'displayName',label:t('admin:decisionProviders.displayName'),autofocus:true},
  {control:'kind',key:'kind',label:t('admin:decisionProviders.providerKind')},
  {control:'text',key:'model',label:t('admin:decisionProviders.explicitModel')},
  {control:'text',key:'baseUrl',label:t('admin:decisionProviders.publicHTTPSBaseURL'),scope:'custom'},
  {control:'dialect',key:'dialect',label:t('admin:decisionProviders.explicitAPIDialect'),scope:'custom'},
  {control:'number',key:'maxOutputTokens',label:t('admin:decisionProviders.maximumOutputTokens644096'),scope:'custom'},
  {control:'number',key:'timeoutMs',label:t('admin:decisionProviders.timeoutMilliseconds10030000')},
  {control:'text',key:'secret',label:t('admin:decisionProviders.newCredentialBlankRetainsCurrentCredential'),type:'password'},
  {control:'checkbox',key:'clearSecret',label:t('admin:decisionProviders.clearManagedCredentialNativeProviderMayUse')},
  {control:'checkbox',key:'knownPricing',label:t('admin:decisionProviders.configureVerifiedUSDPricingOtherwiseUnknown')},
  {control:'number',key:'inputPerMillion',label:t('admin:decisionProviders.usdPerMillionInputTokens'),scope:'pricing'},
  {control:'number',key:'outputPerMillion',label:t('admin:decisionProviders.usdPerMillionOutputTokens'),scope:'pricing'},
  {control:'number',key:'perRequest',label:t('admin:decisionProviders.usdPerRequest'),scope:'pricing'},
  {control:'text',key:'pricingRevision',label:t('admin:decisionProviders.pricingRevision'),scope:'pricing'},
  {control:'text',key:'source',label:t('admin:decisionProviders.pricingSource'),scope:'pricing'},
  {control:'text',key:'verifiedAt',label:t('admin:decisionProviders.verifiedDate'),type:'date',scope:'pricing'}
]
type ProviderActionId='edit'|'check'|'toggle'|'default'|'delete'
const providerActions:readonly {id:ProviderActionId;label:string;variant:'text'|'tonal';color?:string}[]=[
  {id:'edit',label:t('admin:decisionProviders.edit'),variant:'text'},
  {id:'check',label:t('admin:decisionProviders.checkConnection'),variant:'tonal'},
  {id:'toggle',label:t('admin:decisionProviders.enable'),variant:'text'},
  {id:'default',label:t('admin:decisionProviders.setDefault'),variant:'text'},
  {id:'delete',label:t('admin:decisionProviders.delete'),variant:'text',color:'error'}
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
async function load(){controller?.abort();const request=new AbortController();controller=request;loading.value=true;try{const current=await listDecisionProviders(fetcher,csrfToken,request.signal);if(request.signal.aborted)return;for(const p of current){const previous=providers.value.find(provider=>provider.id===p.id);if(previous&&previous.revision!==p.revision)delete checks[p.id]}providers.value=current;loaded.value=true;denied.value=false;error.value='';emit('state',current)}catch(e){if(request.signal.aborted)return;denied.value=e instanceof AgentApiError && e.status===403;error.value=denied.value?t('admin:decisionProviders.systemAdministrationPermissionIsRequired'):e instanceof Error?e.message:t('admin:decisionProviders.unableToLoadDecisionProviders');emit('state',null)}finally{if(controller===request)loading.value=false}}
function open(p?:DecisionProviderView){editing.value=p??null;Object.assign(draft,{displayName:p?.displayName??'',kind:p?.config.kind??'typesafe',model:p?.config.model??'jev-latest',baseUrl:p?.config.kind==='openai-compatible'?p.config.baseUrl:'',dialect:p?.config.kind==='openai-compatible'?p.config.dialect:'chat-completions',timeoutMs:p?.config.timeoutMs??5000,maxOutputTokens:p?.config.kind==='openai-compatible'?p.config.maxOutputTokens:1024,secret:'',clearSecret:false,knownPricing:Boolean(p?.config.pricing),inputPerMillion:p?.config.pricing?.inputPerMillion??0,outputPerMillion:p?.config.pricing?.outputPerMillion??0,perRequest:p?.config.pricing?.perRequest??0,pricingRevision:p?.config.pricing?.revision??'',source:p?.config.pricing?.source??'',verifiedAt:p?.config.pricing?.verifiedAt??''});baseline.value=JSON.stringify(draft);validationAttempted.value=false;formError.value='';dialog.value=true}
function close(value:boolean){if(value||busy.value)return;if(JSON.stringify(draft)!==baseline.value)discard.value=true;else{dialog.value=false;draft.secret=''}}
async function act(operation:()=>Promise<unknown>){if(busy.value||loading.value||denied.value)return;busy.value=true;error.value='';try{await operation();await load()}catch(e){if(e instanceof AgentApiError&&e.status===403)denied.value=true;error.value=e instanceof Error?e.message:t('admin:decisionProviders.operationFailed');if(e instanceof AgentApiError&&e.status===409){await load();remove.value=null;error.value=t('admin:decisionProviders.configurationChangedElsewhereRefreshedCurrentRevisionsReview')}}finally{busy.value=false}}
async function save(){if(busy.value||loading.value||denied.value||editingStale.value)return;validationAttempted.value=true;const validated=providerValidation.value;if(!validated.success){formError.value=t('admin:decisionProviders.invalidConfiguration');return}busy.value=true;formError.value='';try{const input=validated.data;if(editing.value){await updateDecisionProvider(fetcher,csrfToken,editing.value.id,{...input,expectedRevision:editing.value.revision});delete checks[editing.value.id]}else await createDecisionProvider(fetcher,csrfToken,input);dialog.value=false;draft.secret='';await load()}catch(e){if(e instanceof AgentApiError&&e.status===403)denied.value=true;formError.value=e instanceof Error?e.message:t('admin:decisionProviders.unableToSave');if(e instanceof AgentApiError&&e.status===409){await load();formError.value=t('admin:decisionProviders.staleRevisionCloseThisDialogAndReopen')}}finally{busy.value=false}}
async function check(p:DecisionProviderView){await act(async()=>{const result=await checkDecisionProvider(fetcher,csrfToken,p.id,p.revision);checks[p.id]=t('admin:decisionProviders.checkResult',{availability:result.configuredModelAvailable?t('admin:decisionProviders.modelAvailable'):t('admin:decisionProviders.modelUnavailable'),latency:result.latencyMs,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,cost:result.estimatedCostMicros===null?t('admin:decisionProviders.costUnknown'):t('admin:decisionProviders.costEstimate',{amount:result.estimatedCostMicros}),models:result.availableModels.join(', ')||t('admin:decisionProviders.noModels')})})}
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
