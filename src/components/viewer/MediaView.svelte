<script lang="ts">
  // Audio and video with the webview's own player: what its codecs play, plays.
  import { blobType, type ViewedFile } from "../../lib/viewer";

  let { file, kind }: { file: ViewedFile; kind: "audio" | "video" } = $props();

  let url = $state("");

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
</script>

<div class="media">
  {#if url}
    {#if kind === "audio"}
      <audio src={url} controls onerror={() => file.fail(new Error("codec"))}></audio>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={url} controls onerror={() => file.fail(new Error("codec"))}></video>
    {/if}
  {/if}
</div>

<style>
  .media {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  audio {
    width: min(560px, 100%);
  }

  video {
    max-width: 100%;
    max-height: 100%;
    background: #000;
    border-radius: 6px;
  }
</style>
