<template><div ref="host" class="theme-code-editor" /></template>
<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, useTemplateRef } from "vue";
import { useTheme } from "vuetify";
import { EditorView } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { basicSetup } from "codemirror";
const modelValue = defineModel<string>({ required: true });
const {
  language,
  label,
  disabled = false,
} = defineProps<{
  language: "css" | "html";
  label: string;
  disabled?: boolean;
}>();
const host = useTemplateRef<HTMLElement>("host"),
  theme = useTheme(),
  editable = new Compartment(),
  dark = new Compartment();
let editor: EditorView | undefined;
const readonly = () => [
  EditorState.readOnly.of(disabled),
  EditorView.editable.of(!disabled),
];
onMounted(() => {
  if (!host.value) return;
  editor = new EditorView({
    parent: host.value,
    doc: modelValue.value,
    extensions: [
      basicSetup,
      language === "css" ? css() : html(),
      EditorView.lineWrapping,
      editable.of(readonly()),
      dark.of(EditorView.darkTheme.of(theme.current.value.dark)),
      EditorView.contentAttributes.of({
        "aria-label": label,
        spellcheck: "false",
      }),
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged &&
          update.state.doc.toString() !== modelValue.value
        )
          modelValue.value = update.state.doc.toString();
      }),
      EditorView.theme({
        "&": {
          background: "rgb(var(--v-theme-surface))",
          color: "rgb(var(--v-theme-on-surface))",
        },
        ".cm-scroller": {
          minHeight: "240px",
          maxHeight: "480px",
          overflow: "auto",
          fontFamily: "var(--wiki-font-mono)",
          fontSize: "13px",
        },
        ".cm-gutters": {
          background: "rgb(var(--v-theme-surface))",
          color: "rgb(var(--v-theme-on-surface))",
          borderColor: "var(--wiki-surface-border)",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          background: "rgba(var(--v-theme-on-surface), .05)",
        },
        ".cm-cursor": { borderLeftColor: "rgb(var(--v-theme-on-surface))" },
      }),
    ],
  });
});
watch(
  () => modelValue.value,
  (value) => {
    if (editor && value !== editor.state.doc.toString())
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  },
);
watch(
  () => disabled,
  () => editor?.dispatch({ effects: editable.reconfigure(readonly()) }),
);
watch(
  () => theme.current.value.dark,
  (value) =>
    editor?.dispatch({
      effects: dark.reconfigure(EditorView.darkTheme.of(value)),
    }),
);
onBeforeUnmount(() => editor?.destroy());
</script>
<style scoped>
.theme-code-editor {
  min-width: 0;
  border: 1px solid var(--wiki-surface-border);
  border-radius: 8px;
  overflow: hidden;
}
</style>
