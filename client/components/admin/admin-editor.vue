<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img(src='/_assets/svg/icon-web-design.svg', alt='Editor', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary Editors
            .text-body-large.text-grey Editors available when creating or changing a page

        v-card.mt-3
          v-card-title Available editors
          v-card-text
            .text-body-medium.mb-3 Editor selection is stored per page. Open a page in edit mode to change its editor.
            v-list(lines='two')
              v-list-item(v-for='editor in editors', :key='editor.key')
                template(v-slot:prepend)
                  v-icon(color='primary') {{ editor.icon }}
                v-list-item-title {{ editor.title }}
                v-list-item-subtitle {{ editor.description }}</template>

<script lang='ts'>
export default {
  data() {
    return {
      editors: [
        {
          title: 'Markdown',
          key: 'markdown',
          icon: 'mdi-language-markdown',
          description: 'Source Markdown with preview, diagrams, and live collaboration.'
        },
        {
          title: 'Visual Markdown',
          key: 'visual-markdown',
          icon: 'mdi-file-document-edit-outline',
          description: 'Rich-text authoring that persists canonical Markdown.'
        },
        {
          title: 'Visual HTML',
          key: 'ckeditor',
          icon: 'mdi-language-html5',
          description: 'Rich-text authoring that persists HTML.'
        },
        {
          title: 'AsciiDoc',
          key: 'asciidoc',
          icon: 'mdi-file-document-outline',
          description: 'Source AsciiDoc with rendered preview.'
        },
        {
          title: 'Code',
          key: 'code',
          icon: 'mdi-code-tags',
          description: 'Source editor for raw HTML pages.'
        }
      ]
    }
  }
}
</script>

<style lang='scss'>

</style>
