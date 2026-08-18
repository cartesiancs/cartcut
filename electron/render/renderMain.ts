import ffmpeg from "fluent-ffmpeg";
import isDev from "electron-is-dev";
import log from "electron-log";
import { ffmpegConfig } from "../lib/ffmpeg";

let resourcesPath = "";
let elementCounts = {
  video: 1,
  audio: 0,
};
let mapAudioLists: any = [];
import { mainWindow } from "../main.js";
import { renderUtil } from "./renderUtil";

if (isDev) {
  resourcesPath = ".";
} else {
  if (process.platform == "darwin") {
    resourcesPath = process.resourcesPath;
  } else if (process.platform == "win32") {
    resourcesPath = process.resourcesPath.split("\\").join("/");
  } else {
    resourcesPath = process.resourcesPath;
  }
}

type OptionType = {
  videoDuration: number;
  videoDestination: string;
  videoDestinationFolder: string;
  videoBitrate: number;
  previewRatio: string;
  previewSize: {
    w: string;
    h: string;
  };
};

export const renderMain = {
  start: (evt, elements, options: OptionType) => {
    const ffmpegPath = ffmpegConfig.FFMPEG_PATH;
    const ffprobePath = ffmpegConfig.FFPROBE_PATH;

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    log.info("[render] ===== Render starting... =====");
    if (isDev) {
      log.info("[render] ===== Render elements =====");
      log.info("elements:", JSON.stringify(elements));
    }

    elementCounts.video = 1;
    elementCounts.audio = 0;

    // let resizeRatio = options.previewRatio;
    let mediaFileLists = ["image", "video", "gif"];
    let textFileLists = ["text"];
    let audioFileLists = ["audio"];

    let filter: any = [];
    let command = ffmpeg();
    command
      .input(`${resourcesPath}/assets/images/background.png`)
      .loop(options.videoDuration);

    filter.push(`[0:v]fps=60, setpts=N/(60*TB)[background]`);

    filter.push({
      filter: "scale",
      options: {
        w: parseInt(options.previewSize.w),
        h: parseInt(options.previewSize.h),
      },
      inputs: "[background]",
      outputs: "tmp",
    });

    for (const key in elements) {
      if (Object.hasOwnProperty.call(elements, key)) {
        const element = elements[key];

        let isMedia = mediaFileLists.indexOf(element.filetype) >= 0;
        let isText = textFileLists.indexOf(element.filetype) >= 0;
        let isAudio = audioFileLists.indexOf(element.filetype) >= 0;

        if (isMedia) {
          renderFilter.addFilterMedia({
            element: element,
            command: command,
            filter: filter,
            projectOptions: options,
          });
        } else if (isText) {
          renderFilter.addFilterText({
            element: element,
            command: command,
            filter: filter,
            projectOptions: options,
          });
        } else if (isAudio) {
          renderFilter.addFilterAudio({
            element: element,
            command: command,
            filter: filter,
            projectOptions: options,
          });
        }
      }
    }

    evt.sender.send("PROCESSING", 0);

    let videoDurationMs = options.videoDuration * 1000;
    let estimatedTime = renderUtil.calculateEstimatedTime(videoDurationMs);
    let estimatedTimeDecrease = estimatedTime;

    let estimatedTimeInterval = setInterval(() => {
      if (estimatedTimeDecrease <= 0) {
        estimatedTimeDecrease += 1000;
      }
      estimatedTimeDecrease -= 500;
      evt.sender.send(
        "PROCESSING",
        ((estimatedTime - estimatedTimeDecrease) / estimatedTime) * 100,
      );
    }, 500);

    let filterLists = ["tmp"];

    if (elementCounts.audio != 0) {
      //filterLists.push('audio')
    }

    if (elementCounts.audio != 0) {
      let inputsAudio = mapAudioLists
        .map((element) => {
          return `[${element}]`;
        })
        .join("");

      log.info("[render] Map Audio Lists", mapAudioLists);
      log.info("[render] Inputs Audio", inputsAudio);

      filterLists.push("audio");

      filter.push({
        filter: "amix",
        options: {
          inputs: mapAudioLists.length,
          duration: "longest",
          dropout_transition: 0,
        },
        inputs: inputsAudio,
        outputs: `audio`,
      });
    }

    command.complexFilter(filter, filterLists);
    command.outputOptions(["-map tmp?"]);

    command.output(options.videoDestination);
    command.audioCodec("aac");
    command.videoCodec("libx264");
    command.outputFps(60);
    command.outputOptions("-framerate 60");

    command.videoBitrate(options.videoBitrate);
    command.format("mp4");
    command.run();

    command.on("end", function () {
      clearInterval(estimatedTimeInterval);
      evt.sender.send("PROCESSING_FINISH");
      console.log("Finished processing");
      command.kill();
      mapAudioLists = [];
    });

    command.on("error", function (err, stdout, stderr) {
      log.info("Render Error", err.message);
      evt.sender.send("PROCESSING_ERROR", err.message);
      process.crash();
      mapAudioLists = [];
    });
  },

  combineFrame: async (event, outputDir, elementId) => {
    let isFinish = false;
    let command = ffmpeg();
    let outputVideoPath = `${outputDir}/${elementId}.webm`;

    command.input(`${outputDir}/frame-${elementId}-%04d.png`);
    command.inputFPS(60);
    command.inputOptions("-framerate 60");
    command.videoCodec("libvpx-vp9");
    command.inputOptions("-pix_fmt yuva420p");
    command.outputFps(60);
    command.outputOptions("-framerate 60");

    command.format("webm");
    command.output(outputVideoPath);
    command.on("end", function () {
      log.info("combineFrame Finish processing");
      mainWindow.webContents.send("FINISH_COMBINE_FRAME", elementId);
      isFinish = true;
      return isFinish;
    });

    command.on("error", function (err, stdout, stderr) {
      log.info("combineFrame Render Error", err.message);
      return isFinish;
    });

    command.run();
  },

  extractAudioFromVideo: async (event, outputAudio, videoPath) => {
    let command = ffmpeg();
    let outputAudioPath = outputAudio;

    command
      .input(`${videoPath}`)
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioFrequency(44100)
      .audioChannels(2);

    const timeInterval = setInterval(() => {
      event.sender.send("ffmpeg:extractAudioFromVideo:progress", "progress");
    }, 200);

    command.format("wav");
    command.output(outputAudioPath);
    command.on("end", function () {
      clearInterval(timeInterval);

      log.info("extractAudioFromVideo Finish processing");
      event.sender.send("ffmpeg:extractAudioFromVideo:finish", outputAudioPath);
    });

    command.on("error", function (err, stdout, stderr) {
      log.info("combineFrame Render Error", err.message);
    });

    command.run();
  },
};

export const renderFilter = {
  addFilterMedia: (object) => {
    let staticFiletype = ["image", "gif"];
    let dynamicFiletype = ["video"];
    let checkStaticCondition =
      staticFiletype.indexOf(object.element.filetype) >= 0;
    let checkDynamicCondition =
      dynamicFiletype.indexOf(object.element.filetype) >= 0;

    let isExistAudio = object.element.isExistAudio;

    let options = {
      width: String(object.element.width),
      height: String(object.element.height),
      x: String(object.element.location.x),
      y: String(object.element.location.y),
      startTime: object.element.startTime / 1000,
      endTime: object.element.startTime / 1000 + object.element.duration / 1000,
      rotationRadian: (object.element.rotation * Math.PI) / 180,
      rotationDegree: object.element.rotation,
      opacity: object.element.opacity,
    };

    if (checkStaticCondition) {
      log.info("[render] ", object.element.filetype);

      if (object.element.filetype == "gif") {
        log.info("[render gif] ", object.element.filetype);

        object.command
          .input(object.element.localpath)
          .inputOptions(`-stream_loop -1`)
          .inputOptions(`-ignore_loop 0`);
      } else {
        object.command.input(object.element.localpath);
      }
    }

    if (checkDynamicCondition) {
      // `trim` is a window into the source file measured in source ms, so `-ss`
      // takes it unscaled and `-t` takes `duration`, which is that window's
      // length. `-itsoffset` is purely the clip's timeline position. The
      // previous code scaled `-ss` by speed and folded the trim into the
      // offset, which seeked to the wrong frame and pushed the clip late; only
      // the silent branch passed `-t` at all, which is the "끝 부분 자르기
      // 버그" the old note here referred to.
      const speed = object.element.speed > 0 ? object.element.speed : 1;

      object.command
        .input(object.element.localpath)
        .inputOptions(`-ss ${object.element.trim.startTime / 1000}`)
        .inputOptions(`-itsoffset ${object.element.startTime / 1000}`)
        .inputOptions(`-t ${object.element.duration / 1000}`);

      if (isExistAudio != true && object.element.codec.video != "default") {
        object.command.inputOptions(`-vcodec ${object.element.codec.video}`);
      }

      options.startTime = object.element.startTime / 1000;
      options.endTime =
        object.element.startTime / 1000 +
        object.element.duration / speed / 1000;
    }

    object.filter.push({
      filter: "scale",
      options: {
        w: options.width,
        h: options.height,
      },
      inputs: `[${elementCounts.video}:v]`,
      outputs: `image${elementCounts.video}`,
    });

    // if (checkDynamicCondition) {
    //   object.filter.push(
    //     `[image${elementCounts.video}]tpad=start_duration=${options.startTime},setpts=PTS/${object.element.speed}[image${elementCounts.video}]`,
    //   );
    // }

    // NOTE: 회전시 사분면 사이드 잘림
    // object.filter.push(
    //   `[image${elementCounts.video}]rotate=${options.rotationRadian}:c=none[image${elementCounts.video}]`,
    // );

    if (checkStaticCondition) {
      object.filter.push(
        `[image${elementCounts.video}]format=argb,geq=r='r(X,Y)':a='${
          options.opacity / 100
        }*alpha(X,Y)'[image${elementCounts.video}]`,
      );
    }

    // 해당 코드를 삽입하면 itsoffset이 동작하지 못함. 쓰지 말 것.
    // object.filter.push(
    //   `[image${elementCounts.video}]fps=60, setpts=N/(60*TB)[image${elementCounts.video}]`,
    // );

    //:ow=rotw(${options.rotationRadian}):oh=roth(${options.rotationRadian})

    object.filter.push({
      filter: "overlay",
      options: {
        enable: `between(t,${options.startTime},${options.endTime})`,
        x: `${Number(options.x)}`, // +((t-1)*85) + ${Math.min(0, options.height*Math.sin(options.rotationDegree))}
        y: `${Number(options.y)}`, //  + ${Math.min(0, options.width*Math.sin(options.rotationDegree))}
      },
      inputs: `[tmp][image${elementCounts.video}]`,
      outputs: `tmp`,
    });

    elementCounts.video += 1;

    if (isExistAudio == true) {
      renderFilter.addFilterAudio(object);
    }
  },

  addFilterText: (object) => {
    let updateResourcesPath =
      process.platform == "win32" ? resourcesPath.substring(2) : resourcesPath;
    if (isDev) {
      updateResourcesPath = ".";
    }
    let fontPath =
      object.element.fontpath == "default"
        ? `${updateResourcesPath}/assets/fonts/notosanskr-medium.otf`
        : process.platform == "win32"
        ? object.element.fontpath.substring(2)
        : object.element.fontpath;

    log.info("fontPath", fontPath);

    let options = {
      text: object.element.text,
      textcolor: object.element.textcolor,
      fontsize: object.element.fontsize,
      fontfile: fontPath,
      x: String(
        object.element.location.x +
          (object.element.width - object.element.widthInner) / 2,
      ),
      y: String(object.element.location.y),
      startTime: object.element.startTime / 1000,
      endTime: object.element.startTime / 1000 + object.element.duration / 1000,
    };

    object.filter.push({
      filter: "drawtext",
      options: {
        enable: `between(t,${options.startTime},${options.endTime})`,
        fontfile: options.fontfile,
        text: options.text,
        fontsize: options.fontsize,
        fontcolor: options.textcolor,
        x: options.x,
        y: options.y,
      },
      inputs: `[tmp]`,
      outputs: `tmp`,
    });
  },

  addFilterAudio: (object) => {
    let options = {
      startTime:
        object.element.startTime / 1000 + object.element.trim.startTime / 1000,
      trim: {
        start: object.element.trim.startTime / 1000,
      },
      duration:
        object.element.trim.endTime / 1000 -
        object.element.trim.startTime / 1000,
      endTime: object.element.startTime / 1000 + object.element.duration / 1000,
      speed: object.element.speed || 1,
    };

    object.command
      .input(object.element.localpath)
      .inputOptions(`-ss ${options.trim.start * options.speed}`)
      //.inputOptions(`-itsoffset ${options.startTime}`)
      // .seekInput(options.trim.start)
      .inputOptions(`-t ${options.duration}`);

    log.info(
      "[render] addFilterAudio ",
      object.element.localpath,
      elementCounts.video,
    );
    log.info("[render] options.startTime ", options.startTime * 1000);

    object.filter.push(
      `[${elementCounts.video}:a]atempo=${options.speed}[audio${elementCounts.video}]`,
    );

    object.filter.push(
      `[audio${elementCounts.video}]adelay=${options.startTime * 1000}|${
        options.startTime * 1000
      }[audio${elementCounts.video}]`,
    );

    mapAudioLists.push(`audio${elementCounts.video}`);

    elementCounts.audio += 1;
    elementCounts.video += 1;
  },
};
