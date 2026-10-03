import { mount } from "svelte";
import App from "./App.svelte";
import { applySavedTheme } from "./lib/theme";
import "./app.css";

applySavedTheme();

export default mount(App, { target: document.getElementById("app")! });
