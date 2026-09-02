<template lang='pug'>
  v-card.editor-markdown-help.animated.fadeInLeft(flat, rounded='0', role='region', aria-labelledby='markdown-help-title', tabindex='0')
    v-container.pa-3(fluid)
      v-row
        v-col(cols='12', lg='6', xl='4')
          v-card.radius-7.animated.fadeInUp
            v-card-text
              .d-flex
                v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat, height='44')
                  v-icon.mr-3(color='teal') mdi-information-variant
                  h2#markdown-help-title.text-body-medium.text-teal Markdown Reference
              h3.text-body-medium.mt-3 Bold
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div **Lorem ipsum**
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: strong Lorem ipsum
              h3.text-body-medium.mt-3 Italic
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div *Lorem ipsum*
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: em Lorem ipsum
              h3.text-body-medium.mt-3 Strikethrough
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div ~~Lorem ipsum~~
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small(style='text-decoration: line-through;') Lorem ipsum
              h3.text-body-medium.mt-3 Headers
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div # Header 1
                      div ## Header 2
                      div ### Header 3
                      div #### Header 4
                      div ##### Header 5
                      div ###### Header 6
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      div(style='font-weight: 700; font-size: 24px;') Header 1
                      div(style='font-weight: 700; font-size: 22px;') Header 2
                      div(style='font-weight: 700; font-size: 20px;') Header 3
                      div(style='font-weight: 700; font-size: 18px;') Header 4
                      div(style='font-weight: 700; font-size: 16px;') Header 5
                      div(style='font-weight: 700; font-size: 14px;') Header 6
              h3.text-body-medium.mt-3 Unordered Lists
              .text-body-small.text-grey-darken-1: em You can also use the asterisk symbol instead of the dash.
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div - Unordered List Item 1
                      div - Unordered List Item 2
                      div - Unordered List Item 3
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      ul
                        li Unordered List Item 1
                        li Unordered List Item 2
                        li Unordered List Item 3
              h3.text-body-medium.mt-3 Ordered Lists
              .text-body-small.text-grey-darken-1: em Even though we prefix all lines with #[strong 1.], the output will be correctly numbered automatically.
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div 1. Ordered List Item 1
                      div 1. Ordered List Item 2
                      div 1. Ordered List Item 3
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      ol
                        li Ordered List Item 1
                        li Ordered List Item 2
                        li Ordered List Item 3
              h3.text-body-medium.mt-3 Images
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div ![Caption Text](/path/to/image.jpg)
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .editor-markdown-help-image-example Caption Text
        v-col(cols='12', lg='6', xl='4')
          v-card.radius-7.animated.fadeInUp.wait-p1s
            v-card-text
              .d-flex
                v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat, height='44')
                  v-icon.mr-3(color='teal') mdi-information-variant
                  h2.text-body-medium.text-teal Markdown Reference
              h3.text-body-medium.mt-3 Links
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div [Link Text](https://wiki.js.org)
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: a(href='https://wiki.js.org', target='_blank', rel='noopener') Link Text
              h3.text-body-medium.mt-3 Superscript
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div Lorem ^ipsum^
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small Lorem #[sup ipsum]
              h3.text-body-medium.mt-3 Subscript
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div Lorem ~ipsum~
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small Lorem #[sub ipsum]
              h3.text-body-medium.mt-3 Horizontal Line
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div Lorem ipsum
                      div ---
                      div Dolor sit amet
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small Lorem ipsum
                      v-divider.my-2
                      .text-body-small Dolor sit amet
              h3.text-body-medium.mt-3 Inline Code
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div Lorem `ipsum dolor sit` amet
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small Lorem #[code ipsum dolor sit] amet
              h3.text-body-medium.mt-3 Abbreviations
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div *[HTML]: HyperText Markup Language
                      div.mt-2 HTML
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: abbr(title='HyperText Markup Language') HTML
              h3.text-body-medium.mt-3 Code Blocks
              .text-body-small.text-grey-darken-1: em In the example below, #[strong js] defines the syntax highlighting language to use. It can be omitted.
              .text-body-small.text-grey-darken-1.mt-1 Add #[code title="example.js"] for a caption, #[code linesStart="30"] to renumber, and #[code linesHighlight="31,33-35"] to mark lines.
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div ```js
                      div function main () {
                      div.pl-3 echo 'Lorem ipsum'
                      div }
                      div ```
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text.contents
                      pre.prismjs.line-numbers.language-js
                        code.language-js
                          span.token.keyword function
                          span.token.function  main
                          span.token.punctuation  (
                          span.token.punctuation )
                          span.token.punctuation  {#[br]
                          |   echo
                          span.token.string  'Lorem ipsum'#[br]
                          span.token.punctuation }
                          span.line-numbers-rows(aria-hidden='true')
                            span
                            span
                            span
              h3.text-body-medium.mt-3 Blockquotes
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div &gt; Lorem ipsum
                      div &gt; dolor sit amet
                      div &gt; consectetur adipiscing elit
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      blockquote.editor-markdown-help-blockquote Lorem ipsum#[br]dolor sit amet#[br]consectetur adipiscing elit

        v-col(cols='12', xl='4')
          v-card.radius-7.animated.fadeInUp.wait-p2s
            v-card-text
              v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat)
                v-icon.mr-3(color='teal') mdi-keyboard
                h2.text-body-medium.text-teal.ma-0 Keyboard Shortcuts
              v-list.editor-markdown-help-kbd(lines="two", density="compact")
                v-list-item
                  v-list-item-title.text-body-medium Bold
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd B]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Italic
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd I]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Increase Header Level
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + #[kbd Right]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Decrease Header Level
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + #[kbd Left]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Save
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd S]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Undo
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd Z]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Redo
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
                  v-list-item-title.text-body-medium Distraction Free Mode
                  v-list-item-subtitle Press <kbd>Esc</kbd> to exit.
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd F11]

          v-card.radius-7.animated.fadeInUp.wait-p3s.mt-3
            v-card-text
              v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat)
                v-icon.mr-3(color='teal') mdi-mouse
                h2.text-body-medium.text-teal.ma-0 Multi-Selection
              v-list.editor-markdown-help-kbd(lines="two", density="compact")
                v-list-item
                  v-list-item-title.text-body-medium Multiple Cursors
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + Left Click
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Select Region
                  template(v-slot:append)
                    span.editor-markdown-help-shortcut #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + Left Click
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Deselect
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
      ctrlKey: isApplePlatform ? 'Cmd' : 'Ctrl',
      altKey: isApplePlatform ? 'Option' : 'Alt'
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
  }
}

@media (max-width: 599.98px) {
  .editor-markdown-help .v-card .v-card-text > .v-row {
    flex-direction: column;
    margin: 0;

    > .v-col {
      flex: 0 0 100%;
      max-width: 100%;
      padding: 4px 0;
    }

    > .v-icon {
      align-self: center;
      transform: rotate(90deg);
      margin: 2px 0;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .editor-markdown-help,
  .editor-markdown-help .animated {
    animation: none !important;
    transition: none !important;
  }
}
</style>
