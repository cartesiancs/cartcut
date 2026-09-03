import { path } from "../functions/path";
import mime from "../functions/mime";
import { getLocationEnv } from "../functions/getLocationEnv";

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
      });
  }

  // `addVideoWithDuration`/`addAudioWithDuration` lived here for the two
  // recorders. Both now go through `features/record/saveRecording.ts` and the
  // shared import path, which builds the `file://` localpath these two were
  // missing and skips the whole-file `fetch` they made for an `element.blob`
  // nothing reads.
}
