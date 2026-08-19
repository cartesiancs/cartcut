import directory from "./functions/directory";
import mime from "./functions/mime";
import project from "./functions/project";
import fonts from "./functions/fonts";
import { loadedAssetStore } from "./features/asset/loadedAssetStore";
import { enableIpcWrapper } from "./functions/ipcWrapper";

enableIpcWrapper();

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
import "./features/menu/menuDropdown";

import "./features/animation/animationPanel";

import "./features/option/optionGroup";
import "./features/option/optionText";
import "./features/option/optionImage";
import "./features/option/optionVideo";
import "./features/option/optionAudio";
import "./features/option/optionShape";

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
export { directory, mime, project, fonts, loadedAssetStore };
