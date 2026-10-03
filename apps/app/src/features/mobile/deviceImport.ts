import { atPlayhead, importPathsAt } from "../asset/importDrop";

/**
 * Media from the phone's own library, onto the timeline at the playhead.
 *
 * A browser build has no file system to browse and a phone has nothing to drag
 * from, so this is the only way a phone user's own clip gets into the editor.
 * Each picked `File` becomes an object URL, which the web build's media layer
 * loads as it is (`mediaProbe.ts#toLocalPath` passes `blob:` through), and then
 * takes the same `importPathsAt` a desktop drop takes: one probe per file and
 * one undo step for the lot.
 */

/** What the picker offers; the same three kinds `probeMedia` can render. */
export const DEVICE_MEDIA_ACCEPT = "video/*,image/*,audio/*";

const EXTENSION_FOR_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
};

/**
 * The path a picked file is imported under.
 *
 * Everything downstream decides what a file is from its extension
 * (`mediaElement.ts#mediaKindOf`), and an object URL has none. So the file's
 * name rides along as the URL's fragment, which loading ignores and the
 * extension test reads. The name is reduced to one path segment with no `#` or
 * `?`, so it can neither end the fragment nor be read as a folder, and a name
 * without an extension (some phone pickers hand over `image` or `video`) is
 * given the one its MIME type implies.
 */
export function deviceMediaPath(objectUrl: string, name: string, type: string): string {
  let safe = name.replace(/[#?/\\]/g, "_").trim();
  if (safe === "") {
    safe = "media";
  }
  if (!/\.[a-z0-9]{2,5}$/i.test(safe)) {
    const extension = EXTENSION_FOR_TYPE[type.toLowerCase()];
    if (extension != null) {
      safe = `${safe}.${extension}`;
    }
  }
  return `${objectUrl}#${safe}`;
}

/** Open the system picker and import whatever comes back. */
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
      if (files.length === 0) {
        return;
      }
      const paths = files.map((file) =>
        deviceMediaPath(URL.createObjectURL(file), file.name, file.type),
      );
      void importPathsAt(paths, atPlayhead()).catch((error) => {
        console.error("[mobile] could not import picked files", error);
        (document.querySelector("toast-box") as any)?.showToast({
          message: "Those files could not be added.",
          delay: "3000",
        });
      });
    },
    { once: true },
  );
  // Attached before the click: iOS Safari ignores `click()` on an input that
  // is not in the document.
  document.body.appendChild(input);
  input.click();
}
