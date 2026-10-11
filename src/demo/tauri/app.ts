// The demo stand-in for `@tauri-apps/api/app`: the version line of the sidebar.

/** The mockup says so in the sidebar: nobody should take the build for a release. */
export async function getVersion(): Promise<string> {
  return "0.8.3-demo";
}
