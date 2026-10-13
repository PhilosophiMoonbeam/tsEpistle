import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const root=import.meta.dir
const repo=JSON.parse(readFileSync(root+'/extraction.json','utf8')).repoAbsolutePath
// No live AI service is constructed. Catch unexpected fetches as an additional fail-closed guard.
globalThis.fetch=async()=>{throw new Error('offline probe forbids network fetch')}
const engine=await import(root+'/engine-probe.ts')
const {AxMockAIService}=await import(repo+'/node_modules/@ax-llm/ax/index.js')
const {createWikiSynthesisProgram,encodeWikiSynthesisSources}=await import(repo+'/server/agents/providers/wiki-synthesis.ts')
const bytes=(value:unknown)=>value===undefined?0:Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8')
const args=process.argv.slice(2);const inputPath=args[0]
if(!inputPath)throw Error('Supply private JSON snapshot or Markdown path')
const markdown=inputPath.endsWith('.md');const input=markdown?null:JSON.parse(readFileSync(inputPath,'utf8'))
const page=markdown?{id:13,revision:'2',title:'Diagnostic page',path:'diagnostic-page',content:readFileSync(inputPath,'utf8')}:Array.isArray(input)?input.find(p=>p.id===Number(args[1]??13)):input
if(!page)throw Error('Snapshot page missing')
if(!page.content&&page.contentFile){const {dirname,resolve}=await import('node:path');page.content=readFileSync(resolve(dirname(inputPath),page.contentFile),'utf8')}
const model=args[2]??'gemini-3.8-flash';const userRequest=page.question??'Who is our Falcon contact?'
const revision=String(page.sourceRevision??page.revision);const locale=page.localeCode??page.locale??'en';const href=`${page.visibility==='private'? '/_private':''}/${locale}/${page.path}`
const evidenceId=`page:${page.id}:revision:${revision}`
const doc=engine.parseSourceDocument(page.content,{representation:'markdown',truncated:false})
const units=engine.projectedSourceUnits(doc);const sections=engine.sourceSections(doc,units)
let tocApproximation=!page.toc
let citationSections:any[]
if(page.toc) citationSections=engine.productionPageCitation({...page,sourceRevision:revision},page.id,locale,null).citationSections
else citationSections=sections.map((s,index)=>({evidenceId:`${evidenceId}:section:${index+1}`,label:[page.title,...(s.ancestry[0]===page.title?s.ancestry.slice(1):s.ancestry)].join(' › '),href:href+'#probe-section-'+(index+1)}))
const output={id:page.id,locale,path:page.path,title:page.title,sourceRevision:revision,contentType:'markdown',content:page.content,citation:{evidenceId,label:page.title,href},citationSections}
const all=new Map();engine.collectPageEvidence('pages.get','probe-call',output,all,[])
if(!all.size)throw Error('production evidence normalization admitted nothing')
const productionRequest={memory:{user:[],agent:[]},skills:[],run:{executionMode:'agent'},knowledgeContext:{scope:{kind:'all'},sources:[]}}
const prefix=engine.prompt(productionRequest,null,undefined,false,true,'final-synthesis')
const result:any={sourceUtf8Bytes:bytes(page.content),sourceCharacters:page.content.length,sourceSha256:createHash('sha256').update(page.content).digest('hex'),projectedUnitCount:units.length,completeProjectedUnits:units.filter(u=>u.complete).length,parsedSectionCount:sections.length,providedCitationSections:citationSections.length,registeredEvidenceCount:all.size,contextCeiling:128000,outputAllowance:8192,model,tocApproximation,assumptions:['Mock response only; no Google/TypeSafe transport or network dispatch','Captures generated Ax request before admission; does not invoke full agent runtime','Empty memory and selected skills; all-Wiki scope; one request facet; no observations/repair feedback','No tokenizer estimate claimed; all quantities explicitly bytes/counts','Ordinary collected conversation is not appended to typed generation; final-synthesis production prefix is prepended']}
async function capture(label:string,evidence:Map<any,any>){
 const {sources,sourceStructures}=engine.probeBuildSynthesisSources(evidence,{userRequest,requestFacets:[userRequest]});const wire=encodeWikiSynthesisSources(sources,sourceStructures)
 type TextRef=number|[number,number,number]
 type SourceRow=[unknown,unknown,unknown,string,TextRef|null,TextRef[]|null,unknown,unknown,unknown?]
 type LocatorMetricsStructures={texts:Record<number,string>;sources:Record<number,SourceRow>;owners:Record<number,[string,string]>}
 const structures:LocatorMetricsStructures=JSON.parse(wire.sourceStructures);const bindings:Record<string,[number,number]>=JSON.parse(wire.sourceBindings)
 if(!structures.texts||!structures.sources||Array.isArray(structures.texts)||Array.isArray(structures.sources)||typeof structures.texts!=='object'||typeof structures.sources!=='object')throw Error('Expected explicit numeric-key source dictionaries')
 const decode=(ref:TextRef):string=>typeof ref==='number'?structures.texts[ref]:structures.texts[ref[0]].slice(ref[1],ref[2])
 // These exact-use categories overlap each other and the physical pool; never add them.
 const selectedTexts=new Set<string>();const quotations=new Set<string>();const authoredDependencies=new Set<string>()
 let structureScopeCount=0;let pooledTextCount=0;let pooledTextUtf8Bytes=0
 for(const key in structures.sources){
  const row=structures.sources[Number(key)];structureScopeCount++
  selectedTexts.add(row[3])
  if(row[4]!==null)quotations.add(decode(row[4]))
  for(const ref of row[5]??[])authoredDependencies.add(decode(ref))
 }
 for(const key in structures.texts){pooledTextCount++;pooledTextUtf8Bytes+=bytes(structures.texts[Number(key)])}
 const uniqueTextBytes=(texts:Set<string>)=>{let sum=0;for(const text of texts)sum+=bytes(text);return sum}
 let captured:any
 const ai=new AxMockAIService({features:{functions:false,streaming:false,structuredOutputs:true,structuredOutputModes:['native']},chatResponse:async(request:any)=>{captured=request;return {results:[{index:0,content:JSON.stringify({claims:[],unresolvedFacets:[0],observations:[]}),finishReason:'stop'}]}}})
 const program=createWikiSynthesisProgram(sources,{facetCount:1,structured:true,maxOutputTokens:8192})
 await program.forward(ai,{userRequest,...wire,requestFacets:[userRequest],availableObservations:[],repairFeedback:''},{structuredOutputMode:'native',maxRetries:0,maxSteps:1,asyncMode:'off',sampleCount:1,model,modelConfig:{maxTokens:8192}})
 if(!captured)throw Error('Mock capture did not execute')
 const chatPrompt=captured.chatPrompt.map((message:any,index:number)=>index===0&&message.role==='system'?{...message,content:prefix+'\n\n'+message.content}:message)
 const final={...captured,model,chatPrompt,modelConfig:{...captured.modelConfig,maxTokens:8192}}
 const serialized=engine.serializedProviderRequestBytes({model},null,chatPrompt,8192,final)
 const bindingGroups=new Set(sources.map(s=>JSON.stringify([s.evidenceId,s.sourceRevision]))).size
 const projectionCount=Object.keys(bindings).length
 result[label]={evidenceCount:evidence.size,synthesisSources:sources.length,uniqueNativeUnits:new Set(sources.map(s=>s.unitId)).size,structureInputEntries:sourceStructures.length,bindingGroups,projectionCount,projectedTextBytes:sources.reduce((sum,s)=>sum+bytes(s.text),0),uniqueProjectedTextBytes:[...new Set(sources.map(s=>s.text))].reduce((sum,s)=>sum+bytes(s),0),sourceBindingsBytes:bytes(wire.sourceBindings),sourceStructuresBytes:bytes(wire.sourceStructures),structureScopeCount,scopeJsonBytes:bytes(structures.sources),pooledTextCount,pooledTextUtf8Bytes,pooledTextJsonBytes:bytes(structures.texts),uniqueSelectedTextCount:selectedTexts.size,uniqueSelectedTextUtf8Bytes:uniqueTextBytes(selectedTexts),uniqueQuotationCount:quotations.size,uniqueQuotationUtf8Bytes:uniqueTextBytes(quotations),uniqueAuthoredDependencyCount:authoredDependencies.size,uniqueAuthoredDependencyUtf8Bytes:uniqueTextBytes(authoredDependencies),axChatPromptBytes:bytes(captured.chatPrompt),axSystemContentBytes:bytes(captured.chatPrompt[0].content),axUserContentBytes:captured.chatPrompt.filter((m:any)=>m.role==='user').reduce((n,m)=>n+bytes(m.content),0),responseFormatBytes:bytes(captured.responseFormat),outputSchemaBytes:bytes(captured.responseFormat?.schema?.schema??captured.responseFormat),productionPrefixBytes:bytes(prefix),finalSerializedAxRequestBytes:serialized,contextOutputAllowance:128000-serialized,requestedInputPlusOutput:serialized+8192,passesRequestedContext:serialized+8192<=128000,topLevelComponentJsonBytes:Object.fromEntries(Object.entries(final).map(([k,v])=>[k,bytes(v)]))}
}
await capture('rootOnly',new Map([[evidenceId,all.get(evidenceId)]]));await capture('rootAndSections',all);await capture('noSourceBaseline',new Map())
writeFileSync(root+'/'+(process.env.PROBE_METRICS_FILE??'metrics.json'),JSON.stringify(result,null,2),{mode:0o600})
console.log(JSON.stringify(result,null,2))
