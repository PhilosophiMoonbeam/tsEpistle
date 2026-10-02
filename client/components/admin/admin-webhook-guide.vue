<template>
  <div class="receiver-guide">
    <div><span class="guide-kicker">{{ $t('admin:webhookGuide.receiverContractV1') }}</span><h3>{{ $t('admin:webhookGuide.verifyAcknowledgeProcess') }}</h3><p>{{ $t('admin:webhookGuide.deliveriesSignedHttpPost') }}</p></div>
    <ol><li><strong>{{ $t('admin:webhookGuide.verifySender') }}</strong><p>{{ $t('admin:webhookGuide.computeHmacSha256Using') }} <code>timestamp + "." + rawBody</code>{{ $t('admin:webhookGuide.prefixHexadecimalDigest') }} <code>sha256=</code> {{ $t('admin:webhookGuide.compare') }} <code>x-wiki-signature</code> {{ $t('admin:webhookGuide.usingConstantTimeComparison') }}</p></li><li><strong>{{ $t('admin:webhookGuide.acknowledgePromptly') }}</strong><p>{{ $t('admin:webhookGuide.return2xxStatusWithin') }}</p></li><li><strong>{{ $t('admin:webhookGuide.makeProcessingIdempotent') }}</strong><p>{{ $t('admin:webhookGuide.use') }} <code>x-wiki-delivery</code> {{ $t('admin:webhookGuide.recognizeRetriesSameDelivery') }}</p></li></ol>
    <div class="guide-columns"><section><h4>{{ $t('admin:webhookGuide.requestHeaders') }}</h4><dl><dt>{{ $t('admin:webhookGuide.xWikiDelivery') }}</dt><dd>{{ $t('admin:webhookGuide.stableDeliveryIdAcross') }}</dd><dt>{{ $t('admin:webhookGuide.xWikiEvent') }}</dt><dd>{{ $t('admin:webhookGuide.eventTypeSuchPage') }}</dd><dt>{{ $t('admin:webhookGuide.xWikiTimestamp') }}</dt><dd>{{ $t('admin:webhookGuide.isoTimestampAttempt') }}</dd><dt>{{ $t('admin:webhookGuide.xWikiSignature') }}</dt><dd>{{ $t('admin:webhookGuide.sha256FollowedHmacDigest') }}</dd><dt>{{ $t('admin:webhookGuide.contentType') }}</dt><dd>{{ $t('admin:webhookGuide.applicationJson') }}</dd></dl></section><section><h4>{{ $t('admin:webhookGuide.testEventEnvelope') }}</h4><pre>{{ example }}</pre><p class="guide-note">{{ $t('admin:webhookGuide.testUsesSameSigning') }}</p></section></div>
    <section class="guide-boundary"><h4>{{ $t('admin:webhookGuide.commentEventsRequireLiteral') }}</h4><p>{{ $t('common:actions.select') }} <code>comment.created</code>, <code>comment.updated</code>{{ $t('admin:webhookGuide.or') }} <code>comment.deleted</code> {{ $t('admin:webhookGuide.explicitlyExisting') }} <code>*</code> {{ $t('admin:webhookGuide.subscriptionNeverReceivesComment') }}</p><p>{{ $t('admin:webhookGuide.eventEnvelopeContainsOnly') }} <code>pageId</code>, <code>commentId</code>{{ $t('admin:webhookGuide.and') }} <code>action</code>{{ $t('admin:webhookGuide.neverIncludesCommentText') }}</p></section>
    <section class="guide-boundary"><h4>{{ $t('admin:webhookGuide.understandConnectionBoundary') }}</h4><p>{{ $t('admin:webhookGuide.endpointsMustResolvePublic') }}</p><p>{{ $t('admin:webhookGuide.workspaceEventsCanInclude') }}</p><p>{{ $t('admin:webhookGuide.completedQueueJobsEligible') }}</p></section>
  </div>
</template>
<script setup lang="ts">
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const example = JSON.stringify({ id: 'event-uuid', type: 'webhook.test', version: 1, createdAt: '2026-09-06T12:00:00.000Z', data: { test: true, message: t('admin:webhookGuide.testDeliveryTsepistle') } }, null, 2)
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
