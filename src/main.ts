import { mount } from "svelte";
import App from "./App.svelte";
import MessageWindow from "./MessageWindow.svelte";
import { keepEngineHandsOff, keepEngineMenuOut } from "./lib/engine";
import { applySavedTheme } from "./lib/theme";
import { registerCoreViewers } from "./lib/viewers";
import "./app.css";

applySavedTheme();
registerCoreViewers();

// Every window of the app mounts here, and every window keeps the engine's own interface out:
// its menu of the right button, its «select all», the keys that reload the page.
keepEngineMenuOut();
keepEngineHandsOff(document, import.meta.env.PROD);

// A letter opened in a window of its own: index.html?message=<id>.
const message = Number(new URLSearchParams(location.search).get("message"));
const target = document.getElementById("app")!;

export default message ? mount(MessageWindow, { target, props: { id: message } }) : mount(App, { target });
