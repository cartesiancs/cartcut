import { stat } from "node:fs/promises";

/**
 * Refuses to publish a macOS update zip that Squirrel.Mac cannot install.
 *
 * Squirrel fetches the zip with `+[NSURLConnection rac_sendAsynchronousRequest:]`,
 * which buffers the entire body in one CFData and only then writes it to disk.
 * CFData grows by doubling, so a body one byte past 1 GiB asks for a 2 GiB
 * realloc, and Chromium's allocator refuses any single allocation that large:
 * it calls IMMEDIATE_CRASH, and the app dies with EXC_BREAKPOINT partway
 * through installing. There is no error event, no log line and nothing the
 * user can do; the update button simply kills the app every time.
 *
 * Measured on 2026-09-20 from a 0.5.7 crash report: the CFData was at a 1 GiB
 * capacity holding 1 GiB + 64 KiB and asked for 0x80000000. 0.5.8's arm64 zip
 * is 1.0312 GiB and always crashes. 0.5.7's was 0.9934 GiB and installs.
 *
 * The zip is the only artifact with a limit. A dmg is fetched by the browser
 * and Windows does not use Squirrel.Mac.
 *
 * This runs before `artifactCreated`, which is what starts the upload, so a
 * failure here keeps the broken zip off the release rather than reporting it
 * after users can reach it.
 */
const SQUIRREL_BUFFER_LIMIT = 1024 * 1024 * 1024;

/** Below this, say so, because the headroom is the thing worth watching. */
const WARN_AT = SQUIRREL_BUFFER_LIMIT - 64 * 1024 * 1024;

export default async function artifactBuildCompleted(artifact) {
  const file = artifact?.file;
  if (typeof file !== "string" || !file.endsWith(".zip")) {
    return;
  }
  if (artifact?.packager?.platform?.name !== "mac") {
    return;
  }

  const { size } = await stat(file);
  const gib = (size / SQUIRREL_BUFFER_LIMIT).toFixed(4);

  if (size > SQUIRREL_BUFFER_LIMIT) {
    throw new Error(
      `${file} is ${size} bytes (${gib} GiB), over the ${SQUIRREL_BUFFER_LIMIT} ` +
        `byte ceiling Squirrel.Mac can install. Every macOS user who clicks ` +
        `Download would crash with EXC_BREAKPOINT. Shrink the app bundle ` +
        `(check package.json "files" against what is actually in the asar) ` +
        `and build again.`,
    );
  }

  const headroom = SQUIRREL_BUFFER_LIMIT - size;
  if (size > WARN_AT) {
    console.warn(
      `WARNING: ${file} is ${gib} GiB, only ${(headroom / 1048576).toFixed(1)} MB ` +
        `under the Squirrel.Mac install ceiling.`,
    );
  } else {
    console.log(
      `${file}: ${gib} GiB, ${(headroom / 1048576).toFixed(1)} MB under the ` +
        `Squirrel.Mac install ceiling.`,
    );
  }
}
