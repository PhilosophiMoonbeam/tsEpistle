<template>
  <section class="control-panel" aria-labelledby="decision-title">
    <header><div><h2 id="decision-title">Agent Decision Providers</h2><p>Structured classification for automatic routing, separate from the generative models that answer users. Configure credentials, check the connection, enable the provider, then select the decision default.</p></div><div><v-btn variant="text" :disabled="busy || loading" :loading="loading" @click="load">Refresh</v-btn><v-btn color="primary" :disabled="busy || loading || denied || !loaded" @click="open()">Add decision provider</v-btn></div></header>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
    <v-alert type="info" variant="tonal">Native TypeSafe / Jev uses its native decision API, not an OpenAI-compatible endpoint. It uses the server bootstrap TYPESAFE_API_KEY when no managed credential is configured. Custom providers require an explicit chat-completions or completions dialect; Wiki does not guess the protocol. Keys are write-only and never read back. Costs below are configured estimates, not billing. Saving configuration clears verification and disables the provider until it is checked and enabled again.</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading decision providers" />
    <p v-if="loaded && !providers.length">No decision providers configured. Add a provider, check it, then enable it and select a default.</p>
    <v-alert v-if="loaded && providers.length && !providers.some(p => p.isDefault && p.enabled && p.secretConfigured && p.checkedAt)" type="warning" variant="tonal">No ready decision default is configured. Automatic routing requires a ready selected provider or decision default; this is not the generative model default.</v-alert>
    <article v-for="p in providers" :key="p.id" class="entry">
      <h3>{{ p.displayName }} <v-chip v-if="p.isDefault" size="small" color="primary">Default</v-chip></h3>
      <p>{{ p.config.kind === 'typesafe' ? 'Native TypeSafe / Jev' : `Custom · ${p.config.dialect}` }} · {{ p.config.model }} · revision {{ p.revision }} · {{ p.enabled ? 'Enabled' : 'Disabled' }}</p>
      <p>Credential: {{ p.credentialSource }} · {{ p.secretConfigured ? 'configured' : 'not configured' }}. Last check: {{ p.checkedAt || 'never' }}.</p>
      <p>Pricing: {{ p.config.pricing ? `USD ${p.config.pricing.inputPerMillion}/million input; ${p.config.pricing.outputPerMillion}/million output; ${p.config.pricing.perRequest}/request · ${p.config.pricing.revision}` : 'Unknown (no cost estimate)' }}</p>
      <p v-if="checks[p.id]" role="status">{{ checks[p.id] }}</p>
      <div class="actions"><v-btn v-for="action in providerActions" :key="action.id" :variant="action.variant" :color="action.color" :disabled="busy || loading || denied || (action.id === 'check' && !p.secretConfigured) || (action.id === 'toggle' && !p.enabled && (!p.secretConfigured || !p.checkedAt)) || (action.id === 'default' && (!p.enabled || !p.secretConfigured || !p.checkedAt || p.isDefault))" @click="runProviderAction(action.id,p)">{{ action.id === 'toggle' ? (p.enabled ? 'Disable' : 'Enable') : action.label }}</v-btn></div>
    </article>
    <v-dialog :model-value="dialog" max-width="760" :persistent="busy" @update:model-value="close"><v-card><v-card-title>{{ editing ? 'Edit decision provider' : 'Add decision provider' }}</v-card-title><v-card-text>
      <v-alert v-if="formError" type="error" variant="tonal" role="alert">{{ formError }}</v-alert>
      <v-alert v-if="editingStale" type="warning" variant="tonal">This provider changed or was removed. Your unsaved configuration is preserved; close and reopen the current revision before saving.</v-alert>
      <v-form @submit.prevent="save">
      <template v-for="field in decisionFields" :key="field.key">
        <template v-if="field.scope === 'custom' ? draft.kind === 'openai-compatible' : field.scope === 'pricing' ? draft.knownPricing : true">
          <v-text-field v-if="field.control === 'text'" v-model="draft[field.key]" :label="field.label" :type="field.type" :autofocus="field.autofocus" :autocomplete="field.key === 'secret' ? 'new-password' : undefined" :disabled="busy || denied || (field.key === 'secret' && draft.clearSecret)" />
          <v-text-field v-else-if="field.control === 'number'" v-model.number="draft[field.key]" type="number" :label="field.label" :disabled="busy || denied" />
          <v-checkbox v-else-if="field.control === 'checkbox'" v-model="draft[field.key]" :label="field.label" :disabled="busy || denied" />
          <v-select v-else-if="field.control === 'kind'" v-model="draft.kind" :label="field.label" :items="providerKinds" :disabled="busy || denied" />
          <v-select v-else v-model="draft.dialect" :label="field.label" :items="['chat-completions','completions']" :disabled="busy || denied" />
        </template>
      </template>
      <v-card-actions><v-btn :disabled="busy" @click="close(false)">Cancel</v-btn><v-spacer /><v-btn type="submit" color="primary" :loading="busy" :disabled="denied || loading || editingStale || JSON.stringify(draft) === baseline">Save configuration</v-btn></v-card-actions></v-form>
    </v-card-text></v-card></v-dialog>
    <v-dialog v-model="discard" max-width="440"><v-card title="Discard unsaved changes?"><v-card-text>Your new credential and configuration have not been saved.</v-card-text><v-card-actions><v-btn @click="discard=false">Keep editing</v-btn><v-btn color="error" @click="discard=false;dialog=false;draft.secret=''">Discard</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog :model-value="Boolean(remove)" max-width="440" :persistent="busy" @update:model-value="value => { if (!value && !busy) remove=null }"><v-card title="Delete decision provider?"><v-card-text>{{ remove?.displayName }} will no longer be available for routing. Routing policies referencing it require another ready provider or the decision default.</v-card-text><v-card-actions><v-btn :disabled="busy" @click="remove=null">Cancel</v-btn><v-btn color="error" :loading="busy" :disabled="denied || loading" @click="removeProvider">Delete</v-btn></v-card-actions></v-card></v-dialog>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { AgentApiError } from '../../helpers/agents-api.ts'
import { DecisionProviderWriteSchema } from '../../../shared/agents/decision-providers.ts'
import { listDecisionProviders,createDecisionProvider,updateDecisionProvider,deleteDecisionProvider,enableDecisionProvider,defaultDecisionProvider,checkDecisionProvider,type DecisionProviderView } from '../../helpers/agent-control-api.ts'
const {csrfToken,refreshKey=0}=defineProps<{csrfToken:string;refreshKey?:number}>()
const emit=defineEmits<{state:[providers:DecisionProviderView[]|null]}>()
const fetcher:typeof fetch=(...args)=>window.fetch(...args)
const providers=ref<DecisionProviderView[]>([]),loading=ref(false),loaded=ref(false),busy=ref(false),denied=ref(false),error=ref(''),formError=ref(''),dialog=ref(false),discard=ref(false),editing=ref<DecisionProviderView|null>(null),remove=ref<DecisionProviderView|null>(null),baseline=ref('')
const checks=reactive<Record<string,string>>({})
const editingStale=computed(()=>Boolean(editing.value)&&providers.value.find(p=>p.id===editing.value?.id)?.revision!==editing.value?.revision)
let controller:AbortController|null=null
const draft=reactive({displayName:'',kind:'typesafe' as 'typesafe'|'openai-compatible',model:'jev-latest',baseUrl:'',dialect:'chat-completions' as 'chat-completions'|'completions',timeoutMs:5000,maxOutputTokens:1024,secret:'',clearSecret:false,knownPricing:false,inputPerMillion:0,outputPerMillion:0,perRequest:0,pricingRevision:'',source:'',verifiedAt:''})
type DecisionField = {label:string;scope?:'custom'|'pricing'} & (
  | {control:'text';key:'displayName'|'model'|'baseUrl'|'secret'|'pricingRevision'|'source'|'verifiedAt';type?:'password'|'date';autofocus?:boolean}
  | {control:'number';key:'maxOutputTokens'|'timeoutMs'|'inputPerMillion'|'outputPerMillion'|'perRequest'}
  | {control:'checkbox';key:'clearSecret'|'knownPricing'}
  | {control:'kind';key:'kind'}
  | {control:'dialect';key:'dialect'}
)
const providerKinds=[{title:'Native TypeSafe / Jev',value:'typesafe'},{title:'Custom OpenAI-compatible',value:'openai-compatible'}]
const decisionFields:readonly DecisionField[]=[
  {control:'text',key:'displayName',label:'Display name',autofocus:true},
  {control:'kind',key:'kind',label:'Provider kind'},
  {control:'text',key:'model',label:'Explicit model'},
  {control:'text',key:'baseUrl',label:'Public HTTPS base URL',scope:'custom'},
  {control:'dialect',key:'dialect',label:'Explicit API dialect',scope:'custom'},
  {control:'number',key:'maxOutputTokens',label:'Maximum output tokens (64–4096)',scope:'custom'},
  {control:'number',key:'timeoutMs',label:'Timeout milliseconds (100–30000)'},
  {control:'text',key:'secret',label:'New credential (blank retains current credential)',type:'password'},
  {control:'checkbox',key:'clearSecret',label:'Clear managed credential (native provider may use server bootstrap key)'},
  {control:'checkbox',key:'knownPricing',label:'Configure verified USD pricing (otherwise unknown)'},
  {control:'number',key:'inputPerMillion',label:'USD per million input tokens',scope:'pricing'},
  {control:'number',key:'outputPerMillion',label:'USD per million output tokens',scope:'pricing'},
  {control:'number',key:'perRequest',label:'USD per request',scope:'pricing'},
  {control:'text',key:'pricingRevision',label:'Pricing revision',scope:'pricing'},
  {control:'text',key:'source',label:'Pricing source',scope:'pricing'},
  {control:'text',key:'verifiedAt',label:'Verified date',type:'date',scope:'pricing'}
]
type ProviderActionId='edit'|'check'|'toggle'|'default'|'delete'
const providerActions:readonly {id:ProviderActionId;label:string;variant:'text'|'tonal';color?:string}[]=[
  {id:'edit',label:'Edit',variant:'text'},
  {id:'check',label:'Check connection',variant:'tonal'},
  {id:'toggle',label:'Enable',variant:'text'},
  {id:'default',label:'Set default',variant:'text'},
  {id:'delete',label:'Delete',variant:'text',color:'error'}
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
async function load(){controller?.abort();const request=new AbortController();controller=request;loading.value=true;try{const current=await listDecisionProviders(fetcher,csrfToken,request.signal);if(request.signal.aborted)return;for(const p of current){const previous=providers.value.find(provider=>provider.id===p.id);if(previous&&previous.revision!==p.revision)delete checks[p.id]}providers.value=current;loaded.value=true;denied.value=false;error.value='';emit('state',current)}catch(e){if(request.signal.aborted)return;denied.value=e instanceof AgentApiError && e.status===403;error.value=denied.value?'System administration permission is required.':e instanceof Error?e.message:'Unable to load decision providers.';emit('state',null)}finally{if(controller===request)loading.value=false}}
function open(p?:DecisionProviderView){editing.value=p??null;Object.assign(draft,{displayName:p?.displayName??'',kind:p?.config.kind??'typesafe',model:p?.config.model??'jev-latest',baseUrl:p?.config.kind==='openai-compatible'?p.config.baseUrl:'',dialect:p?.config.kind==='openai-compatible'?p.config.dialect:'chat-completions',timeoutMs:p?.config.timeoutMs??5000,maxOutputTokens:p?.config.kind==='openai-compatible'?p.config.maxOutputTokens:1024,secret:'',clearSecret:false,knownPricing:Boolean(p?.config.pricing),inputPerMillion:p?.config.pricing?.inputPerMillion??0,outputPerMillion:p?.config.pricing?.outputPerMillion??0,perRequest:p?.config.pricing?.perRequest??0,pricingRevision:p?.config.pricing?.revision??'',source:p?.config.pricing?.source??'',verifiedAt:p?.config.pricing?.verifiedAt??''});baseline.value=JSON.stringify(draft);formError.value='';dialog.value=true}
function close(value:boolean){if(value||busy.value)return;if(JSON.stringify(draft)!==baseline.value)discard.value=true;else{dialog.value=false;draft.secret=''}}
async function act(operation:()=>Promise<unknown>){if(busy.value||loading.value||denied.value)return;busy.value=true;error.value='';try{await operation();await load()}catch(e){if(e instanceof AgentApiError&&e.status===403)denied.value=true;error.value=e instanceof Error?e.message:'Operation failed.';if(e instanceof AgentApiError&&e.status===409){await load();remove.value=null;error.value='Configuration changed elsewhere. Refreshed current revisions; review before retrying.'}}finally{busy.value=false}}
async function save(){if(busy.value||loading.value||denied.value||editingStale.value)return;busy.value=true;formError.value='';try{const pricing=draft.knownPricing?{currency:'USD' as const,inputPerMillion:draft.inputPerMillion,outputPerMillion:draft.outputPerMillion,perRequest:draft.perRequest,revision:draft.pricingRevision,source:draft.source,verifiedAt:draft.verifiedAt}:null;const config=draft.kind==='typesafe'?{kind:'typesafe' as const,model:draft.model,timeoutMs:draft.timeoutMs,pricing}:{kind:'openai-compatible' as const,model:draft.model,baseUrl:draft.baseUrl,dialect:draft.dialect,timeoutMs:draft.timeoutMs,maxOutputTokens:draft.maxOutputTokens,pricing};const input=DecisionProviderWriteSchema.parse({displayName:draft.displayName,config,...(draft.clearSecret?{secretValue:null}:draft.secret?{secretValue:draft.secret}:{})});if(editing.value){await updateDecisionProvider(fetcher,csrfToken,editing.value.id,{...input,expectedRevision:editing.value.revision});delete checks[editing.value.id]}else await createDecisionProvider(fetcher,csrfToken,input);dialog.value=false;draft.secret='';await load()}catch(e){if(e instanceof AgentApiError&&e.status===403)denied.value=true;formError.value=e instanceof Error?e.message:'Unable to save.';if(e instanceof AgentApiError&&e.status===409){await load();formError.value='Stale revision. Close this dialog and reopen the refreshed provider before retrying.'}}finally{busy.value=false}}
async function check(p:DecisionProviderView){await act(async()=>{const result=await checkDecisionProvider(fetcher,csrfToken,p.id,p.revision);checks[p.id]=`${result.configuredModelAvailable?'Model available':'Configured model unavailable'} · ${result.latencyMs} ms measured · ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens · ${result.estimatedCostMicros===null?'Cost unknown':`${result.estimatedCostMicros} µUSD estimate (not billing)`} · Server-discovered models: ${result.availableModels.join(', ') || 'none'}`})}
async function removeProvider(){const p=remove.value;if(!p)return;await act(async()=>{await deleteDecisionProvider(fetcher,csrfToken,p.id,p.revision);remove.value=null})}
watch(()=>refreshKey,()=>{void load()})
onBeforeUnmount(()=>controller?.abort())
onMounted(load)
</script>
<style scoped>
.control-panel{padding:24px;background:rgb(var(--v-theme-surface));border-radius:16px}header{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}h2,h3{color:rgb(var(--v-theme-primary))}p{line-height:1.6}.entry{padding:20px 0;border-bottom:1px solid rgba(var(--v-theme-on-surface),.12)}.actions{display:flex;flex-wrap:wrap;gap:8px}.v-alert{margin-bottom:16px}
</style>
