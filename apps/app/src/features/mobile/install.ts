import { getLocationEnv } from "../../functions/getLocationEnv";
import { uiStore } from "../../states/uiStore";
import { selectionStore } from "../../states/selectionStore";
import {
  wantsMobileLayout,
  wantsTouchBridge,
  type LayoutProbe,
} from "./mobileLayout";
import { installTouchBridge } from "./touchBridge";
import { EDITOR_TOUCH_SURFACES } from "./touchSurfaces";

function probe(): LayoutProbe {
  return {
    env: getLocationEnv(),
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    touchCapable:
      (navigator.maxTouchPoints ?? 0) > 0 || "ontouchstart" in window,
    width: window.innerWidth,
    height: window.innerHeight,
    search: window.location.search,
  };
}

/**
 * Decided once, when the bundle evaluates, and read by `App` to choose its
 * template. Rotating a phone never crosses it (it is keyed on the short side),
 * and switching the whole editor tree under a live document would remount the
 * preview, the decoders and every panel's local state.
 */
export const MOBILE_LAYOUT: boolean =
  typeof window !== "undefined" && wantsMobileLayout(probe());

/** Track headers on a phone, in px: the floor `uiStore` allows. */
const MOBILE_TRACK_HEADER_PX = 120;

export function installMobile(): void {
  if (wantsTouchBridge(probe())) {
    installTouchBridge(document, EDITOR_TOUCH_SURFACES);
  }

  if (!MOBILE_LAYOUT) {
    return;
  }

  document.documentElement.classList.add("mobile-layout");

  // `viewport-fit=cover` so the safe-area insets the stylesheet pads with are
  // reported at all, and a fixed scale so iOS neither zooms the page into a
  // focused field nor lets a pinch that missed a surface scale the whole
  // editor. Set here rather than in index.html so the desktop page keeps the
  // viewport it has always had.
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover",
    );
  // After the first render rather than now. The timeline's components seed
  // their copy from `uiStore.getInitialState()`, which a write made before they
  // exist never reaches; they only hear the change once they are subscribed.
  // Lit's renders are microtasks, so a task is after all of them.
  setTimeout(() => {
    uiStore
      .getState()
      .updateTimelineVertical(MOBILE_TRACK_HEADER_PX, window.innerWidth);
  }, 0);

  document.addEventListener("preview-pick", (event) => {
    const elementId = (event as CustomEvent<{ elementId?: string }>).detail
      ?.elementId;
    if (typeof elementId !== "string" || elementId === "") {
      return;
    }
    // After the press has finished bubbling: the timeline clears its
    // selection on any `mousedown` outside itself, and that listener sits on
    // the document, so it runs after this one and would undo the pick.
    queueMicrotask(() => {
      const selection = selectionStore.getState();
      if (!selection.ids.includes(elementId)) {
        selection.setIds([elementId]);
        (document.querySelector("element-timeline-canvas") as any)?.drawCanvas?.();
      }
    });
  });

  // The on-screen keyboard and the browser's collapsing toolbars both resize
  // the visual viewport without always resizing the layout one. `--m-vh` is the
  // height the shell actually has, so the toolbar is never pushed under the
  // browser's own chrome.
  const sync = () => {
    const height = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty("--m-vh", `${height}px`);
  };
  sync();
  window.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("resize", sync);
}
