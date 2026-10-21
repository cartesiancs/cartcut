/**
 * Telling the user, once, that this browser cannot draw the project's titles.
 *
 * HTML graphics draw through html-in-canvas, which Chrome and Edge turn on by
 * default from 157 and Safari and Firefox do not have. Where it is missing the
 * host draws nothing, and before this nothing said so: the preview showed the
 * clips with every title gone, which reads as a broken template.
 *
 * Asked whenever a frame has HTML graphics to draw; it settles once and is quiet
 * from then on, whichever way the answer went. Over a port so the rule runs
 * under `environment: "node"`.
 */

/** What a browser that cannot draw them is told. */
export const UNSUPPORTED_TITLES_MESSAGE =
  "This browser cannot draw this project's titles. Open it in Chrome or Edge 157 or later to see them.";

/** What an export from such a browser is told before it starts. */
export const UNSUPPORTED_TITLES_EXPORT_MESSAGE =
  "This browser cannot draw this project's titles, so the export will not have them. Chrome or Edge 157 or later draws them.";

export type SupportNoticePort = {
  /** The desktop app always draws them, so it is never asked. */
  desktop(): boolean;
  supported(): Promise<boolean>;
  show(message: string): void;
};

export type SupportNotice = {
  /** A frame has HTML graphics to draw. */
  needed(): void;
};

export function createSupportNotice(port: SupportNoticePort): SupportNotice {
  let state: "idle" | "asking" | "settled" = "idle";
  return {
    needed() {
      if (state !== "idle" || port.desktop()) {
        return;
      }
      state = "asking";
      port.supported().then(
        (ok) => {
          state = "settled";
          if (!ok) {
            port.show(UNSUPPORTED_TITLES_MESSAGE);
          }
        },
        // Asked again on the next frame that needs it.
        () => {
          state = "idle";
        },
      );
    },
  };
}
