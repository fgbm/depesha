<script lang="ts">
  import { LaterMenu, snoozePresets, type PluginContext } from "@depesha/plugin-api";
  import { snoozeMail } from "./actions";
  import { S } from "./strings";

  let { ctx, ids, done }: { ctx: PluginContext; ids: number[]; done: () => void } = $props();

  function pick(until: number) {
    done();
    snoozeMail(ctx, until, ids);
  }
</script>

<LaterMenu title={ctx.t(S.menuTitle)} presets={snoozePresets()} action={ctx.t(S.action)} onPick={pick} />
