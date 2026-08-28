import { net } from "electron";

import { ffmpegConfig } from "./lib/ffmpeg.js";

import config from "./config.json";

import ffmpeg from "fluent-ffmpeg";

import log from "electron-log";

import fs from "fs";

import ProgressBar from "electron-progressbar";

// const FFMPEG_BIN_PATH = ffmpegConfig.FFMPEG_BIN_PATH;
const FFMPEG_PATH = ffmpegConfig.FFMPEG_PATH;
const FFPROBE_PATH = ffmpegConfig.FFPROBE_PATH;

export const validateFFmpeg = async () => {
  // let isCreate = await createFfmpegDir();

  fs.stat(FFMPEG_PATH, function (error, stats) {
    // if (error) {
    //   downloadFfmpeg("ffmpeg");
    //   return 0;
    // }

    fs.chmodSync(FFMPEG_PATH, 0o755);
    ffmpeg.setFfmpegPath(FFMPEG_PATH);

    log.info("FFMPEG downloaded successfully");
    log.info("FFMPEG binary size: " + stats.size);

    validateFFprobe();
  });
};

export const validateFFprobe = async () => {
  fs.stat(FFPROBE_PATH, function (error, stats) {
    // if (error) {
    //   downloadFfmpeg("ffprobe");
    //   return 0;
    // }

    fs.chmodSync(FFPROBE_PATH, 0o755);
    ffmpeg.setFfprobePath(FFPROBE_PATH);

    log.info("FFPROBE downloaded successfully.");
    log.info("FFPROBE binary size: " + stats.size);
  });
};

export const downloadFfmpeg = (binType) => {
  let type = binType || "ffmpeg"; // ffmpeg, ffprobe
  let receivedBytes = 0;
  let totalBytes = 0;
  let percentage = 0;
  let downloadPath = type == "ffmpeg" ? FFMPEG_PATH : FFPROBE_PATH;

  let progressBar = new ProgressBar({
    indeterminate: false,
    text: type + " 다운로드",
    detail: type + " 설치중...",
  });

  // Keyed by `platform-arch`, not platform alone: an Apple Silicon Mac and an
  // Intel one both report `darwin` and would otherwise be handed the same
  // x86_64 build, which is exactly the Rosetta trap `lib/ffmpeg.ts` avoids for
  // the bundled copy.
  const request = net.request(config.ffmpegBin[ffmpegConfig.TARGET][type].url);
  request.on("response", (response: any) => {
    totalBytes = parseInt(response.headers["content-length"]);
    response.pipe(fs.createWriteStream(downloadPath));

    response.on("data", (chunk) => {
      receivedBytes += chunk.length;
      percentage = Math.round((receivedBytes * 100) / totalBytes);

      if (!progressBar.isCompleted()) {
        progressBar.value = percentage;
      }
      log.info("ffmpeg download...", percentage);
    });
    response.on("end", () => {
      log.info(binType + " No more data in response.");
      fs.chmodSync(downloadPath, 0o755);

      if (type == "ffmpeg") {
        ffmpeg.setFfmpegPath(downloadPath);
      } else if (type == "ffprobe") {
        ffmpeg.setFfprobePath(downloadPath);
      }
    });
  });
  request.end();

  progressBar
    .on("completed", function () {
      if (binType == "ffmpeg") {
        validateFFprobe();
      }

      progressBar.detail = type + " 설치 완료";
    })
    .on("aborted", function (value) {
      log.info("Cancel ffmpeg installation.");
    })
    .on("progress", function (value) {
      progressBar.detail = `100% 중 ${value}% 완료...`;
    });
};
