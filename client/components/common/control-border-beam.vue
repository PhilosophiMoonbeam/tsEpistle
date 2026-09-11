<template>
  <svg
    v-if="props.enabled"
    class="control-border-beam"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
    tabindex="-1"
    role="presentation"
    :style="beamStyle"
  >
    <defs>
      <linearGradient :id="gradientId" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop class="control-border-beam__violet" offset="0%" stop-opacity="0" />
        <stop class="control-border-beam__violet" offset="22%" stop-opacity=".86" />
        <stop class="control-border-beam__violet" offset="56%" stop-opacity="1" />
        <stop class="control-border-beam__cool" offset="82%" stop-opacity=".72" />
        <stop class="control-border-beam__cool" offset="100%" stop-opacity="0" />
      </linearGradient>
    </defs>
    <g class="control-border-beam__trail">
      <rect
        class="control-border-beam__beam control-border-beam__beam--outer"
        x=".75"
        y=".75"
        width="calc(100% - 1.5px)"
        height="calc(100% - 1.5px)"
        pathLength="500"
        :stroke="`url(#${gradientId})`"
      />
      <rect
        class="control-border-beam__beam control-border-beam__beam--wide"
        x=".75"
        y=".75"
        width="calc(100% - 1.5px)"
        height="calc(100% - 1.5px)"
        pathLength="500"
        :stroke="`url(#${gradientId})`"
      />
      <rect
        class="control-border-beam__beam control-border-beam__beam--mid"
        x=".75"
        y=".75"
        width="calc(100% - 1.5px)"
        height="calc(100% - 1.5px)"
        pathLength="500"
        :stroke="`url(#${gradientId})`"
      />
      <rect
        class="control-border-beam__beam control-border-beam__beam--narrow"
        x=".75"
        y=".75"
        width="calc(100% - 1.5px)"
        height="calc(100% - 1.5px)"
        pathLength="500"
        :stroke="`url(#${gradientId})`"
      />
      <rect
        class="control-border-beam__beam control-border-beam__beam--core"
        x=".75"
        y=".75"
        width="calc(100% - 1.5px)"
        height="calc(100% - 1.5px)"
        pathLength="500"
        :stroke="`url(#${gradientId})`"
      />
    </g>
  </svg>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'

const props = withDefaults(defineProps<{
  enabled?: boolean
  phaseOffsetMs?: number
}>(), {
  enabled: true,
  phaseOffsetMs: 0
})

const gradientId = `control-border-beam-${useId().replaceAll(':', '-')}`
const beamStyle = computed<Record<string, string>>(() => {
  const offset = Number.isFinite(props.phaseOffsetMs) ? Math.max(0, props.phaseOffsetMs) : 0
  return { '--wiki-beam-phase-offset': `-${offset}ms` }
})
</script>

<style scoped>
@property --wiki-beam-dash-offset {
  syntax: '<number>';
  inherits: true;
  initial-value: -13;
}

.control-border-beam {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  inline-size: 100%;
  block-size: 100%;
  overflow: visible;
  border-radius: inherit;
  pointer-events: none;
}

.control-border-beam__violet {
  stop-color: var(--wiki-beam-violet, rgb(var(--v-theme-primary)));
}

.control-border-beam__cool {
  stop-color: var(--wiki-beam-cool, rgb(var(--v-theme-info)));
}

.control-border-beam__trail {
  --wiki-beam-dash-offset: -13;
  opacity: 0;
  animation: control-border-beam 6.6s var(--wiki-motion-ease, cubic-bezier(.22, .8, .22, 1)) infinite;
  animation-delay: var(--wiki-beam-phase-offset, 0ms);
}

.control-border-beam__beam {
  fill: none;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-dashoffset: calc(var(--wiki-beam-dash-offset) - var(--wiki-beam-trail-shift));
  rx: var(--wiki-control-radius, 12px);
  ry: var(--wiki-control-radius, 12px);
}

.control-border-beam__beam--outer {
  --wiki-beam-trail-shift: 0;
  stroke-dasharray: 44 456;
  stroke-opacity: .1;
}

.control-border-beam__beam--wide {
  --wiki-beam-trail-shift: 4;
  stroke-dasharray: 36 464;
  stroke-opacity: .14;
}

.control-border-beam__beam--mid {
  --wiki-beam-trail-shift: 8;
  stroke-dasharray: 28 472;
  stroke-opacity: .2;
}

.control-border-beam__beam--narrow {
  --wiki-beam-trail-shift: 12;
  stroke-dasharray: 20 480;
  stroke-opacity: .24;
}

.control-border-beam__beam--core {
  --wiki-beam-trail-shift: 16;
  stroke-dasharray: 12 488;
  stroke-opacity: .34;
}

@keyframes control-border-beam {
  0%,
  2% {
    opacity: 0;
    --wiki-beam-dash-offset: -13;
  }

  3% {
    opacity: .1;
    --wiki-beam-dash-offset: -17;
  }

  5% {
    opacity: .45;
    --wiki-beam-dash-offset: -46;
  }

  7.5% {
    opacity: .86;
    --wiki-beam-dash-offset: -87;
  }

  10% {
    opacity: 1;
    --wiki-beam-dash-offset: -130;
  }

  12.5% {
    opacity: .83;
    --wiki-beam-dash-offset: -176;
  }

  15% {
    opacity: .35;
    --wiki-beam-dash-offset: -211;
  }

  16.5%,
  17.5% {
    opacity: 0;
    --wiki-beam-dash-offset: -223;
  }

  18%,
  19.5% {
    opacity: 0;
    --wiki-beam-dash-offset: -137;
  }

  20% {
    opacity: 0;
    --wiki-beam-dash-offset: -137;
  }

  20.5% {
    opacity: .1;
    --wiki-beam-dash-offset: -139;
  }

  23% {
    opacity: .45;
    --wiki-beam-dash-offset: -168;
  }

  25.5% {
    opacity: .86;
    --wiki-beam-dash-offset: -209;
  }

  28% {
    opacity: 1;
    --wiki-beam-dash-offset: -252;
  }

  30.5% {
    opacity: .83;
    --wiki-beam-dash-offset: -297;
  }

  33% {
    opacity: .35;
    --wiki-beam-dash-offset: -333;
  }

  34.5%,
  35.5% {
    opacity: 0;
    --wiki-beam-dash-offset: -347;
  }

  36%,
  37.5% {
    opacity: 0;
    --wiki-beam-dash-offset: -302;
  }

  38% {
    opacity: 0;
    --wiki-beam-dash-offset: -302;
  }

  38.5% {
    opacity: .1;
    --wiki-beam-dash-offset: -306;
  }

  41% {
    opacity: .45;
    --wiki-beam-dash-offset: -335;
  }

  43.5% {
    opacity: .86;
    --wiki-beam-dash-offset: -376;
  }

  46% {
    opacity: 1;
    --wiki-beam-dash-offset: -419;
  }

  48.5% {
    opacity: .83;
    --wiki-beam-dash-offset: -465;
  }

  51% {
    opacity: .35;
    --wiki-beam-dash-offset: -500;
  }

  52.5%,
  53.5% {
    opacity: 0;
    --wiki-beam-dash-offset: -512;
  }

  54%,
  55% {
    opacity: 0;
    --wiki-beam-dash-offset: -421;
  }

  55.5% {
    opacity: .1;
    --wiki-beam-dash-offset: -425;
  }

  58% {
    opacity: .45;
    --wiki-beam-dash-offset: -454;
  }

  60.5% {
    opacity: .86;
    --wiki-beam-dash-offset: -495;
  }

  63% {
    opacity: 1;
    --wiki-beam-dash-offset: -538;
  }

  65.5% {
    opacity: .83;
    --wiki-beam-dash-offset: -584;
  }

  68% {
    opacity: .35;
    --wiki-beam-dash-offset: -619;
  }

  69.5%,
  100% {
    opacity: 0;
    --wiki-beam-dash-offset: -631;
  }
}

@media (prefers-reduced-motion: reduce), (forced-colors: active), print {
  .control-border-beam {
    display: none !important;
  }
}
</style>
