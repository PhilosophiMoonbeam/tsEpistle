<template lang='pug'>
  v-app
    main.onboarding(aria-labelledby='welcome-title')
      .onboarding-content
        img.onboarding-logo(src='/_assets/svg/logo-tsfranki.svg', alt='tsFranki')
        h1#welcome-title.text-headline-medium {{ $t('welcome.title') }}
        p.onboarding-subtitle.text-body-large {{ $t('welcome.subtitle') }}
        .onboarding-actions
          v-btn(color='primary', :href='`/e/` + locale + `/home`', size="x-large")
            v-icon(start) mdi-plus
            span {{ $t('welcome.createhome') }}
          v-btn(color='primary', variant='outlined', href='/a', size="x-large")
            v-icon(start) mdi-view-dashboard
            span {{ $t('welcome.goadmin') }}
</template>

<script lang='ts'>

export default {
  props: {
    locale: {
      type: String,
      default: 'en'
    }
  },
  data() {
    return { }
  }
}
</script>

<style lang='scss'>
.onboarding {
  position: relative;
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  height: auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: var(--wiki-space-10) var(--wiki-page-gutter);
  background:
    radial-gradient(
      circle at 18% 12%,
      color-mix(in srgb, var(--wiki-accent-warm) 20%, transparent),
      transparent 32rem
    ),
    radial-gradient(
      circle at 84% 86%,
      color-mix(in srgb, var(--wiki-accent-spectral) 16%, transparent),
      transparent 36rem
    ),
    linear-gradient(
      145deg,
      var(--wiki-surface-sunken),
      rgb(var(--v-theme-background))
    );
  color: rgb(var(--v-theme-on-background));
  font-family: var(--wiki-font-body);
  isolation: isolate;

  &::before {
    position: absolute;
    z-index: -2;
    inset: 0;
    width: auto;
    height: auto;
    background-image:
      linear-gradient(var(--wiki-surface-border) 1px, transparent 1px),
      linear-gradient(90deg, var(--wiki-surface-border) 1px, transparent 1px);
    background-position: center;
    background-repeat: repeat;
    background-size: var(--wiki-grid-size) var(--wiki-grid-size);
    content: '';
    mask-image: linear-gradient(120deg, rgb(var(--v-theme-on-surface)), transparent 74%);
    opacity: .52;
    animation: none;
    pointer-events: none;
  }

  &::after {
    position: absolute;
    z-index: -1;
    inset: var(--wiki-space-8);
    border: 1px solid color-mix(in srgb, var(--wiki-accent-spectral) 18%, transparent);
    border-radius: var(--wiki-hero-radius);
    content: '';
    pointer-events: none;
  }

  &-content {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: min(100%, 46rem);
    min-height: 0;
    align-items: flex-start;
    justify-content: center;
    padding: clamp(var(--wiki-space-8), 7vw, var(--wiki-space-12));
    border: 1px solid var(--wiki-surface-border-strong);
    border-radius: var(--wiki-hero-radius);
    background: color-mix(
      in srgb,
      rgb(var(--v-theme-surface)) 97%,
      rgb(var(--v-theme-background))
    );
    box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset);
    text-align: start;

    &::before {
      position: absolute;
      top: var(--wiki-space-8);
      bottom: var(--wiki-space-8);
      inset-inline-start: 0;
      width: var(--wiki-space-1);
      border-radius: var(--wiki-radius-pill);
      background: linear-gradient(
        to bottom,
        var(--wiki-accent-warm),
        var(--wiki-accent-spectral)
      );
      content: '';
    }
  }

  img.onboarding-logo {
    display: block;
    width: min(15rem, 72%);
    height: auto;
    margin: 0 0 var(--wiki-space-8);
    filter: none;
    animation: onboardingReveal var(--wiki-motion-slow) var(--wiki-motion-ease-out) both;
  }

  h1 {
    z-index: auto;
    max-width: 12ch;
    margin: 0;
    color: rgb(var(--v-theme-on-surface));
    font-size: clamp(2.25rem, 7vw, 3.75rem) !important;
    font-weight: 740;
    letter-spacing: -.055em !important;
    line-height: 1.02;
    animation: onboardingReveal var(--wiki-motion-slow) var(--wiki-motion-ease-out) both;
    animation-delay: var(--wiki-motion-fast);
  }

  &-subtitle {
    max-width: 36rem;
    margin: var(--wiki-space-5) 0 0 !important;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, transparent);
    font-size: 1rem !important;
    line-height: var(--wiki-leading-body);
    animation: onboardingReveal var(--wiki-motion-slow) var(--wiki-motion-ease-out) both;
    animation-delay: var(--wiki-motion-normal);
  }

  &-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wiki-space-3);
    margin-top: var(--wiki-space-8);
    animation: onboardingReveal var(--wiki-motion-slow) var(--wiki-motion-ease-out) both;
    animation-delay: var(--wiki-motion-slow);

    .v-btn {
      min-height: var(--wiki-control-height);
      border-radius: var(--wiki-control-radius);
      font-weight: 680;
    }
  }
}

@keyframes onboardingReveal {
  from {
    opacity: 0;
    transform: translateY(var(--wiki-space-3));
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 599px) {
  .onboarding {
    align-items: stretch;
    padding: 0;

    &::after {
      display: none;
    }

    &-content {
      width: 100%;
      min-height: 100dvh;
      padding: var(--wiki-space-8) var(--wiki-space-5);
      border: 0;
      border-radius: 0;
      box-shadow: none;

      &::before {
        top: var(--wiki-space-8);
        bottom: auto;
        width: var(--wiki-space-12);
        height: var(--wiki-space-1);
        border-radius: var(--wiki-radius-pill);
      }
    }

    img.onboarding-logo {
      width: min(13rem, 72%);
      margin-bottom: var(--wiki-space-10);
    }

    h1 {
      max-width: 14ch;
      font-size: clamp(2rem, 12vw, 3.25rem) !important;
    }

    &-actions {
      display: grid;
      width: 100%;

      .v-btn {
        width: 100%;
      }
    }
  }
}

@media (max-height: 500px) and (min-width: 600px) {
  .onboarding {
    padding-block: var(--wiki-space-3);

    &-content {
      padding: var(--wiki-space-4) var(--wiki-space-6);
    }

    img.onboarding-logo {
      width: 10rem;
      margin-bottom: var(--wiki-space-3);
    }

    h1 {
      font-size: 2rem !important;
    }

    &-subtitle {
      margin-top: var(--wiki-space-2) !important;
      line-height: 1.3;
    }

    &-actions {
      margin-top: var(--wiki-space-3);
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .onboarding-logo,
  .onboarding h1,
  .onboarding-subtitle,
  .onboarding-actions {
    animation: none;
  }
}

@media print {
  .onboarding {
    padding: 0;
    background: transparent !important;

    &::before,
    &::after,
    &-content::before {
      display: none;
    }

    &-content {
      border: 0;
      box-shadow: none;
    }
  }
}
</style>
