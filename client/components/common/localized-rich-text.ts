import i18next from 'i18next'
import { defineComponent, h, onBeforeUnmount, onMounted, ref, type PropType, type SlotsType, type VNode, type VNodeChild } from 'vue'
import { translate } from '../../modules/localization'

const slotNames = ['name', 'title', 'namingRules', 'refEditsLost', 'authorName', 'date'] as const
type RichTextSlotName = typeof slotNames[number]
type RichTextSlots = { [Name in RichTextSlotName]?: () => VNode[] }

/** Localized text stays text; only application-owned named slots can render markup. */
export default defineComponent({
  name: 'LocalizedRichText',
  props: {
    path: { type: String, required: true },
    tag: { type: String as PropType<'span' | 'div'>, default: 'span' }
  },
  slots: Object as SlotsType<RichTextSlots>,
  setup(props, { slots }) {
    const revision = ref(0)
    const invalidate = () => { revision.value += 1 }
    const events = ['initialized', 'loaded', 'languageChanged'] as const
    onMounted(() => {
      for (const event of events) i18next.on(event, invalidate)
    })
    onBeforeUnmount(() => {
      for (const event of events) i18next.off(event, invalidate)
    })

    return () => {
      // i18next is the same instance installed by localizationPlugin, not a second translator.
      void revision.value
      const interpolation: Record<string, string> = {}
      const fragments = new Map<string, () => VNode[]>()
      for (const name of slotNames) {
        const slot = slots[name]
        if (!slot) continue
        const marker = `\uE000${name}\uE001`
        interpolation[name] = marker
        fragments.set(marker, slot)
      }
      const message = translate(props.path, { ...interpolation, interpolation: { escapeValue: false } })
      const children: VNodeChild[] = []
      for (const part of message.split(/(\uE000[^\uE001]*\uE001)/g)) {
        const slot = fragments.get(part)
        // Invoke again for repeated placeholders so each occurrence has its own VNodes.
        if (slot) children.push(...slot())
        else children.push(part)
      }
      return h(props.tag, children)
    }
  }
})
