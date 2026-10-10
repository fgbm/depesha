<script lang="ts">
  // The field of a Markdown letter: Live Preview over CodeMirror, loaded in its own chunk
  // when the field first shows. Until then, and if loading fails, a plain field.
  import { onMount } from "svelte";
  import type { MarkdownField } from "../lib/markdown/types";
  import type { MarkdownEditorHandle } from "../lib/markdown/markdownEditor";

  let {
    value = $bindable(""),
    field = $bindable(null),
    label,
    placeholder = "",
    readonly = false,
    markup = false,
    onfocus,
    onselection,
    onpictures,
  }: {
    value: string;
    /** The editor as a text field, once it is loaded. */
    field?: MarkdownField | null;
    label: string;
    placeholder?: string;
    readonly?: boolean;
    /** Every mark shown at once. */
    markup?: boolean;
    onfocus?: () => void;
    onselection?: () => void;
    onpictures?: (pictures: Blob[]) => void;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let editor = $state.raw<MarkdownEditorHandle | null>(null);
  let failed = $state(false);

  onMount(() => {
    let gone = false;
    import("../lib/markdown/markdownEditor")
      .then(({ createEditor }) => {
        if (gone || !host) return;
        editor = createEditor({
          parent: host,
          value,
          label,
          placeholder,
          readonly,
          markup,
          onchange: (v) => (value = v),
          onselection: () => onselection?.(),
          onfocus: () => onfocus?.(),
          onpictures: (p) => onpictures?.(p),
        });
        field = editor.field;
      })
      // `failed` switches to the plain field.
      .catch(() => (failed = true));
    return () => {
      gone = true;
      editor?.destroy();
      if (field === editor?.field) field = null;
    };
  });

  $effect(() => editor?.setValue(value));
  $effect(() => editor?.setReadonly(readonly));
  $effect(() => editor?.setMarkup(markup));
  $effect(() => editor?.setPlaceholder(placeholder));
</script>

{#if failed}
  <textarea class="md-fallback" bind:value {readonly} {placeholder} spellcheck="true" aria-label={label}></textarea>
{:else}
  <div class="md-editor" bind:this={host}></div>
{/if}

<style>
  .md-editor {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .md-fallback {
    flex: 1;
    border: none;
    outline: none;
    resize: none;
    padding: 14px 18px;
    background: var(--paper);
    line-height: 1.55;
  }
</style>
