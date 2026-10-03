<script lang="ts">
  import type { ComposeContext, PluginContext, Text } from "@depesha/plugin-api";
  import { S } from "./strings";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();
  const say = (s: Text) => ctx.t(s);

  let days = $state(0);
  $effect(() => {
    compose.options.followupDays = days || null;
  });
</script>

<select class="input remind" bind:value={days} title={say(S.remindHint)}>
  <option value={0}>{say(S.remind0)}</option>
  <option value={1}>{say(S.remind1)}</option>
  <option value={3}>{say(S.remind3)}</option>
  <option value={7}>{say(S.remind7)}</option>
</select>

<style>
  .remind {
    max-width: 230px;
    font-size: 13px;
  }
</style>
