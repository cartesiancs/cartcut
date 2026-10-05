/**
 * The narrow port between the prepare step and the DOM.
 *
 * Everything that touches html-in-canvas lives behind this, in `htmlHost.ts`,
 * the one file that calls `drawElementImage`: the API is a proposal, and its
 * shape has already changed once upstream (`tests/e2e/FINDINGS.md` section 10).
 * Planning, keying, caching and the order of calls are on this side, where a
 * fake port tests them under `environment: "node"`.
 */

import type { FontEntry } from "../font/fontFaces";
import type { SafeNode } from "./sanitizeHtml";

/** What it takes to build one graphic's DOM. Stable for a given program. */
export type MountSpec = {
  /** Changes when the program does; a mount with a new key is rebuilt. */
  programKey: string;
  /** The sanitised markup, before text slots are filled or anything is split. */
  nodes: SafeNode[];
  /** The filtered, renamed stylesheet, with `asset:` already resolved. */
  css: string;
  /** `@property` rules to register at document level, renamed. */
  propertyRules: string;
  /** Custom property renames the host applies to the variables it sets. */
  renames: Record<string, string>;
  /** `asset:<name>` to a loadable URL, for `<img src>`. */
  assetUrls: Record<string, string>;
  /** Program hash, for the split's `--rand`. */
  programHash: string;
};

/** What changes from frame to frame. */
export type ApplyState = {
  vars: Record<string, string>;
  texts: Record<string, string>;
  layoutBox: { width: number; height: number };
  bleed: number;
  /** Program time, ms: what every CSS animation and SMIL clock is set to. */
  timeMs: number;
  seed: number;
  /** Faces to register and wait for before the next paint. */
  fonts: FontEntry[];
};

export interface HtmlRasterPort {
  /** Whether html-in-canvas is available here at all. */
  supported(): boolean;
  /** Build or keep the DOM for an instance. Cheap when `spec.programKey` is unchanged. */
  mount(instanceId: string, spec: MountSpec): void;
  /** Set variables, texts, layout and the clock. Synchronous. */
  apply(instanceId: string, state: ApplyState): void;
  /**
   * Wait until everything applied since the last call is painted: fonts,
   * images, and the next `paint` event of every touched instance. `false` when
   * a paint did not come in time (a minimised, throttled window).
   */
  settle(): Promise<boolean>;
  /**
   * Draw an instance's current paint at a size. The returned canvas is the
   * mount's own and is redrawn by the next `rasterize` of that instance, so a
   * caller that keeps it must be the only caller of this host.
   */
  rasterize(instanceId: string, width: number, height: number): CanvasImageSource | null;
  /** Unmount every instance not in `live`. */
  release(live: ReadonlySet<string>): void;
  /** Unmount one instance, if it is mounted. */
  unmount(instanceId: string): void;
}
