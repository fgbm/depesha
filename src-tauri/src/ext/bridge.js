// Runs in the extension's sandboxed frame. It relays messages between Depesha and the
// extension's worker and never runs extension code itself: the code lives in a worker,
// on its own thread, so an extension stuck in a loop cannot freeze the mail window.
(() => {
  const source = JSON.parse(document.getElementById("source").textContent);
  let worker = null;

  function start() {
    worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    worker.onmessage = (e) => parent.postMessage(e.data, "*");
    worker.onerror = (e) => {
      e.preventDefault();
      parent.postMessage({ type: "error", message: String(e.message || "error") }, "*");
    };
  }

  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    if (e.data && e.data.type === "restart") {
      if (worker) worker.terminate();
      start();
      return;
    }
    if (worker) worker.postMessage(e.data);
  });

  start();
})();
