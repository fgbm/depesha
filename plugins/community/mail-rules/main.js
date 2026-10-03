// Edit the rules and reinstall the extension. `do`: move (with `folder`), archive,
// read, flag, spam or delete. `subject` and `from` match a part, case-insensitively.
const RULES = [
  { subject: "[в работу]", do: "move", folder: "Работа" },
  { from: "noreply@", do: "read" },
];

const has = (value, part) => !part || (value || "").toLowerCase().includes(part.toLowerCase());

depesha.on("newMail", async (messages) => {
  const actions = [];
  for (const m of messages) {
    const rule = RULES.find((r) => (r.subject || r.from) && has(m.subject, r.subject) && has(m.from && m.from.email, r.from));
    if (rule) actions.push(rule.do === "move" ? { id: m.id, do: "move", folder: rule.folder } : { id: m.id, do: rule.do });
  }
  if (actions.length) {
    const total = ((await depesha.storage.get("handled")) || 0) + actions.length;
    await depesha.storage.set("handled", total);
  }
  return { actions };
});

depesha.on("command", async (id) => {
  if (id !== "stats") return null;
  const n = (await depesha.storage.get("handled")) || 0;
  return { toast: depesha.lang === "ru" ? `правила обработали писем: ${n}` : `rules handled ${n} messages` };
});
