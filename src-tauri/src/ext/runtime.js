// The `depesha` object an extension sees. Everything goes through messages to the host,
// which checks the extension's permissions; there is no other way out of the sandbox.
"use strict";
const depesha = (() => {
  const handlers = Object.create(null);
  const pending = new Map();
  let seq = 0;

  function call(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      postMessage({ type: "rpc", id, method, args });
    });
  }

  self.onmessage = async (e) => {
    const m = e.data || {};
    if (m.type === "rpc-result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
      return;
    }
    if (m.type === "event") {
      const handler = handlers[m.name];
      try {
        const result = handler ? await handler(...(m.args || [])) : undefined;
        postMessage({ type: "result", id: m.id, result: result === undefined ? null : result });
      } catch (err) {
        postMessage({ type: "result", id: m.id, error: String((err && err.message) || err) });
      }
    }
  };

  return Object.freeze({
    /** Interface language: "en" or "ru". */
    lang: __DEPESHA_LANG__,
    /** Registers a handler: messageOpen, newMail, beforeSend, command. */
    on(name, fn) {
      handlers[name] = fn;
    },
    storage: Object.freeze({
      get: (key) => call("storage.get", [String(key)]),
      set: (key, value) => call("storage.set", [String(key), value]),
    }),
    toast: (text) => call("toast", [String(text)]),
  });
})();
