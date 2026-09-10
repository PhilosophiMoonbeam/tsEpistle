<template>
  <div
    v-if="visible"
    ref="beamRef"
    class="photon-reading-beam"
    :class="{ 'is-milestone': isMilestone, 'is-rtl': isRtl }"
    role="progressbar"
    :aria-valuenow="Math.round(clampedProgress)"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="title || 'Reading progress'"
  >
    <div
      class="photon-laser-track"
      :style="{ width: `${clampedProgress}%` }"
    >
      <div
        v-if="clampedProgress > 0"
        class="laser-beam-head"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useLocale } from 'vuetify'

interface Props {
  progress: number
  visible?: boolean
  title?: string
}

const {
  progress = 0,
  visible = true,
  title = ''
} = defineProps<Props>()

const emit = defineEmits<(e: 'milestone') => void>()

const beamRef = useTemplateRef<HTMLElement>('beamRef')

let isRtl = ref(false)
try {
  const locale = useLocale()
  isRtl = locale.isRtl
} catch {
  // Graceful fallback outside of Vuetify provider
}

const clampedProgress = computed(() => {
  if (typeof progress !== 'number' || Number.isNaN(progress)) return 0
  return Math.min(100, Math.max(0, progress))
})

const milestoneTriggered = ref(false)
const isMilestone = ref(false)

watch(
  () => clampedProgress.value,
  (val) => {
    if (val >= 99.5) {
      if (!milestoneTriggered.value) {
        milestoneTriggered.value = true
        isMilestone.value = true
        emit('milestone')
      }
    } else if (val < 80) {
      milestoneTriggered.value = false
      isMilestone.value = false
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.photon-reading-beam {
  --head-dir: 1;
  position: fixed;
  inset-block-start: var(--v-layout-top, 64px);
  inset-inline: 0;
  z-index: 1004;
  height: 3.5px;
  pointer-events: none;
  overflow: visible;
}

.photon-reading-beam.is-rtl,
:global(.is-rtl) .photon-reading-beam {
  --head-dir: -1;
}

.photon-laser-track {
  position: absolute;
  inset-block-start: 0;
  inset-block-end: 0;
  inset-inline-start: 0;
  height: 3.5px;
  background: linear-gradient(90deg, #06b6d4 0%, #3b82f6 50%, #8b5cf6 100%);
  background-size: 100vw 100%;
  box-shadow: 0 0 12px rgba(6, 182, 212, 0.7);
  transition: width 0.08s ease-out;
  border-radius: 0 2px 2px 0;
}

.photon-reading-beam.is-rtl .photon-laser-track,
:global(.is-rtl) .photon-reading-beam .photon-laser-track {
  background: linear-gradient(270deg, #06b6d4 0%, #3b82f6 50%, #8b5cf6 100%);
  border-radius: 2px 0 0 2px;
}

.laser-beam-head {
  position: absolute;
  top: 50%;
  inset-inline-end: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background-color: #ffffff;
  box-shadow: 0 0 8px #ffffff, 0 0 16px #06b6d4;
  pointer-events: none;
  animation: pulse-laser-head 1.2s infinite alternate ease-in-out;
  transform-origin: center;
}

@keyframes pulse-laser-head {
  0% {
    transform: translate(calc(50% * var(--head-dir)), -50%) scale(0.85);
    box-shadow: 0 0 6px #ffffff, 0 0 12px #06b6d4;
  }
  100% {
    transform: translate(calc(50% * var(--head-dir)), -50%) scale(1.3);
    box-shadow: 0 0 10px #ffffff, 0 0 20px #06b6d4, 0 0 30px rgba(6, 182, 212, 0.6);
  }
}

/* 100% Reading Milestone Dopamine Reward */
@keyframes reader-milestone-burst {
  0% {
    box-shadow: 0 0 12px rgba(6, 182, 212, 0.7);
    filter: brightness(1);
  }
  25% {
    box-shadow: 0 0 28px rgba(16, 185, 129, 0.9), 0 0 44px rgba(250, 204, 21, 0.7);
    filter: brightness(1.3);
  }
  50% {
    box-shadow: 0 0 36px rgba(16, 185, 129, 0.9), 0 0 54px rgba(250, 204, 21, 0.7);
    filter: brightness(1.25);
  }
  75% {
    box-shadow: 0 0 24px rgba(16, 185, 129, 0.9), 0 0 38px rgba(250, 204, 21, 0.7);
    filter: brightness(1.15);
  }
  100% {
    box-shadow: 0 0 18px rgba(16, 185, 129, 0.9), 0 0 28px rgba(250, 204, 21, 0.7);
    filter: brightness(1.1);
  }
}

.photon-reading-beam.is-milestone .photon-laser-track {
  background: linear-gradient(90deg, #10b981 0%, #3b82f6 50%, #facc15 100%);
  animation: reader-milestone-burst 1.6s cubic-bezier(0.16, 1, 0.3, 1) infinite alternate;
}

.photon-reading-beam.is-milestone.is-rtl .photon-laser-track,
:global(.is-rtl) .photon-reading-beam.is-milestone .photon-laser-track {
  background: linear-gradient(270deg, #10b981 0%, #3b82f6 50%, #facc15 100%);
}

.photon-reading-beam.is-milestone .laser-beam-head {
  background-color: #ffffff;
  box-shadow: 0 0 12px #ffffff, 0 0 22px rgba(250, 204, 21, 0.7), 0 0 32px rgba(16, 185, 129, 0.9);
}

@media (prefers-reduced-motion: reduce) {
  .photon-laser-track {
    transition: none;
  }
  .laser-beam-head {
    animation: none;
    transition: none;
  }
  .photon-reading-beam.is-milestone .photon-laser-track {
    animation: none;
  }
}

@media print {
  .photon-reading-beam {
    display: none;
  }
}
</style>
