const mime = {
  mimeArray: {
    png: {
      type: "image",
    },
    jpg: {
      type: "image",
    },
    jpeg: {
      type: "image",
    },
    webp: {
      type: "image",
    },
    gif: {
      type: "gif",
    },
    mp4: {
      type: "video",
    },
    mov: {
      type: "video",
    },
    avi: {
      type: "video",
    },
    wmv: {
      type: "video",
    },
    mpg: {
      type: "video",
    },
    mkv: {
      type: "video",
    },
    webm: {
      type: "video",
    },
    mp3: {
      type: "audio",
    },
    wav: {
      type: "audio",
    },
    m4a: {
      type: "audio",
    },
    // WebM holding sound only, what a browser's MediaRecorder writes for a
    // microphone (`record/saveRecording.ts`).
    weba: {
      type: "audio",
    },
    svg: {
      type: "image",
    },
  },
  lookup: function (filename) {
    const splitFilename = filename.split(".");

    if (splitFilename.length <= 1) {
      return { type: "unknown" };
    } else {
      const ext = splitFilename[splitFilename.length - 1];
      if (!ext) return { type: "unknown" };

      if (!this.mimeArray[ext.toLowerCase()]) {
        return { type: "unknown" };
      } else {
        return {
          type: this.mimeArray[ext.toLowerCase()].type,
        };
      }
    }
  },
};

export default mime;
