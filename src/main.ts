import { mount } from "svelte";
import App from "./App.svelte";
import MessageWindow from "./MessageWindow.svelte";
import { applySavedTheme } from "./lib/theme";
import { registerCoreViewers } from "./lib/viewers";
import { startDemo } from "@demo/start";
import "./app.css";

applySavedTheme();
registerCoreViewers();

// A letter opened in a window of its own: index.html?message=<id>.
const message = Number(new URLSearchParams(location.search).get("message"));
const target = document.getElementById("app")!;

// The live mockup's «Вопросы» panel: a no-op in the real app, mounted only in `demo` mode.
startDemo();

export default message ? mount(MessageWindow, { target, props: { id: message } }) : mount(App, { target });
