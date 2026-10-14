/**
 * Render Lottie animations to PNG frames, in a hidden Electron window.
 *
 *     electron scripts/cloud/gifs/lottieFrames.cjs <job.json>
 *
 * `job.json`: { lottieWeb, size, fps, items: [{ json, outDir }] }. Each item's
 * frames are written as `outDir/0000.png`, ... with transparency, one loop of
 * the animation at `fps`. Run by `fetchMeteocons.ts`, which turns the frames
 * into a GIF with the bundled ffmpeg.
 *
 * lottie-web's canvas renderer draws a frame synchronously in `goToAndStop`,
 * so a frame is read straight off the canvas: no compositor, no timing, and
 * the same pixels on every run. The window is never shown.
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const job = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], "utf8"));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: job.size,
    height: job.size,
    webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false },
  });
  await win.loadURL("data:text/html,<!doctype html><canvas id=c></canvas>");
  await win.webContents.executeJavaScript(fs.readFileSync(job.lottieWeb, "utf8"));

  let done = 0;
  let failed = 0;
  for (const item of job.items) {
    try {
      const data = fs.readFileSync(item.json, "utf8");
      const frames = await win.webContents.executeJavaScript(`(() => {
        const data = ${data};
        const size = ${job.size};
        const fps = ${job.fps};
        const canvas = document.getElementById("c");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        const anim = lottie.loadAnimation({
          renderer: "canvas",
          loop: false,
          autoplay: false,
          animationData: data,
          rendererSettings: { context, clearCanvas: true, preserveAspectRatio: "xMidYMid meet" },
        });
        const first = data.ip ?? 0;
        const count = Math.max(1, Math.round(((data.op - first) / data.fr) * fps));
        const out = [];
        for (let i = 0; i < count; i++) {
          context.clearRect(0, 0, size, size);
          anim.goToAndStop(first + (i * data.fr) / fps, true);
          out.push(canvas.toDataURL("image/png").slice("data:image/png;base64,".length));
        }
        anim.destroy();
        return out;
      })()`);
      fs.mkdirSync(item.outDir, { recursive: true });
      frames.forEach((frame, index) => {
        fs.writeFileSync(path.join(item.outDir, `${String(index).padStart(4, "0")}.png`), Buffer.from(frame, "base64"));
      });
    } catch (error) {
      failed++;
      console.error(`failed ${item.json}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (++done % 50 === 0) {
      console.log(`rendered ${done}/${job.items.length}`);
    }
  }
  console.log(`rendered ${done - failed}, failed ${failed}`);
  app.exit(failed > 0 ? 1 : 0);
});
