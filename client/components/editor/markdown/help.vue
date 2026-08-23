<template lang='pug'>
  v-card.editor-markdown-help.animated.fadeInLeft(flat, rounded='0')
    v-container.pa-3(fluid)
      v-row
        v-col(cols='12', lg='6', xl='4')
          v-card.radius-7.animated.fadeInUp
            v-card-text
              .d-flex
                v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat, height='44')
                  v-icon.mr-3(color='teal') mdi-information-variant
                  .text-body-medium.text-teal Markdown Reference
              .text-body-medium.mt-3 Bold
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
              .text-body-medium.mt-3 Italic
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
              .text-body-medium.mt-3 Strikethrough
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
              .text-body-medium.mt-3 Headers
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
              .text-body-medium.mt-3 Unordered Lists
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
              .text-body-medium.mt-3 Ordered Lists
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
                        li Unordered List Item 1
                        li Unordered List Item 2
                        li Unordered List Item 3
              .text-body-medium.mt-3 Images
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
                  .text-body-medium.text-teal Markdown Reference (continued)
              .text-body-medium.mt-3 Links
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div [Link Text](https://wiki.js.org)
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: a(href='https://wiki.js.org', target='_blank') Link Text
              .text-body-medium.mt-3 Superscript
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
              .text-body-medium.mt-3 Subscript
              v-row
                v-col(cols='6')
                  v-card.editor-markdown-help-source(flat)
                    v-card-text
                      div Lorem ~ipsum~
                v-icon mdi-chevron-right
                v-col
                  v-card.editor-markdown-help-result(flat)
                    v-card-text
                      .text-body-small: em Lorem #[sub ipsum]
              .text-body-medium.mt-3 Horizontal Line
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
              .text-body-medium.mt-3 Inline Code
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
              .text-body-medium.mt-3 Code Blocks
              .text-body-small.text-grey-darken-1: em In the example below, #[strong js] defines the syntax highlighting language to use. It can be omitted.
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
              .text-body-medium.mt-3 Blockquotes
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
                      blockquote(style='border: 1px solid #263238; border-radius: .5rem; padding: 1rem 24px;') Lorem ipsum#[br]dolor sit amet#[br]consectetur adipiscing elit

        v-col(cols='12', xl='4')
          v-card.radius-7.animated.fadeInUp.wait-p2s
            v-card-text
              v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat)
                v-icon.mr-3(color='teal') mdi-keyboard
                .text-body-medium.text-teal Keyboard Shortcuts
              v-list.editor-markdown-help-kbd(lines="two", density="compact")
                v-list-item
                  v-list-item-title.text-body-medium Bold
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd B]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Italic
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd I]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Increase Header Level
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + #[kbd Right]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Decrease Header Level
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + #[kbd Left]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Save
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd S]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Undo
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd Z]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Redo
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd Y]
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Distraction Free Mode
                  v-list-item-subtitle Press <kbd>Esc</kbd> to exit.
                  template(v-slot:append) #[kbd F11]

          v-card.radius-7.animated.fadeInUp.wait-p3s.mt-3
            v-card-text
              v-toolbar.radius-7(color="teal-lighten-5", density="compact", flat)
                v-icon.mr-3(color='teal') mdi-mouse
                .text-body-medium.text-teal Multi-Selection
              v-list.editor-markdown-help-kbd(lines="two", density="compact")
                v-list-item
                  v-list-item-title.text-body-medium Multiple Cursors
                  template(v-slot:append) #[kbd {{ctrlKey}}] + Left Click
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Select Region
                  template(v-slot:append) #[kbd {{ctrlKey}}] + #[kbd {{altKey}}] + Left Click
                v-divider
                v-list-item
                  v-list-item-title.text-body-medium Deselect
                  template(v-slot:append) #[kbd Esc]</template>

<script lang='ts'>
export default {
  computed: {
    ctrlKey() { return /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl' },
    altKey() { return /Mac/.test(navigator.platform) ? 'Option' : 'Alt' }
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
  height: calc(100vh - 112px - 24px);
  background-color: rgba(darken(mc('grey', '900'), 3%), .9) !important;
  overflow: auto;

  &-source {
    background-color: mc('blue-grey', '900') !important;
    border-radius: 7px;
    font-family: 'Roboto Mono', monospace;
    font-size: 14px;
    color: #FFF !important;

    .v-card-text {
      color: #FFF !important;
    }
  }

  &-result {
    background-color: mc('blue-grey', '50') !important;
    border-radius: 7px;
    font-size: 14px;

    code {
      display: inline-block;
      background-color: mc('pink', '50');
      box-shadow: none;
      font-size: inherit;
    }

    .contents {
      padding-bottom: 16px;
    }

    .prismjs {
      margin: 0;
    }
  }
  &-image-example {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 150px;
    height: 50px;
    border: 1px solid mc('blue-grey', '200');
    background: mc('blue-grey', '100');
    color: mc('blue-grey', '700');
    font-size: 12px;
  }

  &-kbd {
    .v-list-item__append {
      flex-direction: row;
      align-items: center;

      kbd {
        display: inline-block;
        border: 1px solid #ccc;
        border-radius: 4px;
        padding: 0.1em 0.5em;
        margin: 0 0.2em;
        box-shadow: 0 1px 0px rgba(0, 0, 0, 0.2), 0 0 0 2px #fff inset;
        background-color: #f7f7f7;
        color: mc('grey', '700');
        font-size: 12px;
      }
    }
  }
}
</style>
