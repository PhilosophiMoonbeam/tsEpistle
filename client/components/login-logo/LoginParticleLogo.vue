<template lang="pug">
  .login-particle-logo(
    v-if="showField"
    aria-hidden="true"
    :style="fieldStyle"
  )
    .login-particle-logo__stage
      component.login-particle-logo__scene(
        ref="sceneInstance"
        v-if="sceneMount"
        :is="sceneMount.component"
        :key="sceneMount.epoch"
        :effect="sceneMount.effect"
        :particles="sceneMount.particles"
        :active="sceneActive"
        :style="sceneStyle"
        @first-frame="sceneMount.onFirstFrame"
        @error="sceneMount.onError"
        @context-lost="sceneMount.onContextLost"
      )
      img.login-particle-logo__image(
        ref="staticImageElement"
        :key="staticUrl"
        :src="staticUrl"
        :style="imageStyle"
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable="false"
        @error="handleImageError"
        @load="handleImageLoad"
      )
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  getCurrentInstance,
  onBeforeUnmount,
  onErrorCaptured,
  onMounted,
  type Component,
  type PropType,
  ref,
  shallowRef,
  watch
} from 'vue'
import {
  isLogoEffectDescriptor,
  parseParticleV1,
  type LogoEffectDescriptor,
  type ParsedLogoParticles
} from './particle-logo'
import './login-particle-logo.scss'

interface FieldLayout {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly imageWidth: number
  readonly imageHeight: number
}

interface SceneMount {
  readonly component: Component
  readonly effect: LogoEffectDescriptor
  readonly particles: ParsedLogoParticles
  readonly epoch: number
  readonly onFirstFrame: () => void
  readonly onError: () => void
  readonly onContextLost: () => void
}

interface ParticleSceneInstance {
  readonly teardown: () => void
}

type IdleWindow = Omit<Window, 'requestIdleCallback' | 'cancelIdleCallback'> & {
  readonly requestIdleCallback?: Window['requestIdleCallback']
  readonly cancelIdleCallback?: Window['cancelIdleCallback']
}

const DESKTOP_MEDIA = '(min-width: 960px) and (min-height: 651px) and (hover: hover) and (pointer: fine)'
const FIELD_GUTTER_PX = 24
const FIELD_CLEARANCE = 0.08
const MIN_RENDERED_LONG_AXIS_PX = 256
const MIN_RENDERED_SHORT_AXIS_PX = 48
const ENHANCEMENT_DEADLINE_MS = 1_500
const IDLE_TIMEOUT_MS = 750

const toPixels = (value: number): string => `${Math.round(value * 1000) / 1000}px`

const auraValue = (effect: LogoEffectDescriptor): string => {
  if (!effect.auraColor) return 'transparent'
  const red = Number.parseInt(effect.auraColor.slice(1, 3), 16)
  const green = Number.parseInt(effect.auraColor.slice(3, 5), 16)
  const blue = Number.parseInt(effect.auraColor.slice(5, 7), 16)
  return `rgb(${red} ${green} ${blue} / 8%)`
}

export default defineComponent({
  name: 'LoginParticleLogo',
  props: {
    effect: {
      type: [Object, null] as PropType<LogoEffectDescriptor | null>,
      required: true,
      validator: (value: unknown) => value === null || isLogoEffectDescriptor(value)
    }
  },
  setup (props) {
    const instance = getCurrentInstance()
    const mediaEligible = ref(false)
    const surfaceVisible = ref(false)
    const pageVisible = ref(false)
    const reducedMotion = ref(true)
    const observersReady = ref(false)
    const layout = shallowRef<FieldLayout | null>(null)
    const failedStaticUrl = ref<string | null>(null)
    const loadedStaticUrl = ref<string | null>(null)
    const sceneMount = shallowRef<SceneMount | null>(null)
    const sceneReady = ref(false)
    const sceneInstance = shallowRef<ParticleSceneInstance | null>(null)
    const staticImageElement = shallowRef<HTMLImageElement | null>(null)
    const activeEffect = computed(() => isLogoEffectDescriptor(props.effect) ? props.effect : null)
    const animationSizeEligible = computed(() => {
      const currentLayout = layout.value
      return (
        currentLayout !== null &&
        Math.max(currentLayout.imageWidth, currentLayout.imageHeight) >= MIN_RENDERED_LONG_AXIS_PX &&
        Math.min(currentLayout.imageWidth, currentLayout.imageHeight) >= MIN_RENDERED_SHORT_AXIS_PX
      )
    })
    const hardEligible = computed(() => {
      const effect = activeEffect.value
      return (
        effect !== null &&
        animationSizeEligible.value &&
        mediaEligible.value &&
        !reducedMotion.value &&
        loadedStaticUrl.value === effect.staticUrl &&
        failedStaticUrl.value !== effect.staticUrl
      )
    })
    const activityEligible = computed(() => surfaceVisible.value && pageVisible.value)
    const sceneActive = computed(() =>
      sceneMount.value !== null &&
      hardEligible.value &&
      activityEligible.value
    )

    let loginElement: HTMLElement | null = null
    let cardElement: HTMLElement | null = null
    let desktopQuery: MediaQueryList | null = null
    let motionQuery: MediaQueryList | null = null
    let resizeObserver: ResizeObserver | null = null
    let intersectionObserver: IntersectionObserver | null = null
    let cancelIdleWork: (() => void) | null = null
    let fetchController: AbortController | null = null
    let deadlineTimer: number | null = null
    let enhancementEpoch = 0
    let reducedMotionLatched = false
    let previousAura = ''
    let previousAuraPriority = ''

    const applyAura = (): void => {
      if (!loginElement) return
      if (activeEffect.value) {
        loginElement.style.setProperty('--login-logo-aura', auraValue(activeEffect.value))
      } else if (previousAura) {
        loginElement.style.setProperty('--login-logo-aura', previousAura, previousAuraPriority)
      } else {
        loginElement.style.removeProperty('--login-logo-aura')
      }
    }

    const clearLayout = (): void => {
      layout.value = null
    }

    const measure = (): void => {
      const effect = activeEffect.value
      if (
        !effect ||
        !loginElement ||
        !cardElement ||
        !observersReady.value ||
        !mediaEligible.value
      ) {
        clearLayout()
        return
      }

      const loginRect = loginElement.getBoundingClientRect()
      const cardRect = cardElement.getBoundingClientRect()
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight
      const loginStyle = window.getComputedStyle(loginElement)
      const paddingTop = Number.parseFloat(loginStyle.paddingTop) || 0
      const paddingRight = Number.parseFloat(loginStyle.paddingRight) || 0
      const paddingBottom = Number.parseFloat(loginStyle.paddingBottom) || 0
      const fieldLeft = cardRect.right + FIELD_GUTTER_PX
      const fieldRight = Math.min(loginRect.right, viewportWidth) - paddingRight
      const fieldTop = Math.max(loginRect.top, 0) + paddingTop
      const fieldBottom = Math.min(loginRect.bottom, viewportHeight) - paddingBottom
      const fieldWidth = fieldRight - fieldLeft
      const fieldHeight = fieldBottom - fieldTop

      if (![fieldLeft, fieldRight, fieldTop, fieldBottom, fieldWidth, fieldHeight].every(Number.isFinite) || fieldWidth <= 0 || fieldHeight <= 0) {
        clearLayout()
        return
      }

      const availableWidth = fieldWidth * (1 - 2 * FIELD_CLEARANCE)
      const availableHeight = fieldHeight * (1 - 2 * FIELD_CLEARANCE)
      const scale = Math.min(availableWidth / effect.width, availableHeight / effect.height)
      const imageWidth = effect.width * scale
      const imageHeight = effect.height * scale

      if (!Number.isFinite(scale) || scale <= 0) {
        clearLayout()
        return
      }

      layout.value = {
        left: fieldLeft - loginRect.left,
        top: fieldTop - loginRect.top,
        width: fieldWidth,
        height: fieldHeight,
        imageWidth,
        imageHeight
      }
    }

    const clearDeadline = (): void => {
      if (deadlineTimer === null) return
      window.clearTimeout(deadlineTimer)
      deadlineTimer = null
    }

    const invalidateEnhancement = (): number => {
      enhancementEpoch += 1
      cancelIdleWork?.()
      cancelIdleWork = null
      fetchController?.abort()
      fetchController = null
      clearDeadline()
      sceneMount.value = null
      sceneReady.value = false
      return enhancementEpoch
    }

    const isCurrentEpoch = (epoch: number, effect: LogoEffectDescriptor): boolean =>
      epoch === enhancementEpoch && activeEffect.value === effect

    const isCurrentLoad = (epoch: number, effect: LogoEffectDescriptor): boolean =>
      isCurrentEpoch(epoch, effect) && hardEligible.value && activityEligible.value

    const failEnhancement = (epoch: number): void => {
      if (epoch !== enhancementEpoch) return
      invalidateEnhancement()
    }

    const loadEnhancement = async (epoch: number, effect: LogoEffectDescriptor): Promise<void> => {
      try {
        const sceneModule = await import('./LogoParticleScene.vue')
        if (!isCurrentLoad(epoch, effect)) return

        const particleUrl = new URL(effect.particleUrl, window.location.href)
        if (particleUrl.origin !== window.location.origin) throw new Error('Particle rendition must be same-origin')

        const controller = new AbortController()
        fetchController = controller
        const response = await fetch(effect.particleUrl, {
          credentials: 'omit',
          signal: controller.signal
        })
        if (!isCurrentLoad(epoch, effect)) return
        if (!response.ok) throw new Error(`Particle rendition request failed with ${response.status}`)

        const bytes = await response.arrayBuffer()
        if (!isCurrentLoad(epoch, effect)) return
        const particles = parseParticleV1(bytes, effect)
        if (!isCurrentLoad(epoch, effect)) return

        fetchController = null
        sceneMount.value = {
          component: sceneModule.default,
          effect,
          particles,
          epoch,
          onFirstFrame: () => {
            if (!isCurrentLoad(epoch, effect) || sceneMount.value?.epoch !== epoch) return
            clearDeadline()
            sceneReady.value = true
          },
          onError: () => failEnhancement(epoch),
          onContextLost: () => failEnhancement(epoch)
        }
      } catch {
        failEnhancement(epoch)
      }
    }

    const scheduleEnhancement = (): void => {
      const effect = activeEffect.value
      if (!effect || !hardEligible.value || !activityEligible.value) return
      const epoch = invalidateEnhancement()

      deadlineTimer = window.setTimeout(() => failEnhancement(epoch), ENHANCEMENT_DEADLINE_MS)
      const beginLoad = (): void => {
        cancelIdleWork = null
        if (!isCurrentLoad(epoch, effect)) return
        void loadEnhancement(epoch, effect)
      }
      const idleWindow = window as IdleWindow
      if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
        const handle = idleWindow.requestIdleCallback(beginLoad, { timeout: IDLE_TIMEOUT_MS })
        cancelIdleWork = () => idleWindow.cancelIdleCallback?.(handle)
      } else {
        const handle = window.setTimeout(beginLoad, 0)
        cancelIdleWork = () => window.clearTimeout(handle)
      }
    }

    const hasEnhancementWork = (): boolean =>
      cancelIdleWork !== null ||
      fetchController !== null ||
      deadlineTimer !== null ||
      sceneMount.value !== null

    const reconcileEnhancement = (): void => {
      if (!hardEligible.value) {
        if (hasEnhancementWork()) invalidateEnhancement()
        return
      }
      if (!activityEligible.value) {
        if (!sceneReady.value && hasEnhancementWork()) invalidateEnhancement()
        return
      }
      if (!hasEnhancementWork()) scheduleEnhancement()
    }

    const updateMediaEligibility = (): void => {
      mediaEligible.value = desktopQuery?.matches === true
      measure()
    }

    const updateMotionPreference = (): void => {
      if (reducedMotionLatched || motionQuery?.matches !== true) return
      reducedMotionLatched = true
      sceneReady.value = false
      if (staticImageElement.value) staticImageElement.value.style.opacity = '1'
      sceneInstance.value?.teardown()
      reducedMotion.value = true
      instance?.update()
    }

    const updatePageVisibility = (): void => {
      pageVisible.value = document.visibilityState !== 'hidden'
    }

    const handleImageError = (event: Event): void => {
      const effect = activeEffect.value
      const image = event.currentTarget
      if (!(image instanceof HTMLImageElement) || !effect || image.getAttribute('src') !== effect.staticUrl) return
      loadedStaticUrl.value = null
      failedStaticUrl.value = effect.staticUrl
      invalidateEnhancement()
    }

    const handleImageLoad = (event: Event): void => {
      const effect = activeEffect.value
      const image = event.currentTarget
      if (!(image instanceof HTMLImageElement) || !effect || image.getAttribute('src') !== effect.staticUrl) return
      if (image.naturalWidth !== effect.width || image.naturalHeight !== effect.height) {
        loadedStaticUrl.value = null
        failedStaticUrl.value = effect.staticUrl
        invalidateEnhancement()
        return
      }
      failedStaticUrl.value = null
      loadedStaticUrl.value = effect.staticUrl
    }

    watch(activeEffect, () => {
      loadedStaticUrl.value = null
      failedStaticUrl.value = null
      invalidateEnhancement()
      applyAura()
      measure()
    }, { flush: 'sync' })
    watch(hardEligible, reconcileEnhancement, { flush: 'sync' })
    watch(activityEligible, reconcileEnhancement, { flush: 'sync' })
    watch(() => activeEffect.value?.auraColor, applyAura)

    onErrorCaptured(() => {
      const epoch = sceneMount.value?.epoch
      if (epoch === undefined) return
      failEnhancement(epoch)
      return false
    })

    onMounted(() => {
      const marker = instance?.proxy?.$el as Node | undefined
      const parent = marker?.parentElement
      const directCard = parent
        ? Array.from(parent.children).find(element => element.matches('main.login-sd'))
        : undefined
      if (!(parent instanceof HTMLElement) || !parent.classList.contains('login') || !(directCard instanceof HTMLElement)) return

      loginElement = parent
      cardElement = directCard
      previousAura = loginElement.style.getPropertyValue('--login-logo-aura')
      previousAuraPriority = loginElement.style.getPropertyPriority('--login-logo-aura')
      applyAura()

      if (
        typeof window.matchMedia !== 'function' ||
        typeof ResizeObserver === 'undefined' ||
        typeof IntersectionObserver === 'undefined'
      ) return

      desktopQuery = window.matchMedia(DESKTOP_MEDIA)
      motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
      mediaEligible.value = desktopQuery.matches
      reducedMotionLatched = motionQuery.matches
      reducedMotion.value = reducedMotionLatched
      pageVisible.value = document.visibilityState !== 'hidden'
      desktopQuery.addEventListener('change', updateMediaEligibility)
      motionQuery.addEventListener('change', updateMotionPreference)
      document.addEventListener('visibilitychange', updatePageVisibility)
      resizeObserver = new ResizeObserver(measure)
      resizeObserver.observe(loginElement)
      resizeObserver.observe(cardElement)
      resizeObserver.observe(document.documentElement)

      intersectionObserver = new IntersectionObserver(entries => {
        const entry = entries.find(candidate => candidate.target === loginElement)
        if (!entry) return
        surfaceVisible.value = entry.isIntersecting && entry.intersectionRatio > 0
        measure()
      }, { threshold: 0 })
      intersectionObserver.observe(loginElement)
      observersReady.value = true
      measure()
    })

    onBeforeUnmount(() => {
      invalidateEnhancement()
      desktopQuery?.removeEventListener('change', updateMediaEligibility)
      motionQuery?.removeEventListener('change', updateMotionPreference)
      document.removeEventListener('visibilitychange', updatePageVisibility)
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      if (loginElement) {
        if (previousAura) {
          loginElement.style.setProperty('--login-logo-aura', previousAura, previousAuraPriority)
        } else {
          loginElement.style.removeProperty('--login-logo-aura')
        }
      }
      loginElement = null
      cardElement = null
      desktopQuery = null
      motionQuery = null
      resizeObserver = null
      intersectionObserver = null
      clearLayout()
    })

    const showField = computed(() =>
      layout.value !== null &&
      activeEffect.value !== null &&
      failedStaticUrl.value !== activeEffect.value.staticUrl
    )
    const staticUrl = computed(() => activeEffect.value?.staticUrl ?? '')
    const fieldStyle = computed((): Record<string, string> => {
      if (!layout.value || !activeEffect.value) return {}
      return {
        left: toPixels(layout.value.left),
        top: toPixels(layout.value.top),
        width: toPixels(layout.value.width),
        height: toPixels(layout.value.height),
        '--login-logo-aura': auraValue(activeEffect.value)
      }
    })
    const imageStyle = computed((): Record<string, string> => {
      if (!layout.value) return {}
      return {
        width: toPixels(layout.value.imageWidth),
        height: toPixels(layout.value.imageHeight),
        position: 'relative',
        zIndex: '1',
        opacity: sceneReady.value ? '0' : '1',
        transition: 'opacity 180ms ease-out'
      }
    })
    const sceneStyle: Record<string, string> = {
      position: 'absolute',
      zIndex: '0',
      inset: '0',
      width: '100%',
      height: '100%'
    }

    return {
      activeEffect,
      fieldStyle,
      handleImageError,
      handleImageLoad,
      imageStyle,
      sceneActive,
      sceneInstance,
      sceneMount,
      sceneStyle,
      showField,
      staticImageElement,
      staticUrl
    }
  }
})
</script>
