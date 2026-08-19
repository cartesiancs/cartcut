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

  public addVideoWithDuration(originPath, duration) {
    const filepath = path.encode(originPath);
    fetch(`file://${filepath}`)
      .then((res) => {
        return res.blob();
      })
      .then((blob) => {
        let blobUrl = URL.createObjectURL(blob);
        let blobType = mime.lookup(filepath).type;
        let control: any = document.querySelector("element-control");

        control.addVideoWithDuration(blobUrl, filepath, duration);
      });
  }

  public addAudioWithDuration(originPath, duration) {
    const filepath = path.encode(originPath);
    fetch(`file://${filepath}`)
      .then((res) => {
        return res.blob();
      })
      .then((blob) => {
        let blobUrl = URL.createObjectURL(blob);
        let blobType = mime.lookup(filepath).type;
        let control: any = document.querySelector("element-control");

        control.addAudioWithDuration(blobUrl, filepath, duration);
      });
  }

}
