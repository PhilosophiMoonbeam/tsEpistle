<template lang="pug">
  .wiki-gutter-column(aria-hidden='true')
    svg.wiki-gutter-column__capital(
      viewBox='0 0 190 145'
      preserveAspectRatio='xMidYMin meet'
      focusable='false'
    )
      g.wiki-gutter-column__wash
        path(d='M58 45 H132 L116 112 H74 Z')

      g.wiki-gutter-column__line
        //- Abacus and raised corner blocks
        rect(x='10' y='8' width='170' height='27' rx='1')
        path.wiki-gutter-column__fine(d='M18 15 H172 M18 28 H172')
        path(d='M28 8 V2 H53 V8 M137 8 V2 H162 V8')

        //- Ionic capital and volutes
        path(d='M20 39 H170')
        path(d='M70 64 C70 39 20 36 20 66 C20 96 63 94 63 66 C63 47 32 47 32 66 C32 80 52 80 52 66 C52 57 40 58 40 66 C40 72 47 72 47 66')
        g(transform='translate(190 0) scale(-1 1)')
          path(d='M70 64 C70 39 20 36 20 66 C20 96 63 94 63 66 C63 47 32 47 32 66 C32 80 52 80 52 66 C52 57 40 58 40 66 C40 72 47 72 47 66')
        path(d='M58 45 H132 L116 112 H74 Z')
        path.wiki-gutter-column__fine(d='M66 48 L78 107 M79 47 L86 110 M95 46 V111 M111 47 L104 110 M124 48 L112 107')

        //- Necking and bead course
        rect(x='55' y='111' width='80' height='30' rx='2')
        path(d='M48 112 H142 M48 139 H142')
        path.wiki-gutter-column__fine(d='M58 119 H132 M58 133 H132')
        g.wiki-gutter-column__beads
          circle(cx='65' cy='126' r='3')
          circle(cx='77' cy='126' r='3')
          circle(cx='89' cy='126' r='3')
          circle(cx='101' cy='126' r='3')
          circle(cx='113' cy='126' r='3')
          circle(cx='125' cy='126' r='3')

    svg.wiki-gutter-column__shaft(
      viewBox='0 0 190 100'
      preserveAspectRatio='none'
      focusable='false'
    )
      path.wiki-gutter-column__wash(d='M53 0 H137 L129 100 H61 Z')
      g.wiki-gutter-column__line
        path(d='M53 0 H137 L129 100 H61 Z')
        path.wiki-gutter-column__fine(d='M62 2 L69 98 M73 1 L77 99 M84 0 L86 100 M95 0 V100 M106 0 L104 100 M117 1 L113 99 M128 2 L121 98')
        path(d='M53 3 C70 -1 120 -1 137 3 M61 97 C76 101 114 101 129 97')

    svg.wiki-gutter-column__base(
      viewBox='0 480 190 120'
      preserveAspectRatio='xMidYMax meet'
      focusable='false'
    )
      g.wiki-gutter-column__wash
        path.wiki-gutter-column__base-neck(d='M61 480 H129 L131 493 H59 Z')
        path(d='M49 500 C49 484 141 484 141 500 C141 516 49 516 49 500 Z')
        path(d='M30 553 C30 532 160 532 160 553 C160 576 30 576 30 553 Z')

      g.wiki-gutter-column__line
        //- Attic base: torus, scotia, lower torus, and plinth
        path.wiki-gutter-column__base-neck(d='M61 480 L59 493 M129 480 L131 493')
        path(d='M49 500 C49 484 141 484 141 500 C141 516 49 516 49 500 Z')
        path(d='M43 513 H147 C143 527 133 537 124 543 H66 C57 537 47 527 43 513 Z')
        path.wiki-gutter-column__fine(d='M49 520 H141 M58 536 H132')
        path(d='M30 553 C30 532 160 532 160 553 C160 576 30 576 30 553 Z')
        rect(x='20' y='568' width='150' height='30' rx='1')
        path.wiki-gutter-column__fine(d='M28 575 H162 M28 591 H162 M39 575 V591 M151 575 V591')
</template>

<style scoped>
.wiki-gutter-column {
  display: flex;
  width: min(100%, 11.5rem, 30cqh);
  height: 100%;
  flex-direction: column;
  margin-inline: auto;
  overflow: visible;
  color: inherit;
}

.wiki-gutter-column > svg {
  display: block;
  width: 100%;
  flex: none;
  overflow: visible;
  shape-rendering: geometricPrecision;
}

.wiki-gutter-column__capital {
  aspect-ratio: 190 / 145;
}

.wiki-gutter-column > .wiki-gutter-column__shaft {
  min-height: 0;
  flex: 1 1 0;
}

.wiki-gutter-column__base {
  aspect-ratio: 190 / 120;
}

.wiki-gutter-column__line {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.35;
  vector-effect: non-scaling-stroke;
}

.wiki-gutter-column__line * {
  vector-effect: non-scaling-stroke;
}

.wiki-gutter-column__fine {
  stroke-width: .75;
}

.wiki-gutter-column__wash {
  fill: var(--wiki-gutter-ink-soft);
  stroke: none;
}

.wiki-gutter-column__beads {
  fill: var(--wiki-gutter-ink-soft);
  stroke-width: .8;
}
</style>
