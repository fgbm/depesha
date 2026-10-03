<script lang="ts">
  import { Select, type ComposeContext, type PluginContext, type Text } from "@depesha/plugin-api";
  import { S } from "./strings";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();
  const say = (s: Text) => ctx.t(s);

  let days = $state(0);
  $effect(() => {
    compose.options.followupDays = days || null;
  });
</script>

<Select
  class="remind"
  bind:value={days}
  title={say(S.remindHint)}
  label={say(S.remindHint)}
  options={[
    { value: 0, label: say(S.remind0) },
    { value: 1, label: say(S.remind1) },
    { value: 3, label: say(S.remind3) },
    { value: 7, label: say(S.remind7) },
  ]}
/>

<style>
  :global(.select.remind) {
    max-width: 230px;
    font-size: 13px;
  }
</style>
