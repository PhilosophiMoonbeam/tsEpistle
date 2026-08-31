<template lang="pug">
  .tabset
    ul.tabset-tabs(ref='tabs', role='tablist')
      slot(name='tabs')
    .tabset-content(ref='content')
      slot(name='content')
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { customAlphabet } from 'nanoid/non-secure'

const nanoid = customAlphabet('1234567890abcdef', 10)

export default defineComponent({
  data() {
    return {
      currentTab: 0
    }
  },
  watch: {
    currentTab () {
      this.setActiveTab()
    }
  },
  methods: {
    tabElements () {
      return Array.from((this.$refs.tabs as HTMLUListElement).children) as HTMLElement[]
    },
    panelElements () {
      return Array.from((this.$refs.content as HTMLElement).children) as HTMLElement[]
    },
    revealActiveTab () {
      const tabs = this.$refs.tabs as HTMLUListElement
      const activeTab = this.tabElements()[this.currentTab]
      if (!activeTab) {
        return
      }

      const tabsRect = tabs.getBoundingClientRect()
      const tabRect = activeTab.getBoundingClientRect()
      const isRtl = getComputedStyle(tabs).direction === 'rtl'
      const startOverflow = isRtl
        ? tabRect.right - tabsRect.right
        : tabsRect.left - tabRect.left
      const endOverflow = isRtl
        ? tabsRect.left - tabRect.left
        : tabRect.right - tabsRect.right

      if (startOverflow > 0) {
        tabs.scrollBy({ left: isRtl ? startOverflow : -startOverflow })
      } else if (endOverflow > 0) {
        tabs.scrollBy({ left: isRtl ? -endOverflow : endOverflow })
      }
    },
    setActiveTab () {
      this.tabElements().forEach((node, idx) => {
        if (idx === this.currentTab) {
          node.className = 'is-active'
          node.setAttribute('aria-selected', 'true')
          node.setAttribute('tabindex', '0')
        } else {
          node.className = ''
          node.setAttribute('aria-selected', 'false')
          node.setAttribute('tabindex', '-1')
        }
      })
      this.panelElements().forEach((node, idx) => {
        if (idx === this.currentTab) {
          node.className = 'tabset-panel is-active'
          node.removeAttribute('hidden')
        } else {
          node.className = 'tabset-panel'
          node.setAttribute('hidden', '')
        }
      })
      this.$nextTick(() => this.revealActiveTab())
    }
  },
  mounted () {
    const panels = this.panelElements()

    // Handle scroll to header on load within hidden tab content
    if (window.location.hash && window.location.hash.length > 1) {
      const headerId = decodeURIComponent(window.location.hash)
      const foundIdx = panels.findIndex(node => node.querySelector(headerId) !== null)
      if (foundIdx >= 0) {
        this.currentTab = foundIdx
      }
    }

    this.setActiveTab()

    const tabRefId = nanoid()
    const tabs = this.tabElements()

    tabs.forEach((node, idx) => {
      node.setAttribute('id', `${tabRefId}-${idx}`)
      node.setAttribute('role', 'tab')
      node.setAttribute('aria-controls', `${tabRefId}-${idx}-tab`)
      node.setAttribute('tabindex', idx === this.currentTab ? '0' : '-1')
      node.addEventListener('click', () => {
        this.currentTab = idx
      })
      node.addEventListener('keydown', (ev: KeyboardEvent) => {
        const isNavigationKey = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End'
        const isActivationKey = ev.key === 'Enter' || ev.key === ' '
        if (isNavigationKey || isActivationKey) {
          ev.preventDefault()
        }

        if (ev.key === 'ArrowLeft') {
          this.currentTab = Math.max(0, idx - 1)
          this.tabElements()[this.currentTab]?.focus()
        } else if (ev.key === 'ArrowRight') {
          this.currentTab = Math.min(tabs.length - 1, idx + 1)
          this.tabElements()[this.currentTab]?.focus()
        } else if (isActivationKey) {
          this.currentTab = idx
          node.focus()
        } else if (ev.key === 'Home') {
          this.currentTab = 0
          this.tabElements()[0]?.focus()
        } else if (ev.key === 'End') {
          this.currentTab = tabs.length - 1
          this.tabElements()[tabs.length - 1]?.focus()
        }
      })
    })

    panels.forEach((node, idx) => {
      node.setAttribute('id', `${tabRefId}-${idx}-tab`)
      node.setAttribute('role', 'tabpanel')
      node.setAttribute('aria-labelledby', `${tabRefId}-${idx}`)
      node.setAttribute('tabindex', '0')
    })
  }
})
</script>

<style lang="scss">
.tabset {
  overflow: hidden;
  margin-block: var(--wiki-space-6);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: rgb(var(--v-theme-surface));
  box-shadow:
    var(--wiki-shadow-inset),
    var(--wiki-shadow-xs);

  > .tabset-tabs {
    display: flex;
    overflow-x: auto;
    align-items: stretch;
    margin: 0;
    padding: 0;
    border-block-end: 1px solid var(--wiki-surface-border);
    background: var(--wiki-surface-sunken);
    list-style: none;
    overscroll-behavior-inline: contain;
    scrollbar-color: color-mix(in srgb, var(--wiki-accent-warm) 42%, transparent) transparent;
    scrollbar-width: thin;

    > li {
      position: relative;
      display: flex;
      min-height: var(--wiki-control-height);
      flex: 0 0 auto;
      align-items: center;
      margin: 0;
      padding: var(--wiki-space-3) var(--wiki-space-4);
      border-inline-end: 1px solid var(--wiki-surface-border);
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
      font-size: .875rem;
      font-weight: 650;
      line-height: 1.35;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      transition:
        background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
        color var(--wiki-motion-fast) var(--wiki-motion-ease);

      &::after {
        position: absolute;
        inset: auto var(--wiki-space-3) 0;
        height: .1875rem;
        border-radius: var(--wiki-radius-pill) var(--wiki-radius-pill) 0 0;
        background: var(--wiki-ambient-accent);
        content: '';
        opacity: 0;
        transform: scaleX(.45);
        transform-origin: center;
        transition:
          opacity var(--wiki-motion-fast) var(--wiki-motion-ease),
          transform var(--wiki-motion-normal) var(--wiki-motion-ease-out);
      }

      &:last-child {
        border-inline-end: 0;
      }

      &:hover {
        background: color-mix(in srgb, var(--wiki-accent-warm) 7%, transparent);
        color: rgb(var(--v-theme-on-surface));
      }

      &.is-active {
        background: rgb(var(--v-theme-surface));
        color: var(--wiki-accent-warm);

        &::after {
          opacity: 1;
          transform: scaleX(1);
        }
      }

      &:focus-visible {
        z-index: 1;
      }
    }
  }

  > .tabset-content {
    min-width: 0;
    background: rgb(var(--v-theme-surface));

    .tabset-panel {
      display: none;
      min-width: 0;
      padding: var(--wiki-space-6);

      &.is-active {
        display: block;
      }

      > :first-child {
        margin-block-start: 0;
      }

      > :last-child {
        margin-block-end: 0;
      }
    }
  }
}

@media (max-width: 599px) {
  .tabset {
    margin-block: var(--wiki-space-5);
    border-radius: var(--wiki-control-radius);

    > .tabset-tabs > li {
      padding-inline: var(--wiki-space-3);
      font-size: .8125rem;
    }

    > .tabset-content .tabset-panel {
      padding: var(--wiki-space-4);
    }
  }
}

@media print {
  .tabset {
    border-color: currentColor;
    background: transparent;
    box-shadow: none;

    > .tabset-tabs {
      display: none;
    }

    > .tabset-content {
      background: transparent;

      .tabset-panel {
        padding: 0;
      }
    }
  }
}

@media (forced-colors: active) {
  .tabset {
    border-color: CanvasText;
    box-shadow: none;

    > .tabset-tabs {
      border-color: CanvasText;
    }

    > .tabset-tabs > li {
      border-color: CanvasText;

      &.is-active {
        outline: .125rem solid Highlight;
        outline-offset: -.125rem;
      }
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .tabset > .tabset-tabs > li,
  .tabset > .tabset-tabs > li::after {
    transition-duration: .001ms !important;
  }
}
</style>
