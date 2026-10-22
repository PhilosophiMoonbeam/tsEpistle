<template lang="pug">
  v-dialog(
    :model-value='open'
    max-width='520'
    :transition='reduceMotion || deviceReducedMotion ? false : `dialog-transition`'
    aria-labelledby='avatar-crop-title'
    aria-describedby='avatar-crop-instructions'
    @update:model-value='onModel'
  )
    v-card.avatar-crop
      v-card-title#avatar-crop-title {{ $t('profile:avatar.crop.title', { defaultValue: 'Crop your avatar' }) }}
      v-card-text
        p#avatar-crop-instructions.avatar-crop__instructions {{ $t('profile:avatar.crop.instructions', { defaultValue: 'Drag to position, pinch or scroll to zoom. With the preview focused, use Arrow keys to move, Shift + Arrow to move farther, and + or − to zoom.' }) }}
        .avatar-crop__stage(
          ref='stage'
          role='group'
          tabindex='0'
          :aria-label='$t(`profile:avatar.crop.preview`, { defaultValue: `Avatar crop preview` })'
          aria-describedby='avatar-crop-instructions'
          :aria-busy='!ready || encoding'
          @keydown='onKey'
          @wheel.prevent='onWheel'
          @pointerdown='onPointerDown'
          @pointermove='onPointerMove'
          @pointerup='onPointerEnd'
          @pointercancel='onPointerEnd'
          @lostpointercapture='onPointerEnd'
        )
          img.avatar-crop__image(v-if='ready', :src='imageUrl', :style='imageStyle', alt='', draggable='false')
          .avatar-crop__circle(v-if='ready', aria-hidden='true')
          p.avatar-crop__loading(v-if='!ready && !error', role='status') {{ $t('profile:avatar.crop.loading', { defaultValue: 'Preparing image…' }) }}
        .avatar-crop__zoom
          v-btn.avatar-crop__zoom-out(
            icon='mdi-minus'
            variant='text'
            :disabled='!ready || encoding || zoom <= 1'
            :aria-label='$t(`profile:avatar.crop.zoomOut`, { defaultValue: `Zoom out` })'
            @click='setZoom(zoom - 0.1)'
          )
          v-slider(
            :model-value='zoom'
            :min='1'
            :max='5'
            :step='0.01'
            :disabled='!ready || encoding'
            :label='$t(`profile:avatar.crop.zoom`, { defaultValue: `Zoom` })'
            hide-details
            @update:model-value='setZoom'
          )
          v-btn.avatar-crop__zoom-in(
            icon='mdi-plus'
            variant='text'
            :disabled='!ready || encoding || zoom >= 5'
            :aria-label='$t(`profile:avatar.crop.zoomIn`, { defaultValue: `Zoom in` })'
            @click='setZoom(zoom + 0.1)'
          )
        v-alert(v-if='error', type='error', variant='tonal', density='compact', role='alert') {{ error }}
      v-card-actions
        v-spacer
        v-btn.avatar-crop__cancel(variant='text', @click='cancel') {{ $t('profile:avatar.crop.cancel', { defaultValue: 'Cancel' }) }}
        v-btn.avatar-crop__apply(color='primary', variant='flat', :disabled='!ready', :loading='encoding', @click='apply') {{ $t('profile:avatar.crop.apply', { defaultValue: 'Apply avatar' }) }}
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue'

type Point = { x: number; y: number }
const MAX_BYTES = 1024 * 1024
const MAX_DIMENSION = 4096

// Only inspect the container header before decoding. Submitted pixels still go
// through the server's authoritative static-raster validation/normalization.
function sourceDimensions(bytes: Uint8Array, mime: string): Point | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size))
  if (mime === 'image/png' && bytes.length >= 24 && text(0, 8) === '\x89PNG\r\n\x1a\n' && text(12, 4) === 'IHDR') {
    return { x: view.getUint32(16), y: view.getUint32(20) }
  }
  if (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return null
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]!
      if (marker === 0xd9 || marker === 0xda) return null
      const length = offset + 2 <= bytes.length ? view.getUint16(offset) : 0
      if (length < 2 || offset + length > bytes.length) return null
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return { x: view.getUint16(offset + 5), y: view.getUint16(offset + 3) }
      }
      offset += length
    }
  }
  if (mime === 'image/webp' && bytes.length >= 25 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const chunk = text(12, 4)
    const uint24 = (offset: number) => bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16)
    if (chunk === 'VP8X' && bytes.length >= 30) return { x: uint24(24) + 1, y: uint24(27) + 1 }
    if (chunk === 'VP8 ' && bytes.length >= 30 && text(23, 3) === '\x9d\x01\x2a') return { x: view.getUint16(26, true) & 0x3fff, y: view.getUint16(28, true) & 0x3fff }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      return { x: (bits & 0x3fff) + 1, y: ((bits >>> 14) & 0x3fff) + 1 }
    }
  }
  return null
}

export default defineComponent({
  props: {
    file: { type: File, required: true },
    selectionId: { type: Number, required: true },
    reduceMotion: { type: Boolean, default: false }
  },
  emits: ['apply', 'cancel'],
  data () {
    return {
      open: true,
      ready: false,
      encoding: false,
      error: '',
      imageUrl: '',
      image: null as HTMLImageElement | null,
      size: 0,
      width: 0,
      height: 0,
      zoom: 1,
      x: 0,
      y: 0,
      pointers: markRaw(new Map<number, Point>()),
      observer: null as ResizeObserver | null,
      motionQuery: null as MediaQueryList | null,
      deviceReducedMotion: true,
      generation: 0
    }
  },
  computed: {
    scale (): number {
      return this.width && this.height ? this.size / Math.min(this.width, this.height) * this.zoom : 1
    },
    imageStyle (): Record<string, string> {
      return {
        width: `${this.width * this.scale}px`,
        height: `${this.height * this.scale}px`,
        transform: `translate(calc(-50% + ${this.x}px), calc(-50% + ${this.y}px))`
      }
    }
  },
  mounted () {
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.deviceReducedMotion = this.motionQuery.matches
    this.motionQuery.addEventListener('change', this.onMotionChange)
    void this.prepare()
    this.$nextTick(() => {
      if (!this.open) return
      const stage = this.$refs.stage as HTMLElement | undefined
      if (!stage) return
      this.observer = markRaw(new ResizeObserver(() => {
        const previous = this.size
        this.size = stage.getBoundingClientRect().width
        if (previous) {
          this.x *= this.size / previous
          this.y *= this.size / previous
        }
        this.clamp()
      }))
      this.observer.observe(stage)
      this.size = stage.getBoundingClientRect().width
      stage.focus({ preventScroll: true })
    })
  },
  beforeUnmount () {
    this.open = false
    this.cleanup()
  },
  methods: {
    onMotionChange (event: MediaQueryListEvent) {
      this.deviceReducedMotion = event.matches
    },
    current (generation: number): boolean {
      return this.open && this.generation === generation
    },
    async prepare () {
      const generation = ++this.generation
      try {
        if (!this.file.size || this.file.size > MAX_BYTES) {
          throw new Error(this.$t('profile:avatar.crop.sourceSize', { defaultValue: 'Choose an image up to 1 MB.' }))
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(this.file.type)) throw new Error()
        const bytes = new Uint8Array(await this.file.arrayBuffer())
        if (!this.current(generation)) return
        const dimensions = sourceDimensions(bytes, this.file.type)
        if (!dimensions || dimensions.x < 1 || dimensions.y < 1) throw new Error()
        if (dimensions.x > MAX_DIMENSION || dimensions.y > MAX_DIMENSION) {
          throw new Error(this.$t('profile:avatar.crop.dimensions', { defaultValue: 'Choose an image no larger than 4096 × 4096 pixels.' }))
        }
        const url = URL.createObjectURL(this.file)
        this.imageUrl = url
        const image = new Image()
        this.image = markRaw(image)
        image.src = url
        await image.decode()
        if (!this.current(generation)) return
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > MAX_DIMENSION || image.naturalHeight > MAX_DIMENSION) throw new Error()
        this.width = image.naturalWidth
        this.height = image.naturalHeight
        this.ready = true
        this.clamp()
      } catch (error) {
        if (!this.current(generation)) return
        this.error = error instanceof Error && error.message ? error.message : this.$t('profile:avatar.crop.decodeError', { defaultValue: 'This image could not be opened. Choose a valid PNG, JPEG, or WebP image.' })
        this.releaseImage()
      }
    },
    releaseImage () {
      this.ready = false
      if (this.image) this.image.src = ''
      this.image = null
      if (this.imageUrl) URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = ''
    },
    releasePointers () {
      const stage = this.$refs.stage as HTMLElement | undefined
      const ids = [...this.pointers.keys()]
      this.pointers.clear()
      for (const id of ids) {
        if (stage?.hasPointerCapture(id)) stage.releasePointerCapture(id)
      }
    },
    cleanup () {
      this.generation++
      this.releasePointers()
      this.observer?.disconnect()
      this.observer = null
      this.motionQuery?.removeEventListener('change', this.onMotionChange)
      this.motionQuery = null
      this.releaseImage()
    },
    cancel () {
      if (!this.open) return
      this.open = false
      this.cleanup()
      this.$emit('cancel', this.selectionId)
    },
    onModel (open: boolean) {
      if (!open) this.cancel()
    },
    clamp () {
      const maxX = Math.max(0, (this.width * this.scale - this.size) / 2)
      const maxY = Math.max(0, (this.height * this.scale - this.size) / 2)
      this.x = Math.max(-maxX, Math.min(maxX, this.x))
      this.y = Math.max(-maxY, Math.min(maxY, this.y))
    },
    setZoom (value: number) {
      if (!this.ready || this.encoding || !Number.isFinite(value)) return
      const previous = this.zoom
      this.zoom = Math.max(1, Math.min(5, value))
      this.x *= this.zoom / previous
      this.y *= this.zoom / previous
      this.clamp()
    },
    onWheel (event: WheelEvent) {
      this.setZoom(this.zoom * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.002))
    },
    onKey (event: KeyboardEvent) {
      if (!this.ready || this.encoding || event.altKey || event.ctrlKey || event.metaKey) return
      const step = event.shiftKey ? 20 : 4
      switch (event.key) {
        case 'ArrowLeft': this.x -= step; break
        case 'ArrowRight': this.x += step; break
        case 'ArrowUp': this.y -= step; break
        case 'ArrowDown': this.y += step; break
        case '+': case '=': this.setZoom(this.zoom + 0.1); break
        case '-': case '_': this.setZoom(this.zoom - 0.1); break
        default: return
      }
      event.preventDefault()
      this.clamp()
    },
    onPointerDown (event: PointerEvent) {
      if (!this.ready || this.encoding || event.button !== 0 || this.pointers.size >= 2) return
      const stage = event.currentTarget as HTMLElement
      stage.focus({ preventScroll: true })
      stage.setPointerCapture(event.pointerId)
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      event.preventDefault()
    },
    onPointerMove (event: PointerEvent) {
      if (!this.pointers.has(event.pointerId) || !this.ready || this.encoding) return
      const before = [...this.pointers.values()]
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const after = [...this.pointers.values()]
      if (before.length === 1) {
        this.x += after[0]!.x - before[0]!.x
        this.y += after[0]!.y - before[0]!.y
      } else {
        const center = (points: Point[]) => ({ x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 })
        const distance = (points: Point[]) => Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y)
        const oldCenter = center(before)
        const newCenter = center(after)
        const oldDistance = distance(before)
        const oldZoom = this.zoom
        const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
        if (oldDistance > 0) this.zoom = Math.max(1, Math.min(5, this.zoom * distance(after) / oldDistance))
        const ratio = this.zoom / oldZoom
        this.x = (this.x - (oldCenter.x - bounds.left - bounds.width / 2)) * ratio + newCenter.x - bounds.left - bounds.width / 2
        this.y = (this.y - (oldCenter.y - bounds.top - bounds.height / 2)) * ratio + newCenter.y - bounds.top - bounds.height / 2
      }
      this.clamp()
      event.preventDefault()
    },
    onPointerEnd (event: PointerEvent) {
      this.pointers.delete(event.pointerId)
      const stage = this.$refs.stage as HTMLElement | undefined
      if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
    },
    async apply () {
      if (!this.ready || !this.image || this.encoding || !this.size) return
      const generation = this.generation
      this.encoding = true
      this.error = ''
      this.releasePointers()
      try {
        const cropSide = this.size / this.scale
        const side = Math.max(1, Math.min(512, Math.floor(cropSide)))
        const canvas = document.createElement('canvas')
        canvas.width = side
        canvas.height = side
        const context = canvas.getContext('2d')
        if (!context) throw new Error()
        context.fillStyle = '#fff'
        context.fillRect(0, 0, side, side)
        const left = (this.width - cropSide) / 2 - this.x / this.scale
        const top = (this.height - cropSide) / 2 - this.y / this.scale
        context.drawImage(this.image, left, top, cropSide, cropSide, 0, 0, side, side)
        const encode = (mime: string, quality?: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, quality))
        let blob = await encode('image/jpeg', 0.9)
        if (!this.current(generation)) return
        if (!blob || blob.size > MAX_BYTES) blob = await encode('image/jpeg', 0.75)
        if (!this.current(generation)) return
        if (!blob || !blob.size || blob.size > MAX_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error()
        const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
        const file = new File([blob], `avatar.${extension}`, { type: blob.type })
        this.open = false
        this.cleanup()
        this.$emit('apply', file, this.selectionId)
      } catch {
        if (this.current(generation)) {
          this.error = this.$t('profile:avatar.crop.encodeError', { defaultValue: 'The crop could not be prepared. Adjust the image and try again, or cancel and choose another image.' })
        }
      } finally {
        this.encoding = false
      }
    }
  }
})
</script>

<style lang="scss" scoped>
.avatar-crop__instructions {
  margin-bottom: 16px;
  color: rgb(var(--v-theme-on-surface-variant));
}
.avatar-crop__stage {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background: rgb(var(--v-theme-surface-variant));
  touch-action: none;
  cursor: grab;
  user-select: none;
  &:active { cursor: grabbing; }
  &:focus-visible { outline: 3px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
}
.avatar-crop__image {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: none;
  pointer-events: none;
  transition: none;
}
.avatar-crop__circle {
  position: absolute;
  inset: 0;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 200px rgb(0 0 0 / 55%);
  pointer-events: none;
}
.avatar-crop__loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}
.avatar-crop__zoom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-block: 16px;
}
</style>
