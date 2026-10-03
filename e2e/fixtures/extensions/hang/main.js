// Never answers: the host must give up, replace the worker and keep the window alive.
depesha.on("messageOpen", () => {
  for (;;) {}
});
