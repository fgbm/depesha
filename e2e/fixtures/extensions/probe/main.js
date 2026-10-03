// Tries every way out of the sandbox an extension without permissions might attempt.
const attempt = async (name, fn) => {
  try {
    const r = await fn();
    return r === "blocked" ? null : `${name}: open`;
  } catch {
    return null;
  }
};

depesha.on("command", async () => {
  const leaks = (await Promise.all([
    attempt("tauri", () => (typeof __TAURI_INTERNALS__ === "undefined" && typeof self.__TAURI__ === "undefined" ? "blocked" : "open")),
    attempt("ipc", () => fetch("ipc://localhost/accounts", { method: "POST" }).then(() => "open")),
    attempt("ipc-http", () => fetch("http://ipc.localhost/accounts", { method: "POST" }).then(() => "open")),
    attempt("network", () => fetch("https://example.com/").then(() => "open")),
    attempt("import", () => { importScripts("https://example.com/x.js"); return "open"; }),
    attempt("permission", () => depesha.storage.set("x", 1).then(() => "open")),
  ])).filter(Boolean);
  return { toast: leaks.length ? `LEAK ${leaks.join(", ")}` : "sandbox holds 6/6" };
});
