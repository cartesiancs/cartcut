/**
 * The engine window's entry point.
 *
 * All it does is start the state machine and make sure a failure says so
 * somewhere a person can see. The window is never shown, so an unhandled
 * rejection here would otherwise be a recorder whose tray icon appears and does
 * nothing when clicked.
 */

import { handleTrayClick, init } from "./session";
import { hasStrokes, visibleStrokes } from "./strokeStore";

/**
 * The tray, reachable from a script.
 *
 * A native tray menu cannot be opened or clicked programmatically on any
 * platform, so without this there is no way at all to drive a recording from a
 * test or from the devtools console — the recorder would be the one feature in
 * the app that can only ever be exercised by hand.
 *
 * `handleTrayClick` is the same entry point the real menu uses, taking the same
 * opaque ids; nothing here is a test-only path and removing this line would
 * change no behaviour. That is the property that makes exposing it acceptable,
 * and it is the same argument `apps/app/src/index.ts` makes for the handful of
 * modules it re-exports on `CARTCUT`.
 */
(window as any).__record = {
  handleTrayClick,
  hasStrokes,
  /** How many annotations the compositor is currently drawing. */
  strokeCount: () => visibleStrokes(performance.now()).length,
};

function report(message: string): void {
  const status = document.getElementById("status");
  if (status != null) {
    status.textContent = message;
  }
}

init().catch((error) => {
  console.error("[record] the recorder could not start", error);
  report(`The recorder could not start: ${(error as Error).message}`);
});
