<template lang='pug'>
  v-card.editor-markdown-help(flat, rounded='xl', role='region', aria-labelledby='markdown-help-title', tabindex='0')
    v-container.pa-3(fluid)
      v-row
        v-col(cols='12', lg='6', xl='4')
          v-card.radius-7
            v-card-text
              .d-flex
                v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat, height='44')
                  v-icon.mr-3(color='teal') mdi-information-variant
                  h2#markdown-help-title.text-body-medium.text-teal {{ $t(`editor:help.markdownReference`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.bold`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsum`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: strong {{ $t(`editor:help.loremIpsum2`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.italic`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsum3`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: em {{ $t(`editor:help.loremIpsum2`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.strikethrough`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsum4`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small(style='text-decoration: line-through;') {{ $t(`editor:help.loremIpsum2`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.headers`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.header1`) }}
                      div {{ $t(`editor:help.header2`) }}
                      div {{ $t(`editor:help.header3`) }}
                      div {{ $t(`editor:help.header4`) }}
                      div {{ $t(`editor:help.header5`) }}
                      div {{ $t(`editor:help.header6`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      div(style='font-weight: 700; font-size: 24px;') {{ $t(`editor:help.header12`) }}
                      div(style='font-weight: 700; font-size: 22px;') {{ $t(`editor:help.header22`) }}
                      div(style='font-weight: 700; font-size: 20px;') {{ $t(`editor:help.header32`) }}
                      div(style='font-weight: 700; font-size: 18px;') {{ $t(`editor:help.header42`) }}
                      div(style='font-weight: 700; font-size: 16px;') {{ $t(`editor:help.header52`) }}
                      div(style='font-weight: 700; font-size: 14px;') {{ $t(`editor:help.header62`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.unorderedLists`) }}
              .text-body-small.text-medium-emphasis: em {{ $t(`editor:help.youCanAlsoUse`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.unorderedListItem1`) }}
                      div {{ $t(`editor:help.unorderedListItem2`) }}
                      div {{ $t(`editor:help.unorderedListItem3`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      ul
                        li {{ $t(`editor:help.unorderedListItem12`) }}
                        li {{ $t(`editor:help.unorderedListItem22`) }}
                        li {{ $t(`editor:help.unorderedListItem32`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.orderedLists`) }}
              .text-body-small.text-medium-emphasis: em {{ $t(`editor:help.evenThoughWePrefix`) }} #[strong 1.]{{ $t(`editor:help.outputWillCorrectlyNumbered`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.n1OrderedListItem`) }}
                      div {{ $t(`editor:help.n1OrderedListItem2`) }}
                      div {{ $t(`editor:help.n1OrderedListItem3`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      ol
                        li {{ $t(`editor:help.orderedListItem1`) }}
                        li {{ $t(`editor:help.orderedListItem2`) }}
                        li {{ $t(`editor:help.orderedListItem3`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.images`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.captionTextPathImage`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .editor-markdown-help-image-example {{ $t(`editor:help.captionText`) }}
        v-col(cols='12', lg='6', xl='4')
          v-card.radius-7
            v-card-text
              .d-flex
                v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat, height='44')
                  v-icon.mr-3(color='teal') mdi-information-variant
                  h2.text-body-medium.text-teal {{ $t(`editor:help.markdownReference`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.links`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.linkTextHttpsWiki`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: a(href='https://wiki.js.org', target='_blank', rel='noopener') {{ $t(`editor:help.linkText`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.superscript`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsum5`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small {{ $t(`editor:help.lorem`) }} #[sup {{ $t(`editor:help.ipsum`) }}]
              h3.text-body-medium.mt-3 {{ $t(`editor:help.subscript`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsum6`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small {{ $t(`editor:help.lorem`) }} #[sub {{ $t(`editor:help.ipsum`) }}]
              h3.text-body-medium.mt-3 {{ $t(`editor:help.horizontalLine`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsum2`) }}
                      div ---
                      div {{ $t(`editor:help.dolorSitAmet`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small {{ $t(`editor:help.loremIpsum2`) }}
                      v-divider.my-2
                      .text-body-small {{ $t(`editor:help.dolorSitAmet`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.inlineCode`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsumDolorSit`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small {{ $t(`editor:help.lorem`) }} #[code ipsum dolor sit] {{ $t(`editor:help.amet`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.abbreviations`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.htmlHypertextMarkupLanguage`) }}
                      div.mt-2 {{ $t(`editor:help.html`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: abbr(:title='$t(`editor:help.hypertextMarkupLanguage`)') {{ $t(`editor:help.html`) }}
              h3.text-body-medium.mt-3 {{ $t(`editor:help.codeBlocks`) }}
              .text-body-small.text-medium-emphasis: em {{ $t(`editor:help.exampleBelow`) }} #[strong {{ $t(`editor:help.js`) }}] {{ $t(`editor:help.definesSyntaxHighlightingLanguage`) }}
              .text-body-small.text-medium-emphasis.mt-1 {{ $t(`common:actions.add`) }} #[code title="example.js"] {{ $t(`editor:help.caption`) }} #[code linesStart="30"] {{ $t(`editor:help.renumber`) }} #[code linesHighlight="31,33-35"] {{ $t(`editor:help.markLines`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.js2`) }}
                      div {{ $t(`editor:help.functionMain`) }}
                      div.pl-3 {{ $t(`editor:help.echoLoremIpsum`) }}
                      div }
                      div ```
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text.contents
                      pre.prismjs.line-numbers.language-js
                        code.language-js
                          span.token.keyword {{ $t(`editor:help.function`) }}
                          span.token.function  {{ $t(`editor:help.main`) }}
                          span.token.punctuation  (
                          span.token.punctuation )
                          span.token.punctuation  {#[br]
                          |   {{ $t(`editor:help.echo`) }}
                          span.token.string  {{ $t(`editor:help.loremIpsum7`) }}#[br]
                          span.token.punctuation }
                          span.line-numbers-rows(aria-hidden='true')
                            span
                            span
                            span
              h3.text-body-medium.mt-3 {{ $t(`editor:help.blockquotes`) }}
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div {{ $t(`editor:help.loremIpsum8`) }}
                      div {{ $t(`editor:help.dolorSitAmet2`) }}
                      div {{ $t(`editor:help.consecteturAdipiscingElit`) }}
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      blockquote.editor-markdown-help-blockquote {{ $t(`editor:help.loremIpsum2`) }}#[br]{{ $t(`editor:help.dolorSitAmet3`) }}#[br]{{ $t(`editor:help.consecteturAdipiscingElit2`) }}

        v-col(cols='12', xl='4')
          v-card.radius-7
            v-card-text
              v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat)
                v-icon.mr-3(color='teal') mdi-keyboard
                h2.text-body-medium.text-teal.ma-0 {{ $t(`editor:help.keyboardShortcuts`) }}
              v-list.editor-markdown-help-kbd(lines="two", density="compact")
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.bold`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd B]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.italic`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd I]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.increaseHeaderLevel`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + #[kbd Right]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.decreaseHeaderLevel`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + #[kbd Left]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`common:actions.save`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd S]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.undo`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd Z]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.redo`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut
                      kbd {{ctrlKey}}
                      |  +
                      template(v-if='isApplePlatform')
                        kbd Shift
                        |  +
                      kbd {{isApplePlatform ? 'Z' : 'Y'}}
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.distractionFreeMode`) }}
                  v-list-item-subtitle {{ $t(`editor:help.pressKbdEscKbd`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd F11]

          v-card.radius-7.mt-3
            v-card-text
              v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat)
                v-icon.mr-3(color='teal') mdi-mouse
                h2.text-body-medium.text-teal.ma-0 {{ $t(`editor:help.multiSelection`) }}
              v-list.editor-markdown-help-kbd(lines="two", density="compact")
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.multipleCursors`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] {{ $t(`editor:help.leftClick`) }}
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.selectRegion`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] {{ $t(`editor:help.leftClick`) }}
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium {{ $t(`editor:help.deselect`) }}
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd Esc]
</template>

<script lang='ts'>
const isApplePlatform = typeof navigator !== 'undefined' &&
  /\b(Mac|iPhone|iPad|iPod)\b/.test(navigator.userAgent)

export default {
  data () {
    return {
      isApplePlatform,
      ctrlKey: isApplePlatform ? this.$t('editor:help.cmd') : this.$t('editor:help.ctrl'),
      altKey: isApplePlatform ? this.$t('editor:help.option') : 'Alt'
    }
  }
}
</script>

<style lang='scss'>
.editor-markdown-help {
  position: fixed !important;
  top: 112px;
  left: 64px;
  z-index: 10;
  width: calc(100vw - 64px - 17px);
  height: calc(100dvh - 112px - 24px);
  background-color: color-mix(in srgb, rgb(var(--v-theme-surface)) 94%, transparent) !important;
  color: rgb(var(--v-theme-on-surface));
  overflow: auto;
  overscroll-behavior: contain;

  &-source,
  &-result {
    min-width: 0;
    border: 1px solid rgba(var(--v-border-color), .18);
    border-radius: 7px;
    font-size: 14px;

    .v-card-text {
      min-width: 0;
      color: inherit !important;
      overflow-wrap: anywhere;
    }
  }

  &-source {
    background-color: rgb(var(--v-theme-surface-variant)) !important;
    font-family: 'Roboto Mono', monospace;
  }

  &-result {
    background-color: rgb(var(--v-theme-surface)) !important;

    code {
      display: inline-block;
      background-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, rgb(var(--v-theme-surface)));
      color: rgb(var(--v-theme-on-surface));
      box-shadow: none;
      font-size: inherit;
      overflow-wrap: anywhere;
    }

    .contents {
      padding-bottom: 16px;
    }

    .prismjs {
      margin: 0;
      max-width: 100%;
      overflow-x: auto;
    }
  }

  &-blockquote {
    border: 1px solid rgba(var(--v-border-color), .5);
    border-radius: .5rem;
    padding: 1rem 24px;
  }

  &-image-example {
    display: flex;
    align-items: center;
    justify-content: center;
    width: min(150px, 100%);
    height: 50px;
    border: 1px solid rgba(var(--v-border-color), .35);
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, rgb(var(--v-theme-surface)));
    color: rgb(var(--v-theme-on-surface));
    font-size: 12px;
  }

  &-shortcut {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;

    kbd {
      display: inline-block;
      border: 1px solid rgba(var(--v-border-color), .45);
      border-radius: 4px;
      padding: 0.1em 0.5em;
      margin: 0 0.2em;
      box-shadow: 0 1px 0 rgba(var(--v-theme-on-surface), .2), 0 0 0 2px rgb(var(--v-theme-surface)) inset;
      background-color: rgb(var(--v-theme-surface-variant));
      color: rgb(var(--v-theme-on-surface));
      font-size: 12px;
    }
  }
}

@media (max-width: $tablet - 0.02px) {
  .editor-markdown-help {
    left: 0;
    width: 100%;

    .v-card .v-card-text > .v-row {
      flex-direction: column;
      gap: var(--wiki-space-2, 8px);

      > .v-col {
        flex: 0 0 100%;
        max-width: 100%;
      }

      > .v-icon {
        align-self: center;
        transform: rotate(90deg);
        margin: 2px 0;
      }
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .editor-markdown-help,
  .editor-markdown-help * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
