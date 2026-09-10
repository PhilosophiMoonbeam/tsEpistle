<script setup lang="ts">
import { ref, useTemplateRef } from 'vue'

const { maxTilt = 8, scaleOnHover = 1.015 } = defineProps<{
  maxTilt?: number
  scaleOnHover?: number
}>()

const cardRef = useTemplateRef<HTMLElement>('cardRef')
const transformStyle = ref('')
const sheenStyle = ref('')

const handlePointerMove = (e: PointerEvent) => {
  const el = cardRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const px = (x / rect.width) * 100
  const py = (y / rect.height) * 100
  const rx = ((y / rect.height) - 0.5) * -maxTilt
  const ry = ((x / rect.width) - 0.5) * maxTilt

  el.style.setProperty('--mouse-x', `${px.toFixed(1)}%`)
  el.style.setProperty('--mouse-y', `${py.toFixed(1)}%`)

  transformStyle.value = `perspective(1000px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale3d(${scaleOnHover}, ${scaleOnHover}, 1)`
  sheenStyle.value = `radial-gradient(circle at ${px.toFixed(1)}% ${py.toFixed(1)}%, rgba(255, 255, 255, 0.16) 0%, transparent 60%)`
}

const handlePointerLeave = () => {
  const el = cardRef.value
  if (el) {
    el.style.setProperty('--mouse-x', '50%')
    el.style.setProperty('--mouse-y', '50%')
  }
  transformStyle.value = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)'
  sheenStyle.value = 'none'
}
</script>

<template>
  <div
    ref="cardRef"
    class="tactile-tilt-card"
    :style="{ transform: transformStyle }"
    @pointermove="handlePointerMove"
    @pointerleave="handlePointerLeave"
  >
    <div
      class="tactile-tilt-card__sheen"
      :style="{ background: sheenStyle }"
      aria-hidden="true"
    />
    <div class="tactile-tilt-card__content">
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
.tactile-tilt-card {
  --mouse-x: 50%;
  --mouse-y: 50%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.15s cubic-bezier(0.2, 0, 0.2, 1), box-shadow 0.25s ease;
  will-change: transform;
  border-radius: 12px;

  &:hover {
    box-shadow: 0 16px 36px -10px rgba(0, 0, 0, 0.22), 0 0 24px -4px rgba(6, 182, 212, 0.18);
  }

  &__sheen {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
    z-index: 3;
    transition: opacity 0.2s ease;
  }

  &__content {
    position: relative;
    z-index: 1;
    height: 100%;
    transform-style: preserve-3d;
  }
}
</style>
