const path = {
  /**
   * Escape `#`, which a `file://` URL would otherwise read as a fragment.
   *
   * The guard is not decoration. This threw a `TypeError` for two Electron
   * majors — `File.path` was removed in v32, so a dropped file arrived here as
   * `undefined` — and because the caller's `catch` was empty, the only symptom
   * was that dropping a file did nothing at all. Coercing means a future
   * caller with nothing to give gets an empty path and a real error further
   * down, where something reports it.
   */
  encode: function (uri) {
    if (typeof uri !== "string") {
      return "";
    }
    // A regex rather than `replaceAll`: the renderer's `lib` predates ES2021,
    // and this only compiled before because `uri` was an implicit `any`.
    return uri.replace(/#/g, "%23");
  },
};

export { path };
