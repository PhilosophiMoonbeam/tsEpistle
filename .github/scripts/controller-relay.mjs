import { appendFile, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const controller = 'PhilosophiMoonbeam/tsEpistle-ci'
const application = 'PhilosophiMoonbeam/tsEpistle'
const env = process.env
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
if (env.GITHUB_REPOSITORY !== application || env.GITHUB_REF !== 'refs/heads/main' || !env.GITHUB_WORKFLOW_REF?.startsWith(`${application}/.github/workflows/`) || !env.GITHUB_WORKFLOW_REF.endsWith('@refs/heads/main')) throw new Error('Only main-sourced application workflows may use controller authority.')
if (!env.GH_TOKEN) throw new Error('CI_CONTROLLER_TOKEN is required in the main-only trusted-ci-controller environment.')
const marketplace = env.RELAY_MODE === 'marketplace'
const release = !marketplace && env.GITHUB_EVENT_NAME === 'workflow_run'
const intent = marketplace ? 'marketplace' : release ? 'release' : env.PUBLISH_CANARY === 'true' ? 'canary' : 'qualification'
const revision = release ? event.workflow_run?.head_sha : env.GITHUB_SHA
const ref = release ? `refs/tags/${event.workflow_run?.head_branch}` : 'refs/heads/main'
if (!/^[0-9a-f]{40}$/.test(revision || '')) throw new Error('Invalid immutable application revision.')
if (!release && env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Only explicit main dispatch or validated release signals authorize full requests.')
if (release) {
  if (event.repository?.full_name !== application || !Number.isSafeInteger(event.workflow_run?.id) || !Number.isSafeInteger(event.workflow_run?.run_attempt)) throw new Error('Untrusted release signal identity.')
  const response = await fetch(`https://api.github.com/repos/${application}/actions/runs/${event.workflow_run.id}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) throw new Error(`Release signal metadata API failed closed: ${response.status}`)
  const signal = await response.json()
  if (signal.id !== event.workflow_run.id || signal.run_attempt !== event.workflow_run.run_attempt || signal.head_sha !== revision || signal.head_branch !== event.workflow_run.head_branch || signal.repository?.full_name !== application || signal.head_repository?.full_name !== application || signal.path !== '.github/workflows/release-request.yml' || signal.event !== 'push' || signal.status !== 'completed' || signal.conclusion !== 'success' || !/^refs\/tags\/v[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/.test(ref)) throw new Error('Untrusted release signal metadata.')
}
const version = env.APPLICATION_VERSION || ''
const snapshot = env.APT_SNAPSHOT || ''
if (marketplace && (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/.test(version) || !/^[0-9]{8}T[0-9]{6}Z$/.test(snapshot))) throw new Error('Invalid bounded marketplace version/apt snapshot.')
const request = `${marketplace ? 'packer' : 'app'}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
const workflow = marketplace ? 'marketplace.yml' : intent === 'qualification' ? 'full-qualification.yml' : 'full-publish.yml'
const title = `${request} | ${revision} | ${intent}${marketplace ? ` | ${version} | ${snapshot}` : ''}`
const started = new Date(Date.now() - 60000).toISOString()
const inputs = { application_sha: revision, application_ref: ref, request_id: request }
if (marketplace) Object.assign(inputs, { version, apt_snapshot: snapshot })
else if (intent === 'qualification') inputs.force = 'true'
else Object.assign(inputs, { publish_canary: String(intent === 'canary'), release_request_id: release ? `${event.workflow_run.id}-${event.workflow_run.run_attempt}` : '' })
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${controller}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) throw new Error(`Private controller ${method} API failed: ${response.status}`)
  return response.status === 204 ? null : response.json()
}
const matches = run => run.event === 'workflow_dispatch' && run.path === `.github/workflows/${workflow}` && run.head_branch === 'main' && run.repository?.full_name === controller && run.head_repository?.full_name === controller && run.display_title === title && /^[0-9a-f]{40}$/.test(run.head_sha || '')
let runId
let runAttempt
let runSha
let completed = false
let cancellationRequested = false
let dispatchInFlight = false
const interrupt = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  // Do not exit while dispatch is in flight: preserve intent until its exact run can be cancelled.
  cancellationRequested = true
  interrupt.abort()
  console.error(`Cancellation requested${dispatchInFlight ? ' during dispatch; retaining cancellation intent' : ''}.`)
})
async function reconcile() {
  const candidates = []
  for (let page = 1; ; page++) {
    const result = await api(`actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&created=${encodeURIComponent(`>=${started}`)}&per_page=100&page=${page}`)
    if (!Array.isArray(result.workflow_runs) || result.total_count > 1000) throw new Error('Ambiguous dispatch reconciliation result.')
    candidates.push(...result.workflow_runs.filter(matches))
    if (result.workflow_runs.length < 100) break
  }
  return candidates
}
async function cancel(run) {
  if (!Number.isSafeInteger(run.id) || !matches(run)) throw new Error('Refusing to cancel an unrelated private run.')
  if (run.status !== 'completed') await api(`actions/runs/${run.id}/cancel`, 'POST')
}
try {
  let dispatched
  let dispatchError
  dispatchInFlight = true
  try {
    // Exactly one POST; even a lost response is never redispatched or adopted as success.
    dispatched = await api(`actions/workflows/${workflow}/dispatches`, 'POST', { ref: 'main', inputs })
  } catch (error) { dispatchError = error }
  finally { dispatchInFlight = false }
  if (Number.isSafeInteger(dispatched?.workflow_run_id)) runId = dispatched.workflow_run_id
  if (dispatchError || !runId) {
    const candidates = await reconcile()
    for (const candidate of candidates) {
      try { await cancel(candidate) } catch (error) { console.error(error.message) }
    }
    throw new Error(`Dispatch response was ambiguous; reconciled ${candidates.length} exact request(s), requested cancellation, and will fail without redispatch. ${dispatchError?.message || ''}`)
  }
  console.log(`Exact private ${intent} request ${request}: ${controller}/actions/runs/${runId}; source ${revision}`)
  const deadline = Date.now() + 350 * 60 * 1000
  while (Date.now() < deadline) {
    const run = await api(`actions/runs/${runId}`)
    if (run.id !== runId || !matches(run) || run.run_attempt !== 1 || runSha && run.head_sha !== runSha) throw new Error('Private run identity/source/attempt does not match the exact dispatch.')
    runAttempt = run.run_attempt
    runSha = run.head_sha
    if (cancellationRequested) throw new Error('Public origin requested cancellation.')
    if (run.status === 'completed') {
      completed = true
      if (run.conclusion !== 'success') throw new Error(`Exact private run concluded ${run.conclusion}.`)
      await appendFile(env.GITHUB_OUTPUT, `APP_REVISION=${revision}\nAPP_REF=${ref}\nPRIVATE_RUN_ID=${runId}\nPRIVATE_RUN_ATTEMPT=${runAttempt}\nPRIVATE_CONTROLLER_REVISION=${runSha}\nREQUEST_ID=${request}\nINTENT=${intent}\n`)
      console.log(`Exact private ${intent} run succeeded for ${revision}.`)
      break
    }
    await delay(15000, undefined, { signal: interrupt.signal })
  }
  if (!completed) throw new Error('Timed out awaiting exact private run.')
} catch (error) {
  if (runId && !completed) {
    try { await cancel(await api(`actions/runs/${runId}`)) } catch (cancelError) { console.error(`Exact cancellation failed closed: ${cancelError.message}`) }
  }
  throw error
}
