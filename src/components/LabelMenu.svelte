<script lang="ts">
  // Меню действий у метки (#42, кадры 2 и 1В): переименовать, цвет, найти письма, удалить.
  // Общее для раздела «Метки» на странице ящика и для «⋯» в выборе меток на письме.
  import { untrack } from "svelte";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Palette from "@lucide/svelte/icons/palette";
  import Search from "@lucide/svelte/icons/search";
  import Trash from "@lucide/svelte/icons/trash-2";
  import { t } from "../lib/i18n.svelte";
  import type { Label } from "../lib/types";
  import Popover from "./Popover.svelte";

  let props: {
    at: { x: number; y: number };
    label: Label;
    onclose: () => void;
    onrename: (label: Label) => void;
    oncolor: (label: Label) => void;
    ondelete: (label: Label) => void;
    onfind: (label: Label) => void;
  } = $props();

  // The menu lives for one open; closing it clears the parent's state its props come from,
  // so they are taken once, when it opens (the parent keys the menu by the label).
  const { at, label, onclose, onrename, oncolor, ondelete, onfind } = untrack(() => ({ ...props }));
</script>

<Popover {at} bind:open={() => true, (v) => !v && onclose()}>
  <div class="mt">{t("label.menu", { name: label.name })}</div>
  <button class="mi" onclick={() => (onclose(), onrename(label))}><Pencil size={15} /> {t("label.rename")}…</button>
  <button class="mi" onclick={() => (onclose(), oncolor(label))}><Palette size={15} /> {t("label.color")}…</button>
  <button class="mi" onclick={() => (onclose(), onfind(label))}><Search size={15} /> {t("label.find")}<span class="hint">метка:</span></button>
  <hr />
  <button class="mi danger" onclick={() => (onclose(), ondelete(label))}><Trash size={15} /> {t("label.delete")}</button>
</Popover>

<style>
  .mi.danger {
    color: var(--accent);
  }
</style>
