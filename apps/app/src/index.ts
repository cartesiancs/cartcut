import mime from "./functions/mime";
import project from "./functions/project";
import fonts from "./functions/fonts";
import { loadedAssetStore } from "./features/asset/loadedAssetStore";
import { enableIpcWrapper } from "./functions/ipcWrapper";
import { watchOverlayRecordings } from "./features/record/saveRecording";
import {
  count as perfCount,
  installFrameStats,
} from "./features/debug/frameStats";
import { useTimelineStore } from "./states/timelineStore";
import { installProxyBridge } from "./features/proxy/proxyBridge";

enableIpcWrapper();

// A recording made in the recorder's own windows arrives here as a path, once,
// when it is finished. Subscribed before anything else mounts so a take that
// completes while the editor is still painting is not missed.
watchOverlayRecordings();

import "./App";

import "./features/preview/previewCanvas";

import "./features/asset/assetList";
import "./features/asset/assetBrowser";
import "./features/asset/assetUploader";

import "./features/element/elementTimelineLeftOption";

import "./features/element/elementTimeline";
import "./features/element/elementTimelineCanvas";

import "./features/element/elementTimelineRuler";
import "./features/element/elementTimelineCursor";
import "./features/element/elementControlAsset";
import "./features/element/elementTimelineRange";

import "./features/keyframe/keyframeEditor";
import "./features/proxy/proxyPanel";
import "./features/menu/menuDropdown";
import "./features/onboarding/onboardingOverlay";


import "./features/option/optionGroup";
import "./features/option/optionText";
import "./features/option/optionImage";
import "./features/option/optionVideo";
import "./features/option/optionAudio";
import "./features/option/optionShape";
import "./features/option/optionGroupElement";
import "./features/option/optionEffect";
import "./features/option/optionTransition";

import "./features/input/inputText";

import { Tutorial } from "./features/tutorial/tutorial";
import { TutorialPopover } from "./features/tutorial/tutorialPopover";

import { Toast } from "./features/toast/toast";
import { ToastBox } from "./features/toast/toastBox";
import "./context/timelineContext";

import "./sass/style.scss";

import "./ui/timeline/Timeline";
import "./ui/control/Control";
import "./ui/modal/Modal";
import "./ui/offcanvas/TimelineOptions";
import "./ui/toast/Toast";

import "./features/element/elementControl";
import "./features/font/selectFont";

import "./event";

// Imported for effect: this is what connects the editor to Claude Code. It
// must come after the components it drives, since a command may reach for
// `<element-control>` the moment the first tool call arrives.
import "./features/agent/bridge";

// `__cartcutPerf.on()` in the console starts it; nothing runs until it does.
// Installed after the components, so the counters it exposes are the ones those
// components already registered against.
installFrameStats();

// Reads the proxy index off disk and keeps it current. Nothing is generated
// here — this only learns what already exists, so a session with no proxies
// costs one IPC round trip.
installProxyBridge();

// One more subscriber, to count the subscribers.
//
// Every `useTimelineStore` listener is unfiltered — they all run on every write
// of any field — so one of them counting is a faithful measure of how often the
// whole set is woken. During playback this should equal the project's frame
// rate. Anything higher is a write that changed nothing, and the difference
// between this and `store.setCursor:changed` says so directly.
useTimelineStore.subscribe(() => perfCount("store.notify"));

customElements.define("tutorial-group", Tutorial);
customElements.define("tutorial-popover", TutorialPopover);

customElements.define("toast-item", Toast);
customElements.define("toast-box", ToastBox);

/**
 * `loadedAssetStore` is exported for diagnostics.
 *
 * The media layer — which `<video>` is where, muted, playing — is the one part
 * of the editor that node tests cannot observe, and it is where the playback
 * bugs lived. Being able to ask the running app "is anything audible outside
 * its own clip?" is what turns those into a checkable question rather than a
 * listening exercise. The filmstrip's `cachedTiles`/`failedPaths` counters
 * earned their keep the same way.
 */
export { mime, project, fonts, loadedAssetStore };

/**
 * The compositor and the stores it reads, exported for the same reason.
 *
 * `tests/e2e` drives the real app and then has to answer one question node
 * tests cannot: *does the frame in the exported file match the frame the app
 * would show?* Answering it means re-running the export's own per-frame work —
 * `seek`, then `renderTimelineAtTime` with `exportElementRenderers` and an
 * export FX runtime — at project resolution, and diffing that against the
 * decoded video. Screenshotting the visible preview canvas cannot stand in for
 * it: that canvas is device-sized, carries the viewport's pan and zoom, and has
 * a dimmed pass, frame guides and selection chrome composited over it.
 *
 * Every name below is a re-export of a module the app already loads. There is
 * no test-only code path here, nothing branches on whether a test is attached,
 * and removing these lines would change no behaviour — which is the property
 * that makes exposing them acceptable at all.
 */
export { useTimelineStore } from "./states/timelineStore";
export { renderOptionStore } from "./states/renderOptionStore";
export { selectionStore } from "./states/selectionStore";
export { previewViewportStore } from "./states/previewViewportStore";
export { proxyStore } from "./states/proxyStore";
export { renderTimelineAtTime } from "./features/renderer/timeline";
export { exportElementRenderers } from "./features/export/renderers";
export {
  createExportFxRuntime,
  previewFxRuntime,
} from "./features/renderer/fx/createRuntime";
export { frameCount, frameTimeMs } from "./features/export/frames";
// Re-reading the preset folders, for the one thing a spec cannot otherwise
// reach: whether a LUT a *user* dropped into `userData/presets` is picked up by
// the real scanner, validated by the real validator and graded by the real
// renderer. Everything else about importing — the file dialog, the copy, the
// generated manifest — is main-process work with its own suite; this is the
// half that has to be proved end to end.
export { loadPresets, presetsOfKind } from "./features/fx/presetRegistry";
export { preloadLutsForDocument } from "./features/lut/lutRegistry";
