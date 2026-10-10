/**
 * Preloaded into the main process of a cloud-content run (through
 * NODE_OPTIONS), so the test instance never appears on the screen or makes a
 * sound, from its first window on. `launchApp` waits for the editor to be
 * visible, so `show` becomes `showInactive` at opacity 0 rather than nothing.
 *
 * Main process only: an extension host or another utility process gets the
 * same NODE_OPTIONS and has no `app`.
 */
if (process.type === "browser") {
  const { app } = require("electron");
  app.on("browser-window-created", (_event, window) => {
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
    window.webContents.setBackgroundThrottling(false);
    window.show = () => window.showInactive();
  });
  app.on("web-contents-created", (_event, contents) => contents.setAudioMuted(true));
}
