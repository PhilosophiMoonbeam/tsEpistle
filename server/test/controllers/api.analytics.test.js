const store = { inspect: vi.fn(), save: vi.fn(), erase: vi.fn() }
vi.mockModule('../../operations/analytics-administration.ts', import.meta.url, () => ({ getAnalyticsAdministrationStore: () => store }))
vi.mockModule('express', import.meta.url, () => { const router = { get:vi.fn(),post:vi.fn(),put:vi.fn(),use:vi.fn() };return { default:{Router:()=>router,__router:router} } })
const {default:express}=await import('express')
const originalWiki=global.WIKI, user={id:1,authVersion:0}
const workspace=()=>({policy:{localEnabled:false,externalEnabled:false,audience:'everyone',excludeAdministrators:true,respectPrivacySignals:true,excludedPaths:[],retentionDays:90},fingerprint:'f'.repeat(64),providers:[{key:'plausible',title:'Plausible',description:'Traffic',isAvailable:true,isEnabled:false,website:'https://plausible.io',fields:[{key:'domain',title:'Domain',hint:'Site domain'}],config:{domain:'wiki.example.test'}}]})
const response=()=>({set:vi.fn().mockReturnThis(),status:vi.fn().mockReturnThis(),json:vi.fn()})
beforeEach(()=>{global.WIKI={auth:{checkAccess:vi.fn(()=>true)}};for(const fn of Object.values(store))fn.mockReset();store.inspect.mockResolvedValue(workspace());store.save.mockResolvedValue({revision:'saved'});store.erase.mockResolvedValue({revision:'erased',erasedRows:2})})
afterEach(()=>{global.WIKI=originalWiki})
const handlers=async()=>{await vi.importFresh('../../controllers/api/analytics.ts',import.meta.url);return Object.fromEntries(['get','post','put'].flatMap(method=>express.__router[method].mock.calls.map(([path,handler])=>[method+' '+path,handler])))}
describe('Reviewed Analytics HTTP and compatibility endpoints',()=>{
 it('passes current principals and complete review bodies to the authoritative store with no-store responses',async()=>{
  const routes=await handlers(),body={policy:{localEnabled:true},providers:[],fingerprint:'review',reason:'Reviewed change'}
  for(const [route,method] of [['get /workspace','inspect'],['put /workspace','save'],['post /workspace/erase','erase']]){const res=response();await routes[route]({user,body},res);expect(res.set).toHaveBeenCalledWith('Cache-Control','no-store');expect(store[method]).toHaveBeenCalledWith(...(method==='inspect'?[user,undefined]:[user,body]))}
 })
 it('denies every endpoint before reading provider or counter data',async()=>{
  const routes=await handlers();global.WIKI.auth.checkAccess.mockReturnValue(false)
  for(const route of Object.values(routes)){const res=response();await route({user,query:{}},res);expect(res.status).toHaveBeenCalledWith(403)}
  expect(store.inspect).not.toHaveBeenCalled();expect(store.save).not.toHaveBeenCalled();expect(store.erase).not.toHaveBeenCalled()
 })
 it('preserves expected conflict feedback and redacts unexpected database failures',async()=>{
  const routes=await handlers();store.save.mockRejectedValue(Object.assign(new Error('Analytics settings changed.'),{status:409}));let res=response();await routes['put /workspace']({user,body:{}},res);expect(res.status).toHaveBeenCalledWith(409);expect(res.json).toHaveBeenCalledWith({error:'Analytics settings changed.'})
  store.inspect.mockRejectedValue(new Error('database password secret'));res=response();await routes['get /workspace']({user},res);expect(res.status).toHaveBeenCalledWith(500);expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret')
 })
 it('lists compatible field envelopes without bypassing current administrative access',async()=>{
  const routes=await handlers(),res=response();await routes['get /providers']({user,query:{}},res);expect(store.inspect).toHaveBeenCalledWith(user)
  const field=res.json.mock.calls[0][0][0].config[0]
  expect(field).toEqual({key:'domain',value:expect.any(String)})
  expect(JSON.parse(field.value)).toEqual({type:'string',title:'Domain',hint:'Site domain',order:0,value:'wiki.example.test'})
 })
 it('routes legacy provider patches through one attributed atomic publication without resuming paused collection',async()=>{
  const routes=await handlers(),res=response();await routes['post /providers']({user,body:{providers:[{key:'plausible',isEnabled:true,config:[{key:'domain',value:'{"v":"new.example.test"}'}]}]}},res)
  expect(store.save).toHaveBeenCalledTimes(1)
  expect(store.save).toHaveBeenCalledWith(user,expect.objectContaining({policy:workspace().policy,providers:[{key:'plausible',isEnabled:true,config:{domain:'new.example.test'}}],fingerprint:'f'.repeat(64),reason:expect.any(String)}))
  const reason=store.save.mock.calls[0][1].reason.trim()
  expect(reason.length).toBeGreaterThanOrEqual(3)
  expect(reason.length).toBeLessThanOrEqual(1000)
  expect(res.status).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith({message:expect.any(String)})
 })
 it('rejects duplicate, unknown, prototype and malformed legacy fields before publication',async()=>{
  const routes=await handlers();for(const config of [[{key:'__proto__',value:'{"v":"bad"}'}],[{key:'domain',value:'broken'}],[{key:'domain',value:'{"v":{}}'}],[{key:'domain',value:'{"v":"one"}'},{key:'domain',value:'{"v":"two"}'}]]){const res=response();await routes['post /providers']({user,body:{providers:[{key:'plausible',isEnabled:true,config}]}},res);expect(res.status).toHaveBeenCalledWith(400)}expect(store.save).not.toHaveBeenCalled()
 })
})
