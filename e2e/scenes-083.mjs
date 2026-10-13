// The scenes of 0.8.3 (docs/releases/0.8.3.md), used by e2e/release-shots.mjs over mail
// seeded with `demo-seed 0.8.3`. Each takes the kit (shot-kit.mjs) and the name of the
// picture it writes.

/** The inbox: the one panel of actions over the list and the reader (#176) and the previews in the rows (#177), with one letter open. */
export async function listPanel(kit, name) {
  const { d, sleep, textOf, shot, openBySubject } = kit;
  await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
  await openBySubject("Отчёт за сентябрь");
  await sleep(1200);
  await shot(name);
}

/** The «Вид» menu: the count of unread newsletters beside «Рассылки» (#182). */
export async function viewFilterCount(kit, name) {
  const { d, sleep, shot, press, db, invoke } = kit;
  // The seeded newsletter is read; the count beside the option is of unread ones, so mark it
  // unread (as the «Непрочитано» action does) before opening the menu.
  const id = db("SELECT id FROM messages WHERE subject LIKE '%ноябрьские скидки%' AND folder='INBOX' LIMIT 1");
  if (id) await invoke("set_flag", { ids: [Number(id)], change: { flag: "seen", value: false } });
  await sleep(800);
  await d.click(await d.find(".list .view .trigger"));
  await d.until("view menu", async () => (await d.findAll(".pop .mi")).length > 0);
  await sleep(500);
  await shot(name);
  await press("Escape");
}
