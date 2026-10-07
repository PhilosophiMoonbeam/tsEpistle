<template>
  <article class="storage-receipt">
    <div class="storage-section-head"><span class="storage-kicker">{{ $t('admin:storageOperationReceipt.operationReceipt') }}</span><v-btn
        variant="text"
        size="small"
        prepend-icon="mdi-download"
        @click="emit('download')"
      >{{ $t('admin:storageOperationReceipt.downloadReceipt') }}</v-btn></div>
    <h3>{{ operation.title }}</h3>
    <p>{{ operation.effect }}</p>
    <dl class="storage-facts">
      <dt>{{ $t('admin:storageOperationReceipt.outcome') }}</dt>
      <dd>{{ operationLabel(operation.state) }}</dd>
      <dt>{{ $t('admin:storageOperationReceipt.requested') }}</dt>
      <dd>{{ actor(operation.actorId) }}</dd>
      <dt>{{ $t('admin:storageOperationReceipt.reason') }}</dt>
      <dd>{{ operation.reason }}</dd>
      <dt>{{ $t('admin:storageOperationReceipt.queued') }}</dt>
      <dd>{{ dateTime(operation.createdAt) }}</dd>
      <dt>{{ $t('admin:storageOperationReceipt.started') }}</dt>
      <dd>{{ dateTime(operation.startedAt) }}</dd>
      <dt>{{ $t('admin:storageOperationReceipt.finished') }}</dt>
      <dd>{{ dateTime(operation.completedAt) }}</dd>
      <dt>{{ $t('admin:storageOperationReceipt.configurationRevision') }}</dt>
      <dd class="storage-mono">{{ operation.configurationRevision || $t('admin:storageOperationReceipt.initialConfiguration') }}</dd>
    </dl>
    <v-alert
      v-if="operation.state === 'interrupted'"
      variant="tonal"
      type="warning"
      class="my-5"
    >{{ $t('admin:storageOperationReceipt.workerNoLongerHas') }}</v-alert>
    <p
      v-if="operation.result"
      class="storage-result-message"
    >{{ operation.result.message }}</p>
    <div
      v-if="operation.result?.counts"
      class="storage-result-counts"
    ><span><strong>{{ operation.result.counts.total }}</strong> {{ $t('admin:storageOperationReceipt.reportedItems') }}</span><span><strong>{{ operation.result.counts.succeeded }}</strong>
        {{ $t('admin:storageOperationReceipt.succeeded') }}</span><span><strong>{{ operation.result.counts.failed }}</strong> {{ $t('admin:storageOperationReceipt.failedConflicted') }}</span></div>
    <p
      v-else-if="operation.result && operation.handler !== 'activate'"
      class="storage-note"
    >{{ $t('admin:storageOperationReceipt.operationDidNotReport') }}</p>
    <div
      v-if="operation.result?.counts"
      class="storage-formats"
    ><span
        v-for="(count,format) in operation.result.counts.formats"
        :key="format"
      >{{ formatLabel(format) }} <strong>{{ count }}</strong></span></div>
    <ul
      v-if="operation.result?.targets.length"
      class="storage-applied-targets"
    >
      <li
        v-for="target in operation.result.targets"
        :key="target.key"
      ><strong>{{ targetTitle(target.key) }}</strong><span>{{ target.paused ? $t('admin:storageOperationReceipt.pausedOffline') : target.active ? $t('admin:storageOperationReceipt.initialized') : $t('admin:storageOperationReceipt.initializationFailed') }}</span>
      </li>
    </ul>
    <details
      v-for="(item,index) in operation.result?.items || []"
      :key="index"
      class="storage-item-result"
    >
      <summary><span>{{ item.path || $t('admin:storageOperationReceipt.unnamedItem') }}</span><span>{{ $t(itemOutcomeLabel(item.outcome)) }}</span></summary>
      <p>{{ $t(itemKindLabel(item.kind)) }} · {{ item.format ? formatLabel(item.format) : $t('admin:storageOperationReceipt.noDocumentFormat') }}</p>
      <p v-if="item.message">{{ item.message }}</p>
      <ul v-if="item.diagnostics.length">
        <li
          v-for="(diagnostic,n) in item.diagnostics"
          :key="n"
        >{{ diagnostic }}</li>
      </ul>
    </details>
    <p
      v-if="operation.result?.counts && operation.result.counts.total > operation.result.items.length"
      class="storage-note"
    >{{ $t('admin:storageOperationReceipt.receiptRetainsFirstItem', { itemsCount: operation.result.items.length, interpolation: { escapeValue: false } }) }}</p>
    <div
      v-if="operation.resolution"
      class="storage-resolution"
    >
      <h4>{{ operation.state === 'cancelled' ? $t('admin:storageOperationReceipt.cancellation') : $t('admin:storageOperationReceipt.recoveryDecision') }}</h4>
      <p>{{ operation.resolution.reason }}</p><small>{{ actor(operation.resolution.actorId) }} ·
        {{ dateTime(operation.resolution.createdAt) }}</small>
    </div>
    <div class="storage-receipt-actions"><v-btn
        v-if="operation.canCancel"
        variant="outlined"
        :disabled="locked"
        @click="emit('decision',{operation,kind:'cancel'})"
      >{{ $t('admin:storageOperationReceipt.cancelBeforeExecution') }}</v-btn><v-btn
        v-if="operation.canResolve"
        variant="outlined"
        :disabled="locked"
        @click="emit('decision',{operation,kind:'resolve'})"
      >{{ $t('admin:storageOperationReceipt.reviewRecoveryDecision') }}</v-btn>
      <p
        v-if="operation.state === 'running'"
        class="storage-note"
      >{{ $t('admin:storageOperationReceipt.runningProviderWorkCannot') }}</p>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { StorageOperationView } from '../../../shared/storage-workspace.ts'
import { dateTime, actor, formatLabel, operationLabel, itemOutcomeLabel, itemKindLabel } from '../../helpers/storage-presentation.ts'
const { operation, targetTitles, locked } = defineProps<{ operation: StorageOperationView; targetTitles: Record<string, string>; locked: boolean }>()
const emit = defineEmits<{ download: []; decision: [value: { operation: StorageOperationView; kind: 'cancel' | 'resolve' }] }>()
const targetTitle = (key: string) => targetTitles[key] || key
</script>
