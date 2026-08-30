<template lang='pug'>
  v-app
    main.newpage(aria-labelledby='newpage-title')
      .newpage-content
        .newpage-mark(aria-hidden='true')
          img.animated.fadeIn(src='/_assets/svg/icon-file.svg', alt='')
        header.newpage-copy
          h1#newpage-title.text-headline-medium {{ $t('newpage.title') }}
          p.text-body-large.mt-3 {{ $t('newpage.subtitle') }}
        .newpage-path(:aria-label='`Page destination: /${locale}/${path}`')
          v-icon(size='small', aria-hidden='true') mdi-map-marker-path
          code /{{ locale }}/{{ path }}
        .newpage-actions(role='group', :aria-label='$t(`newpage.title`)')
          v-btn.newpage-action.newpage-action--create(
            :href='`/e/` + locale + `/` + path'
            size='large'
            color='primary'
            variant='flat'
          )
            v-icon(start) mdi-plus
            span {{ $t('newpage.create') }}
          v-btn.newpage-action.newpage-action--back(
            color='primary'
            @click='goBack'
            variant='outlined'
            size='large'
          )
            v-icon(start) {{ $vuetify.locale.isRtl ? 'mdi-arrow-right' : 'mdi-arrow-left' }}
            span {{ $t('newpage.goback') }}
</template>

<script lang='ts'>

export default {
  props: {
    locale: {
      type: String,
      default: 'en'
    },
    path: {
      type: String,
      default: 'home'
    }
  },
  methods: {
    goBack () {
      window.history.back()
    }
  }
}
</script>

<style lang='scss'>
.newpage-content {
  overflow: hidden;
  isolation: isolate;

  &::before {
    position: absolute;
    inset-block-start: 0;
    inset-inline: 0;
    height: var(--wiki-space-1);
    background: linear-gradient(
      90deg,
      var(--wiki-accent-warm),
      var(--wiki-ambient-accent),
      var(--wiki-accent-spectral)
    );
    content: '';
  }
}

.newpage-mark {
  display: grid;
  width: calc(var(--wiki-space-12) * 3);
  height: calc(var(--wiki-space-12) * 3);
  margin-bottom: var(--wiki-space-6);
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 24%, transparent);
  border-radius: var(--wiki-hero-radius);
  background:
    radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--wiki-accent-spectral) 18%, transparent), transparent 64%),
    var(--wiki-surface-sunken);
  box-shadow: var(--wiki-shadow-sm), var(--wiki-shadow-inset);

  img {
    width: auto;
    height: calc(var(--wiki-space-12) * 2);
    margin: 0;
  }
}

.newpage-copy {
  max-width: 36rem;

  p {
    margin-bottom: 0;
  }
}

.newpage-path {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: var(--wiki-space-2);
  margin-top: var(--wiki-space-5);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-pill);
  background: var(--wiki-surface-sunken);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);

  code {
    overflow: hidden;
    font-size: .8125rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.newpage-actions {
  .newpage-action {
    min-width: 11rem;
    border-radius: var(--wiki-control-radius);
    font-weight: 680;
    letter-spacing: .01em;
    transition:
      transform var(--wiki-motion-fast) var(--wiki-motion-ease-out),
      box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease-out),
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover {
      transform: translateY(calc(var(--wiki-space-1) * -.25));
    }
  }

  .newpage-action--create {
    box-shadow: var(--wiki-shadow-sm);

    &:hover {
      box-shadow: var(--wiki-shadow-md);
    }
  }

  .newpage-action--back {
    background: var(--wiki-surface-raised);
  }
}

@media (max-width: 599px) {
  .newpage-mark {
    width: calc(var(--wiki-space-12) * 2.5);
    height: calc(var(--wiki-space-12) * 2.5);
    margin-bottom: var(--wiki-space-4);

    img {
      height: calc(var(--wiki-space-10) + var(--wiki-space-4));
    }
  }

  .newpage-path {
    max-width: min(100%, 20rem);
  }

  .newpage-actions {
    gap: var(--wiki-space-2);
    margin-top: var(--wiki-space-5);
  }
}

@media (max-height: 500px) and (min-width: 600px) {
  .newpage {
    padding-block: var(--wiki-space-3);

    &-content {
      min-height: 0;
      height: calc(100dvh - var(--wiki-space-6));
      padding: var(--wiki-space-4) var(--wiki-space-6);
    }
  }

  .newpage-mark {
    width: calc(var(--wiki-space-12) * 2);
    height: calc(var(--wiki-space-12) * 2);
    margin-bottom: var(--wiki-space-2);

    img {
      height: var(--wiki-space-10);
    }
  }

  .newpage-copy .text-body-large {
    line-height: 1.3;
  }

  .newpage-path,
  .newpage-actions {
    margin-top: var(--wiki-space-3);
  }
}

@media (forced-colors: active) {
  .newpage-mark,
  .newpage-path {
    border-color: CanvasText;
  }
}

@media (prefers-reduced-motion: reduce) {
  .newpage-action {
    transform: none !important;
  }
}
</style>
