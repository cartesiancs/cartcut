import { path } from "../functions/path";
import mime from "../functions/mime";
import { getLocationEnv } from "../functions/getLocationEnv";
import { beginMediaLoad } from "../states/mediaLoadStore";

/** Inserts an asset into the timeline. Directory browsing lives in
 * `features/asset/assetBrowser.ts`. */
export class AssetController {
  public add(originPath) {
    const nowEnv = getLocationEnv();
    const filepath =
      nowEnv == "electron"
        ? `file://${path.encode(originPath)}`
        : `/api/file?path=${path.encode(originPath)}`;

    const fileorgpath =
      nowEnv == "electron"
        ? `file://${path.encode(originPath)}`
        : `${path.encode(originPath)}`;

    // Up on the click, not on the probe. The fetch below reads the whole file
    // into memory before anything is measured, which for a screen recording is
    // the longest part of the import and used to happen with nothing on screen
    // at all. Each `add*` raises its own count before this one is released, so
    // the two windows overlap and the bar never blinks between them.
    const release = beginMediaLoad();

    fetch(`${filepath}`)
      .then((res) => {
        return res.blob();
      })
      .then((blob) => {
        let blobUrl = URL.createObjectURL(blob);
        let blobType = mime.lookup(fileorgpath).type;
        let control: any = document.querySelector("element-control");

        if (blobType == "image") {
          control.addImage(blobUrl, fileorgpath);
        } else if (blobType == "video") {
          control.addVideo(blobUrl, fileorgpath);
        } else if (blobType == "audio") {
          control.addAudio(blobUrl, fileorgpath);
        } else if (blobType == "gif") {
          control.addGif(blobUrl, fileorgpath);
        }
      })
      .finally(release)
      .catch((error) => {
        // There was no handler here at all, so an unreadable file left the
        // click with no clip, no message and an unhandled rejection.
        console.error("[asset] could not read", originPath, error);
      });
  }

  // `addVideoWithDuration`/`addAudioWithDuration` lived here for the two
  // recorders. Both now go through `features/record/saveRecording.ts` and the
  // shared import path, which builds the `file://` localpath these two were
  // missing and skips the whole-file `fetch` they made for an `element.blob`
  // nothing reads.
}
