<template>
  <transition name="hud-fade">
    <aside
      v-if="visible"
      class="constellation-hud"
      :style="hudStyle"
      role="region"
      aria-label="Knowledge Node Telemetry Reticle"
    >
      <!-- Laser corner brackets -->
      <span class="laser-corner corner--tl" aria-hidden="true" />
      <span class="laser-corner corner--tr" aria-hidden="true" />
      <span class="laser-corner corner--bl" aria-hidden="true" />
      <span class="laser-corner corner--br" aria-hidden="true" />

      <!-- Scanline beam overlay -->
      <div class="hud-scanline" aria-hidden="true" />

      <!-- Reticle Header / Telemetry status -->
      <div class="hud-header">
        <div class="hud-status">
          <span class="hud-beacon" aria-hidden="true" />
          <span class="hud-system-label">TELEMETRY // NODE RETICLE</span>
        </div>
        <div v-if="locale" class="hud-locale-badge">
          LOCALE: {{ locale.toUpperCase() }}
        </div>
      </div>

      <!-- Node Identification -->
      <div class="hud-identity">
        <h3 class="hud-title" :title="title || 'Unnamed Node'">
          {{ title || 'Root Directory' }}
        </h3>
        <div class="hud-breadcrumb">
          <span class="hud-path-icon" aria-hidden="true">/</span>
          <code class="hud-path-text">{{ path || '/' }}</code>
        </div>
      </div>

      <!-- In / Out Degree Metrics -->
      <div class="hud-metrics">
        <div class="hud-metric-item hud-metric--incoming">
          <div class="hud-metric-label">
            <span class="hud-arrow" aria-hidden="true">↳</span>
            <span>INCOMING</span>
          </div>
          <div class="hud-metric-value">{{ incomingCount }}</div>
        </div>

        <div class="hud-metric-divider" aria-hidden="true" />

        <div class="hud-metric-item hud-metric--outgoing">
          <div class="hud-metric-label">
            <span class="hud-arrow" aria-hidden="true">↱</span>
            <span>OUTGOING</span>
          </div>
          <div class="hud-metric-value">{{ outgoingCount }}</div>
        </div>
      </div>

      <!-- Keyboard-driven Jump Link Action -->
      <div class="hud-action-footer">
        <router-link
          v-if="id !== undefined"
          :to="`/pages/${id}`"
          class="hud-jump-btn"
          tabindex="0"
          :aria-label="`Jump to ${title}`"
          @click="onJump"
          @keydown.enter="onJump"
        >
          <span class="hud-jump-glow" aria-hidden="true" />
          <span class="hud-jump-icon" aria-hidden="true">⚡</span>
          <span class="hud-jump-label">JUMP TO PAGE</span>
          <kbd class="hud-kbd-hint">↵ ENTER</kbd>
        </router-link>
        <div v-else class="hud-folder-badge">
          <span class="hud-folder-icon" aria-hidden="true">📁</span>
          <span>STRUCTURAL FOLDER</span>
        </div>
      </div>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const {
  title = '',
  path = '',
  id = undefined,
  locale = '',
  incomingCount = 0,
  outgoingCount = 0,
  visible = true,
  x = 0,
  y = 0
} = defineProps<{
  title?: string
  path?: string
  id?: number
  locale?: string
  incomingCount?: number
  outgoingCount?: number
  visible?: boolean
  x?: number
  y?: number
}>()

const emit = defineEmits<{
  (e: 'jump', id: number): void
}>()

const hudStyle = computed(() => {
  if (!x && !y) {
    return {
      top: '1.25rem',
      right: '1.25rem'
    }
  }
  const posX = x > 640 ? Math.max(12, x - 300) : x + 24
  const posY = Math.max(12, Math.min(y - 30, 800))
  return {
    left: `${posX}px`,
    top: `${posY}px`
  }
})

const onJump = () => {
  if (id !== undefined) {
    emit('jump', id)
  }
}
</script>

<style scoped lang="scss">
.constellation-hud {
  position: absolute;
  z-index: 20;
  width: 280px;
  max-width: calc(100% - 24px);
  padding: 14px 16px;
  border-radius: 8px;
  background: rgba(8, 14, 28, 0.88);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(6, 182, 212, 0.35);
  box-shadow:
    0 16px 36px rgba(0, 0, 0, 0.6),
    0 0 20px rgba(6, 182, 212, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  color: #f1f5f9;
  font-family: var(--font-family-sans, system-ui, -apple-system, sans-serif);
  pointer-events: auto;
  user-select: none;
  overflow: hidden;
  transition: opacity 0.18s ease, transform 0.18s ease;

  .laser-corner {
    position: absolute;
    width: 8px;
    height: 8px;
    border-color: #06b6d4;
    filter: drop-shadow(0 0 3px #06b6d4);

    &.corner--tl {
      top: -1px;
      left: -1px;
      border-top: 2px solid #06b6d4;
      border-left: 2px solid #06b6d4;
    }
    &.corner--tr {
      top: -1px;
      right: -1px;
      border-top: 2px solid #06b6d4;
      border-right: 2px solid #06b6d4;
    }
    &.corner--bl {
      bottom: -1px;
      left: -1px;
      border-bottom: 2px solid #06b6d4;
      border-left: 2px solid #06b6d4;
    }
    &.corner--br {
      bottom: -1px;
      right: -1px;
      border-bottom: 2px solid #06b6d4;
      border-right: 2px solid #06b6d4;
    }
  }

  .hud-scanline {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      180deg,
      transparent 0%,
      rgba(6, 182, 212, 0.05) 50%,
      transparent 100%
    );
    background-size: 100% 8px;
    opacity: 0.6;
  }

  .hud-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.15);
  }

  .hud-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .hud-beacon {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 8px #10b981;
    animation: beacon-pulse 1.8s infinite ease-in-out;
  }

  .hud-system-label {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: #38bdf8;
    text-transform: uppercase;
  }

  .hud-locale-badge {
    font-size: 0.62rem;
    font-family: var(--font-family-monospace, monospace);
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(56, 189, 248, 0.15);
    color: #7dd3fc;
    border: 1px solid rgba(56, 189, 248, 0.3);
  }

  .hud-identity {
    margin-bottom: 12px;
  }

  .hud-title {
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1.3;
    margin: 0 0 4px;
    color: #ffffff;
    text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hud-breadcrumb {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72rem;
    color: #94a3b8;

    .hud-path-icon {
      color: #06b6d4;
      font-weight: 700;
    }

    .hud-path-text {
      font-family: var(--font-family-monospace, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #cbd5e1;
    }
  }

  .hud-metrics {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.65);
    border: 1px solid rgba(148, 163, 184, 0.12);
    margin-bottom: 12px;
  }

  .hud-metric-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hud-metric-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .hud-metric-value {
    font-size: 1.15rem;
    font-weight: 700;
    font-family: var(--font-family-monospace, monospace);
    line-height: 1.1;
  }

  .hud-metric--incoming {
    .hud-metric-label { color: #06b6d4; }
    .hud-metric-value {
      color: #22d3ee;
      text-shadow: 0 0 8px rgba(6, 182, 212, 0.5);
    }
  }

  .hud-metric--outgoing {
    .hud-metric-label { color: #c084fc; }
    .hud-metric-value {
      color: #e879f9;
      text-shadow: 0 0 8px rgba(192, 132, 252, 0.5);
    }
  }

  .hud-metric-divider {
    width: 1px;
    height: 24px;
    background: rgba(148, 163, 184, 0.2);
  }

  .hud-action-footer {
    display: flex;
    align-items: center;
  }

  .hud-jump-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 7px 12px;
    border-radius: 6px;
    background: linear-gradient(135deg, rgba(6, 182, 212, 0.25) 0%, rgba(147, 51, 234, 0.25) 100%);
    border: 1px solid rgba(6, 182, 212, 0.5);
    color: #ffffff;
    text-decoration: none;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    cursor: pointer;
    overflow: hidden;
    transition: all 0.2s ease;

    &:hover,
    &:focus-visible {
      background: linear-gradient(135deg, rgba(6, 182, 212, 0.45) 0%, rgba(147, 51, 234, 0.45) 100%);
      border-color: #38bdf8;
      box-shadow: 0 0 14px rgba(6, 182, 212, 0.4);
      outline: none;
      transform: translateY(-1px);
    }

    .hud-jump-icon {
      color: #facc15;
      font-size: 0.85rem;
    }

    .hud-jump-label {
      flex: 1;
      margin-left: 6px;
    }

    .hud-kbd-hint {
      font-size: 0.62rem;
      font-family: var(--font-family-monospace, monospace);
      padding: 2px 4px;
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #94a3b8;
    }
  }

  .hud-folder-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border-radius: 6px;
    background: rgba(148, 163, 184, 0.1);
    border: 1px dashed rgba(148, 163, 184, 0.25);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: #94a3b8;
  }
}

@keyframes beacon-pulse {
  0% { transform: scale(0.9); opacity: 0.7; }
  50% { transform: scale(1.2); opacity: 1; box-shadow: 0 0 10px #10b981; }
  100% { transform: scale(0.9); opacity: 0.7; }
}

.hud-fade-enter-active,
.hud-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.hud-fade-enter-from,
.hud-fade-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(4px);
}
</style>
