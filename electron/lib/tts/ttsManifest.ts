/**
 * Exactly which files a working voice needs, and how to know they arrived.
 *
 * **No weights ship with the app.** `package.json#files` subtracts from a
 * default of `**\/*`, so any new top-level directory in the repo would be
 * packaged with no config change and no warning. 400MB of ONNX lives in
 * `userData` and is fetched on first use, which is also why the app never
 * redistributes the OpenRAIL-M weights: the user gets them from HuggingFace.
 *
 * No imports, so the manifest can be checked without Electron behind it.
 */

/**
 * The model revision, pinned.
 *
 * Part of the install path, so raising it downloads beside the old copy rather
 * than over it: a half-replaced model directory is a set of graphs that do not
 * agree with each other, and there is no version field inside an .onnx to
 * catch it. Also folded into the output cache key, so bumping this retires
 * every cached .wav without anyone having to remember to.
 */
export const MODEL_REVISION = "3cadd1ee6394adea1bd021217a0e650ede09a323";

/** Changes when our own inference changes in a way that alters the audio. */
export const ENGINE_VERSION = 1;

export const MODEL_REPO = "Supertone/supertonic-3";

/** Stated in the panel before the download starts. Weights are OpenRAIL-M. */
export const MODEL_LICENSE = "OpenRAIL-M";

export type ModelFile = {
  /** Path inside the install directory, always posix-separated. */
  path: string;
  bytes: number;
  sha256: string;
};

/**
 * The ten preset voices. There is no eleventh: the Voice Builder service that
 * authored custom styles shut down, so cloning is not available at any price.
 */
export const VOICE_IDS = [
  "F1", "F2", "F3", "F4", "F5",
  "M1", "M2", "M3", "M4", "M5",
] as const;

export type VoiceId = (typeof VOICE_IDS)[number];

export function isVoiceId(value: unknown): value is VoiceId {
  return (VOICE_IDS as readonly unknown[]).includes(value);
}

/**
 * Every file, with the size and digest it must have when it lands.
 *
 * The digests are what make a resumed download safe. A file that is present
 * but truncated has the right name and the wrong contents, and ONNX Runtime
 * reports that as a protobuf parse error a long way from the cause.
 */
export const MODEL_FILES: readonly ModelFile[] = [
  { path: "onnx/duration_predictor.onnx", bytes: 3700147,   sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db" },
  { path: "onnx/text_encoder.onnx",       bytes: 36416150,  sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
  { path: "onnx/vector_estimator.onnx",   bytes: 256534781, sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c" },
  { path: "onnx/vocoder.onnx",            bytes: 101424195, sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba" },
  { path: "onnx/unicode_indexer.json",    bytes: 277676,    sha256: "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f" },
  { path: "onnx/tts.json",                bytes: 8253,      sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09" },
  { path: "voice_styles/F1.json", bytes: 292046, sha256: "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2" },
  { path: "voice_styles/F2.json", bytes: 292423, sha256: "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6" },
  { path: "voice_styles/F3.json", bytes: 290794, sha256: "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab" },
  { path: "voice_styles/F4.json", bytes: 291808, sha256: "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b" },
  { path: "voice_styles/F5.json", bytes: 291479, sha256: "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d" },
  { path: "voice_styles/M1.json", bytes: 291748, sha256: "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b" },
  { path: "voice_styles/M2.json", bytes: 292055, sha256: "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50" },
  { path: "voice_styles/M3.json", bytes: 290198, sha256: "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b" },
  { path: "voice_styles/M4.json", bytes: 291522, sha256: "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303" },
  { path: "voice_styles/M5.json", bytes: 291469, sha256: "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2" },
];

/**
 * How much a set of files weighs.
 *
 * Callers that show or divide by a total take it from the list they are
 * actually working through rather than from the constant below. The two agree
 * in the app, and a progress bar that divided by a stale constant would read
 * as 0% for an entire download without anything failing.
 */
export function totalBytesOf(files: readonly ModelFile[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

/** What the panel says before asking for the download. */
export const MODEL_TOTAL_BYTES = totalBytesOf(MODEL_FILES);

/**
 * Where one file comes from.
 *
 * Pinned to the revision rather than to `main`: a branch that moves under us
 * would fail the digest check, which is the right outcome but a confusing one
 * to debug. This way the URL and the digest always describe the same bytes.
 */
export function downloadUrl(file: ModelFile): string {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file.path}`;
}
