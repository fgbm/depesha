<script lang="ts">
  // Pictures fit the view; a double click or Ctrl+wheel shows them at their own size and zooms.
  // SVG goes through <img> too: scripts in it never run there.
  import { blobType, type ViewedFile } from "../../lib/viewer";

  let { file }: { file: ViewedFile } = $props();

  let url = $state("");
  /** Zoom; null fits the view. */
  let zoom = $state<number | null>(null);
  let natural = $state({ w: 0, h: 0 });

  $effect(() => {
    let gone = false;
    let made = "";
    file
      .bytes()
      .then((b) => {
        if (gone) return;
        made = URL.createObjectURL(new Blob([b], { type: blobType(file.name, file.mime) }));
        url = made;
      })
      .catch((e) => file.fail(e));
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  });

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const now = zoom ?? 1;
    zoom = Math.min(8, Math.max(0.1, now * (e.deltaY < 0 ? 1.25 : 0.8)));
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="image" class:zoomed={zoom !== null} onwheel={onWheel} ondblclick={() => (zoom = zoom === null ? 1 : null)}>
  {#if url}
    <img
      src={url}
      alt={file.name}
      onload={(e) => {
        const img = e.currentTarget as HTMLImageElement;
        natural = { w: img.naturalWidth, h: img.naturalHeight };
      }}
      onerror={() => file.fail(new Error("image"))}
      style:width={zoom !== null && natural.w ? `${natural.w * zoom}px` : null}
    />
  {/if}
</div>

<style>
  .image {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
    cursor: zoom-in;
    /* A checkerboard shows where a transparent picture ends. */
    background: repeating-conic-gradient(color-mix(in srgb, var(--line) 55%, transparent) 0 25%, transparent 0 50%) 0 0 / 20px 20px;
  }

  .image.zoomed {
    align-items: flex-start;
    justify-content: flex-start;
    cursor: zoom-out;
  }

  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: 0 1px 6px rgb(0 0 0 / 15%);
  }

  .zoomed img {
    max-width: none;
    max-height: none;
    margin: auto;
  }
</style>
