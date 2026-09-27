<template>
  <div class="receiver-guide">
    <div><span class="guide-kicker">Receiver contract / v1</span><h3>Verify. Acknowledge. Process.</h3><p>Deliveries are signed HTTP POST requests with a JSON envelope. Read the raw request body before parsing it so signature verification uses the exact bytes that were sent.</p></div>
    <ol><li><strong>Verify the sender</strong><p>Compute HMAC-SHA256 using your endpoint secret over <code>timestamp + "." + rawBody</code>. Prefix the hexadecimal digest with <code>sha256=</code> and compare it with <code>x-wiki-signature</code> using a constant-time comparison. Reject stale timestamps using a tolerance appropriate to your infrastructure.</p></li><li><strong>Acknowledge promptly</strong><p>Return a 2xx status within 10 seconds. Redirects are not followed. Queue longer work on your receiver so processing does not delay acknowledgement.</p></li><li><strong>Make processing idempotent</strong><p>Use <code>x-wiki-delivery</code> to recognize retries of the same delivery. Regular events allow up to eight attempts; failed deliveries can be manually retried. Do not assume exactly-once delivery or event ordering.</p></li></ol>
    <div class="guide-columns"><section><h4>Request headers</h4><dl><dt>x-wiki-delivery</dt><dd>Stable delivery ID across attempts.</dd><dt>x-wiki-event</dt><dd>Event type, such as page.updated.</dd><dt>x-wiki-timestamp</dt><dd>ISO timestamp for this attempt.</dd><dt>x-wiki-signature</dt><dd>sha256= followed by the HMAC digest.</dd><dt>content-type</dt><dd>application/json</dd></dl></section><section><h4>Test event envelope</h4><pre>{{ example }}</pre><p class="guide-note">The test uses the same signing and delivery path as regular events. It contains no page content or private metadata.</p></section></div>
    <section class="guide-boundary"><h4>Comment events require literal opt-in</h4><p>Select <code>comment.created</code>, <code>comment.updated</code>, or <code>comment.deleted</code> explicitly. An existing <code>*</code> subscription never receives comment events. A comment event is delivered only while its page is currently public, published, searchable, unprotected, and anonymously readable with discussions enabled; later changes to page access, publication, protection, or comment visibility suppress queued deliveries.</p><p>The event envelope contains only event identity and time plus <code>pageId</code>, <code>commentId</code>, and <code>action</code>. It never includes comment text/rendering, guest identity, email, IP address, authentication fields, or private-page metadata. Use your own authorized API read if you need comment content.</p></section>
    <section class="guide-boundary"><h4>Understand the connection boundary</h4><p>Endpoints must resolve to a public network address over HTTPS and cannot contain URL credentials. Each attempt uses the endpoint’s currently saved URL and secret. Updating either also affects queued deliveries.</p><p>Workspace events can include private page metadata and review comments. There are no per-page access rules on webhook subscriptions. Keep receiver access aligned with this responsibility.</p><p>Completed queue jobs are eligible for cleanup after 30 days; their linked delivery history is removed too. Delivery history is an operational view, not a permanent audit archive.</p></section>
  </div>
</template>
<script setup lang="ts">
const example = JSON.stringify({ id: 'event-uuid', type: 'webhook.test', version: 1, createdAt: '2026-09-06T12:00:00.000Z', data: { test: true, message: 'Test delivery from tsEpistle.' } }, null, 2)
</script>
<style scoped>
.receiver-guide { display: grid; gap: 1.75rem; }
h3 { font: 500 1.7rem var(--wiki-font-display); margin-block: .5rem 1rem; }
h4 { font-size: .95rem; margin-bottom: 1rem; }
p, dd { font-size: .85rem; line-height: 1.75; }
ol { padding-inline-start: 1.5rem; } li { padding-inline-start: .5rem; margin-bottom: 1rem; } li strong { font-size: .95rem; } li p { margin-top: .4rem; }
.guide-kicker { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: var(--wiki-accent-ink); }
.guide-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
.guide-columns section, .guide-boundary { border-top: 1px solid var(--wiki-surface-border); padding-top: 1.5rem; min-width: 0; }
dt, code { font-family: var(--wiki-font-mono); font-size: .8rem; overflow-wrap: anywhere; } dd { margin: .25rem 0 1rem; }
pre { background: var(--wiki-surface-raised); border: 1px solid var(--wiki-surface-border); padding: 1rem; border-radius: var(--wiki-control-radius); font-size: .75rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.guide-note { margin-top: .75rem; } .guide-boundary p { margin-bottom: .75rem; }
@media(max-width: 760px) { .guide-columns { grid-template-columns: 1fr; } }
</style>
