<template lang='pug'>
svg.login-success-animation(
  viewBox='0 0 72 72'
  width='72'
  height='72'
  role='presentation'
  aria-hidden='true'
  focusable='false'
)
  defs
    linearGradient#login-success-book-cover-gradient(x1='0%' y1='0%' x2='100%' y2='100%')
      stop.login-success-animation__cover-stop--warm(offset='0%')
      stop.login-success-animation__cover-stop--spectral(offset='100%')
    linearGradient#login-success-book-page-gradient(x1='0%' y1='0%' x2='100%' y2='0%')
      stop.login-success-animation__page-stop--light(offset='0%')
      stop.login-success-animation__page-stop--dark(offset='100%')
  ellipse.login-success-animation__shadow(cx='36' cy='57' rx='23' ry='3.5')
  g.login-success-animation__book
    path.login-success-animation__closed-cover(
      d='M17 18 Q36 13 55 18 L55 51 Q36 56 17 51 Z'
    )
    path.login-success-animation__closed-spine(d='M36 18 L36 53')
    path.login-success-animation__spread(
      d='M36 21 C29 17 20 17 13 20 L13 50 C21 47 29 48 36 53 C43 48 51 47 59 50 L59 20 C52 17 43 17 36 21 Z'
    )
    g.login-success-animation__cover.login-success-animation__cover--left
      path(
        d='M36 19 C28 14 19 14 11 17 L11 52 C19 49 28 50 36 55 Z'
      )
    g.login-success-animation__cover.login-success-animation__cover--right
      path(
        d='M36 19 C44 14 53 14 61 17 L61 52 C53 49 44 50 36 55 Z'
      )
    g.login-success-animation__page.login-success-animation__page--turn-1(data-page-turn='1')
      path(
        d='M36 22 C29 18 21 18 14 20 L14 49 C21 46 29 48 36 52 C43 48 51 46 58 49 L58 20 C51 18 43 18 36 22 Z'
      )
      path.login-success-animation__page-rule(d='M20 29 C25 28 30 29 34 32 M38 32 C42 29 47 28 52 29')
    g.login-success-animation__page.login-success-animation__page--turn-2(data-page-turn='2')
      path(
        d='M36 23 C29 19 22 19 15 21 L15 48 C22 46 29 47 36 51 C43 47 50 46 57 48 L57 21 C50 19 43 19 36 23 Z'
      )
      path.login-success-animation__page-rule(d='M21 34 C26 33 30 34 34 36 M38 36 C42 34 46 33 51 34')
    g.login-success-animation__page.login-success-animation__page--turn-3(data-page-turn='3')
      path(
        d='M36 24 C30 20 23 20 16 22 L16 47 C23 45 30 46 36 50 C42 46 49 45 56 47 L56 22 C49 20 42 20 36 24 Z'
      )
      path.login-success-animation__page-rule(d='M22 38 C26 37 30 38 34 40 M38 40 C42 38 46 37 50 38')
    path.login-success-animation__spine(d='M36 20 L36 54')
</template>

<style lang='scss'>
.login-success-animation {
  --login-book-duration: 900ms;
  --login-book-ease: cubic-bezier(.2, .8, .2, 1);
  --login-book-ink: var(--wiki-accent-ink, rgb(var(--v-theme-on-surface, 0 0 0)));
  --login-book-warm: var(--wiki-accent-warm, rgb(var(--v-theme-primary, 99 102 241)));
  --login-book-spectral: var(--wiki-accent-spectral, rgb(var(--v-theme-secondary, 56 189 248)));
  --login-book-paper-base: var(--wiki-surface-raised, rgb(var(--v-theme-surface, 255 255 255)));
  --login-book-paper: color-mix(in srgb, var(--login-book-paper-base) 88%, var(--login-book-spectral));

  display: block;
  width: 72px;
  height: 72px;
  overflow: visible;
  color: var(--login-book-ink);
  pointer-events: none;
}

.login-success-animation__shadow {
  fill: color-mix(in srgb, var(--login-book-ink) 22%, transparent);
  opacity: .34;
}

.login-success-animation__closed-cover {
  fill: url('#login-success-book-cover-gradient');
  stroke: color-mix(in srgb, var(--login-book-ink) 76%, transparent);
  stroke-linejoin: round;
  stroke-width: 1;
  opacity: 1;
  animation-name: loginBookClosedCover;
  animation-duration: var(--login-book-duration);
  animation-fill-mode: both;
  animation-timing-function: var(--login-book-ease);
}

.login-success-animation__closed-spine {
  fill: none;
  stroke: color-mix(in srgb, var(--login-book-ink) 76%, transparent);
  stroke-linecap: round;
  stroke-width: 1;
  opacity: 1;
  animation-name: loginBookClosedCover;
  animation-duration: var(--login-book-duration);
  animation-fill-mode: both;
  animation-timing-function: var(--login-book-ease);
}

.login-success-animation__spread,
.login-success-animation__page path:first-child {
  fill: url('#login-success-book-page-gradient');
  stroke: color-mix(in srgb, var(--login-book-ink) 42%, transparent);
  stroke-linejoin: round;
  stroke-width: .8;
}

.login-success-animation__spread {
  opacity: 0;
  animation-name: loginBookSpread;
  animation-duration: var(--login-book-duration);
  animation-fill-mode: both;
  animation-timing-function: var(--login-book-ease);
}

.login-success-animation__cover {
  transform-box: fill-box;
  transform-origin: center;
  opacity: .96;
  transform: scaleX(.08);
  animation-duration: var(--login-book-duration);
  animation-fill-mode: both;
  animation-timing-function: var(--login-book-ease);
}

.login-success-animation__cover path {
  fill: url('#login-success-book-cover-gradient');
  stroke: color-mix(in srgb, var(--login-book-ink) 76%, transparent);
  stroke-linejoin: round;
  stroke-width: 1;
}

.login-success-animation__cover--left {
  transform-origin: 100% 50%;
  animation-name: loginBookCoverLeft;
}

.login-success-animation__cover--right {
  transform-origin: 0 50%;
  animation-name: loginBookCoverRight;
}

.login-success-animation__page {
  transform-box: fill-box;
  transform-origin: 50% 50%;
  opacity: 0;
  transform: scaleX(.05);
  animation-duration: var(--login-book-duration);
  animation-fill-mode: both;
  animation-timing-function: var(--login-book-ease);
}

.login-success-animation__page--turn-1 {
  animation-name: loginBookPageTurnOne;
}

.login-success-animation__page--turn-2 {
  animation-name: loginBookPageTurnTwo;
}

.login-success-animation__page--turn-3 {
  animation-name: loginBookPageTurnThree;
}

.login-success-animation__page-rule {
  fill: none;
  stroke: color-mix(in srgb, var(--login-book-spectral) 74%, var(--login-book-ink));
  stroke-linecap: round;
  stroke-width: .7;
}

.login-success-animation__spine {
  fill: none;
  stroke: color-mix(in srgb, var(--login-book-warm) 68%, var(--login-book-ink));
  stroke-linecap: round;
  stroke-width: 1.2;
}

.login-success-animation__cover-stop--warm {
  stop-color: var(--login-book-warm);
  stop-opacity: .92;
}

.login-success-animation__cover-stop--spectral {
  stop-color: var(--login-book-spectral);
  stop-opacity: .8;
}

.login-success-animation__page-stop--light {
  stop-color: var(--login-book-paper);
  stop-opacity: .98;
}

.login-success-animation__page-stop--dark {
  stop-color: color-mix(in srgb, var(--login-book-paper) 78%, var(--login-book-spectral));
  stop-opacity: .96;
}

@keyframes loginBookClosedCover {
  0%,
  17% {
    opacity: 1;
  }

  34%,
  100% {
    opacity: 0;
  }
}

@keyframes loginBookSpread {
  0%,
  22% {
    opacity: 0;
  }

  38%,
  100% {
    opacity: .86;
  }
}

@keyframes loginBookCoverLeft {
  0%,
  14% {
    opacity: .96;
    transform: scaleX(.08);
  }

  36%,
  100% {
    opacity: 1;
    transform: scaleX(1);
  }
}

@keyframes loginBookCoverRight {
  0%,
  14% {
    opacity: .96;
    transform: scaleX(.08);
  }

  36%,
  100% {
    opacity: 1;
    transform: scaleX(1);
  }
}

@keyframes loginBookPageTurnOne {
  0%,
  30% {
    opacity: 0;
    transform: scaleX(.05) rotate(-1deg);
  }

  36% {
    opacity: .94;
    transform: scaleX(.08) rotate(-1deg);
  }

  50% {
    opacity: .72;
    transform: scaleX(1) rotate(0);
  }

  100% {
    opacity: .4;
    transform: scaleX(1) rotate(0);
  }
}

@keyframes loginBookPageTurnTwo {
  0%,
  44% {
    opacity: 0;
    transform: scaleX(.05) rotate(1deg);
  }

  50% {
    opacity: .9;
    transform: scaleX(.08) rotate(1deg);
  }

  64% {
    opacity: .64;
    transform: scaleX(1) rotate(0);
  }

  100% {
    opacity: .32;
    transform: scaleX(1) rotate(0);
  }
}

@keyframes loginBookPageTurnThree {
  0%,
  58% {
    opacity: 0;
    transform: scaleX(.05) rotate(-1deg);
  }

  64% {
    opacity: .86;
    transform: scaleX(.08) rotate(-1deg);
  }

  78% {
    opacity: .56;
    transform: scaleX(1) rotate(0);
  }

  100% {
    opacity: .27;
    transform: scaleX(1) rotate(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-success-animation__closed-cover,
  .login-success-animation__closed-spine {
    animation: none;
    opacity: 0;
  }

  .login-success-animation__spread {
    animation: none;
    opacity: .86;
  }

  .login-success-animation__cover,
  .login-success-animation__page {
    animation: none;
    opacity: 1;
    transform: none;
  }
}

@media (forced-colors: active) {
  .login-success-animation {
    color: CanvasText;
  }

  .login-success-animation__closed-cover,
  .login-success-animation__cover path,
  .login-success-animation__page path:first-child,
  .login-success-animation__spread {
    fill: Canvas;
    stroke: CanvasText;
  }

  .login-success-animation__cover-stop--warm,
  .login-success-animation__cover-stop--spectral,
  .login-success-animation__page-stop--light,
  .login-success-animation__page-stop--dark {
    stop-color: Canvas;
    stop-opacity: 1;
  }

  .login-success-animation__page-rule,
  .login-success-animation__closed-spine,
  .login-success-animation__spine {
    stroke: CanvasText;
  }

  .login-success-animation__shadow {
    fill: CanvasText;
    opacity: .2;
  }

  .login-success-animation__closed-cover,
  .login-success-animation__closed-spine {
    animation: none;
    opacity: 0;
  }

  .login-success-animation__spread {
    animation: none;
    opacity: 1;
  }

  .login-success-animation__cover,
  .login-success-animation__page {
    animation: none;
    opacity: 1;
    transform: none;
  }
}
</style>
