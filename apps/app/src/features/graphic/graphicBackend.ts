/**
 * Which host draws this page's HTML graphics, decided once.
 *
 *  - **html-in-canvas** where it draws: the desktop app, Chrome and Edge 157 and
 *    later, and 155 or 156 under the origin trial. Asked by drawing a pixel
 *    (`htmlHost.ts#htmlSupport`).
 *  - **snapshot** everywhere else it can: Safari, Firefox and every older
 *    Chrome the editor runs on (85 and later). The graphic is drawn as an SVG
 *    image of itself (`snapshotHost.ts`), also asked by drawing a pixel, which
 *    also says which of the engine's known faults to work around.
 *  - **none** only where neither draws, which nothing measured so far does.
 *
 * Decided by drawing, never by the user agent or a version number: a build
 * can expose a call and paint nothing, and an engine can fix a fault in a
 * point release. The answer is the same for every host in the page, so the
 * preview, an export and a contact sheet never draw one graphic two ways.
 * Over ports, so the order of the questions is a node test.
 */

export type GraphicBackend = "html-in-canvas" | "snapshot" | "none";

/** Faults in this engine's drawing of SVG images, each measured by the probe. */
export type SnapshotQuirks = {
  /** `box-shadow` and `text-shadow` come out with their Y offset negated (WebKit). */
  shadowYFlipped: boolean;
  /** Only the first layer of a `text-shadow` list is drawn (WebKit). */
  textShadowLayersDropped: boolean;
  /**
   * An outer `box-shadow` is drawn only when it is the one layer and the box
   * has a background (WebKit).
   */
  boxShadowDropped: boolean;
  /** `background-clip: text` paints nothing (Gecko). */
  clipTextMissing: boolean;
  /** An embedded font or image can miss the first draw after `decode()`. */
  lateResources: boolean;
  /** `backface-visibility: hidden` is not honoured (Blink, WebKit). */
  backfaceIgnored: boolean;
};

export const NO_QUIRKS: SnapshotQuirks = {
  shadowYFlipped: false,
  textShadowLayersDropped: false,
  boxShadowDropped: false,
  clipTextMissing: false,
  lateResources: false,
  backfaceIgnored: false,
};

export type BackendPorts = {
  /** html-in-canvas draws here: `htmlHost.ts#htmlSupport`. */
  htmlInCanvas(): Promise<boolean>;
  /** The snapshot host draws here, and with which faults; `null` when it cannot. */
  snapshot(): Promise<SnapshotQuirks | null>;
};

export type BackendDecision = {
  /** The answer, asked for once however many callers wait on it. */
  backend(): Promise<GraphicBackend>;
  /** The answer if it has settled, else `null`. Synchronous, for the hosts. */
  known(): GraphicBackend | null;
  /** What the snapshot probe measured; meaningful once the answer is "snapshot". */
  quirks(): SnapshotQuirks;
};

export function createBackendDecision(ports: BackendPorts): BackendDecision {
  let settled: GraphicBackend | null = null;
  let deciding: Promise<GraphicBackend> | null = null;
  let measured: SnapshotQuirks = NO_QUIRKS;
  const decide = async (): Promise<GraphicBackend> => {
    let html = false;
    try {
      html = await ports.htmlInCanvas();
    } catch {
      html = false;
    }
    if (html) {
      return "html-in-canvas";
    }
    let quirks: SnapshotQuirks | null = null;
    try {
      quirks = await ports.snapshot();
    } catch {
      quirks = null;
    }
    if (quirks != null) {
      measured = quirks;
      return "snapshot";
    }
    return "none";
  };
  return {
    backend() {
      if (settled != null) {
        return Promise.resolve(settled);
      }
      deciding ??= decide().then((answer) => {
        settled = answer;
        return answer;
      });
      return deciding;
    },
    known: () => settled,
    quirks: () => measured,
  };
}
