// About 200 words a minute; at least one minute.
depesha.on("command", (id, { message }) => {
  const words = ((message && message.text) || "").split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return { toast: depesha.lang === "ru" ? `${words} слов, около ${minutes} мин` : `${words} words, about ${minutes} min` };
});
