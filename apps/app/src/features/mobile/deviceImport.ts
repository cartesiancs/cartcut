import { pickedMediaPath } from "../asset/webMedia/mediaRegistry";
import { importedMediaStore } from "../asset/webMedia/importedMedia";
import { mobileStore } from "./mobileStore";

/**
 * Media from the device's own library, into the asset panel.
 *
 * A browser build has no file system to browse and a phone has nothing to drag
 * from, so a picker is how a browser user's own clip gets into the editor.
 * Each picked `File` becomes an object URL, which the web build's media layer
 * loads as it is (`mediaProbe.ts#toLocalPath` passes `blob:` through), and is
 * remembered in `mediaRegistry` so an export can read the file itself.
 *
 * It lands in the panel's Imported list (`importedMedia.ts`), not on the
 * timeline: from there a click or a drag places it through `importPathsAt`,
 * the same way a file in a desktop folder is placed, and it stays listed to
 * be placed again.
 */

/** What the picker offers; the same three kinds `probeMedia` can render. */
export const DEVICE_MEDIA_ACCEPT = "video/*,image/*,audio/*";

/** Kept under its old name; the rule itself lives beside the registry. */
export const deviceMediaPath = pickedMediaPath;

/**
 * Bring the Media tab forward, so what was just imported is in view.
 *
 * Through Bootstrap's `Tab` against the sidebar button that owns the pane, as
 * `mobileShell.ts#showPane` does, and on a phone as its sheet too: there the
 * column is off screen until a sheet shows it.
 */
function revealMediaPane(): void {
  const button = document.querySelector('#sidebar [data-bs-target="#nav-draft"]');
  if (button != null && typeof bootstrap !== "undefined") {
    bootstrap.Tab.getOrCreateInstance(button).show();
  }
  if (document.documentElement.classList.contains("mobile-layout")) {
    mobileStore.getState().open({ kind: "panel", pane: "nav-draft", title: "Media" });
  }
}

/** List files the browser handed over in the asset panel, and show it. */
export function importPickedFiles(
  picked: readonly { file: File; handle?: unknown }[],
): void {
  if (picked.length === 0) {
    return;
  }
  importedMediaStore.getState().add(picked);
  revealMediaPane();
}

/** Open the system picker and list whatever comes back. */
export function pickDeviceMedia(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = DEVICE_MEDIA_ACCEPT;
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener(
    "change",
    () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      importPickedFiles(files.map((file) => ({ file })));
    },
    { once: true },
  );
  // Attached before the click: iOS Safari ignores `click()` on an input that
  // is not in the document.
  document.body.appendChild(input);
  input.click();
}

/**
 * The desktop browser's picker: the File System Access API where there is one,
 * the `<input>` above where there is not (Safari, Firefox).
 *
 * The handle is kept with the file, so a later change can reopen it after a
 * reload with `requestPermission` instead of asking the user to find it again.
 */
export function pickWebMedia(): void {
  const open = (window as any).showOpenFilePicker;
  if (typeof open !== "function") {
    pickDeviceMedia();
    return;
  }
  void (async () => {
    let handles: any[];
    try {
      handles = await open.call(window, { multiple: true });
    } catch (error) {
      // The user pressed Cancel, which the API reports as an AbortError.
      if ((error as Error)?.name !== "AbortError") {
        console.error("[import] file picker failed", error);
      }
      return;
    }
    const picked = await Promise.all(
      handles.map(async (handle) => ({ file: (await handle.getFile()) as File, handle })),
    );
    importPickedFiles(picked);
  })();
}
