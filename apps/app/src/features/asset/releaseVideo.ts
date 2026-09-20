/**
 * Letting go of a `<video>`, properly.
 *
 * One definition, because there are now two callers with the same hazard and a
 * second copy is a second chance to get it wrong. `hoverPreviewOverlay.ts`
 * reuses a single element for every preview; `thumbnailCapture.ts` creates one
 * per file and throws it away. Both have to actually release the decoder.
 *
 * Chromium caps `WebMediaPlayer` at 75 per frame and each one costs roughly
 * 30-80MB, the measurement `decoderWindow.ts` opens with. A handle left loaded
 * is not merely memory: it is one of 75, and the ones the timeline needs are
 * drawn from the same pool.
 */

/** Stop decoding. Without this a 120fps 3600x2338 file keeps a decoder alive. */
export function releaseVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("poster");
  video.removeAttribute("src");
  // `load()` is what actually releases the player; clearing `src` alone leaves
  // the previous resource loaded.
  video.load();
}
