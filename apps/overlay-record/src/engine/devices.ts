/**
 * What is plugged in.
 *
 * One wrinkle, and it shapes the whole module: **`enumerateDevices` reports
 * every label as an empty string until the page has been granted access to that
 * kind of device at least once.** It is a fingerprinting guard, it is in every
 * Chromium, and it means a first-run tray menu lists "", "" and "" unless
 * something has already opened a stream.
 *
 * So `primeLabels` opens one and closes it immediately. That is a real
 * permission prompt on macOS, which is why it happens when the recorder is
 * opened rather than on the first frame of a take: a prompt in front of
 * somebody who has already started talking is a lost take, and a prompt while
 * they are still choosing a camera is just the prompt.
 */

export type MediaDevice = { deviceId: string; label: string };

export type Devices = {
  cameras: MediaDevice[];
  microphones: MediaDevice[];
};

export const noDevices: Devices = { cameras: [], microphones: [] };

/**
 * Open and immediately release a stream of each kind, so labels come back.
 *
 * Failures are swallowed on purpose. A machine with no camera, or a user who
 * says no, still gets a working screen recorder — the device list is simply
 * shorter, and `trayModel.ts#deviceLabel` invents names for whatever remains
 * unlabelled.
 */
export async function primeLabels(): Promise<void> {
  for (const constraints of [{ video: true }, { audio: true }]) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // No such device, or access declined. Both are ordinary.
    }
  }
}

export async function enumerate(): Promise<Devices> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    const of = (kind: MediaDeviceKind): MediaDevice[] =>
      devices
        .filter((device) => device.kind === kind && device.deviceId !== "")
        // Chromium reports a synthetic `"default"` entry on some platforms that
        // duplicates whichever device is default. Listing it means the same
        // microphone appears twice under two ids, and the radio group then has
        // two ticks or none.
        .filter((device) => device.deviceId !== "default")
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
        }));

    return {
      cameras: of("videoinput"),
      microphones: of("audioinput"),
    };
  } catch (error) {
    console.warn("[record] could not enumerate devices", error);
    return noDevices;
  }
}
