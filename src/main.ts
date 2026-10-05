import { mount } from "svelte";
import App from "./App.svelte";
import MessageWindow from "./MessageWindow.svelte";
import { applySavedTheme } from "./lib/theme";
import { registerCoreViewers } from "./lib/viewers";
import "./app.css";

applySavedTheme();
registerCoreViewers();

// A letter opened in a window of its own: index.html?message=<id>.
const message = Number(new URLSearchParams(location.search).get("message"));
const target = document.getElementById("app")!;

export default message ? mount(MessageWindow, { target, props: { id: message } }) : mount(App, { target });
