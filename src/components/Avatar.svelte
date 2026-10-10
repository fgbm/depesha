<script lang="ts">
  // The round picture of a person in the list (#108): the company's logo, else the photo,
  // else initials on the colour of the address, as in the open letter, so one person looks
  // the same everywhere. A circle shows and does nothing (4.1 А): no focus, no click.
  import { avatarColor, initials } from "../lib/format";
  import { avatarOf } from "../lib/avatars.svelte";
  import type { Addr } from "../lib/types";

  /** `logoOf`: the cached letter a company logo may be asked for; null: no logo. */
  let { addr, accountId, logoOf }: { addr: Addr | null; accountId: string; logoOf: number | null } = $props();

  const picture = $derived(avatarOf(accountId, addr?.email, logoOf));
</script>

<span class="avatar" class:pic={picture} style:background={picture ? null : avatarColor(addr?.email ?? "")} aria-hidden="true">
  {#if picture}<img src={picture} alt="" />{:else}{initials(addr)}{/if}
</span>

<style>
  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: #fff;
    font-size: 13px;
    letter-spacing: 0.02em;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    overflow: hidden;
  }

  /* A photo or a logo fills the circle; logos are drawn for a white ground. */
  .avatar.pic {
    background: #fff;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .avatar.pic img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
