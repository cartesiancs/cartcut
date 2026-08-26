const elementUtils = {
  getElementType(filetype): "undefined" | "static" | "dynamic" {
    let elementType: any = "undefined";
    const elementFileExtensionType = {
      // A group carries no source file, so it is "static" in the only sense
      // this function means: it has no `trim` window and no `speed`.
      //
      // Effects and transitions are static for the same reason. An overlay
      // effect does play a video file, but it loops rather than addressing a
      // window of it — `renderer/fx/overlayTime.ts` owns that arithmetic — so
      // it has no `trim` for `geometry.ts` to reason about either. Listing them
      // matters: an unlisted filetype returns "undefined", which is not
      // "dynamic" (so `isDynamicElement` happens to be right) but is also not
      // "static", and the call sites that test for "static" explicitly would
      // drop them silently.
      static: [
        "image",
        "text",
        "png",
        "jpg",
        "jpeg",
        "gif",
        "shape",
        "group",
        "effect",
        "transition",
      ],
      dynamic: ["video", "audio", "mp4", "mp3", "mov"],
    };

    for (const type in elementFileExtensionType) {
      if (Object.hasOwnProperty.call(elementFileExtensionType, type)) {
        const extensionList = elementFileExtensionType[type];

        if (extensionList.indexOf(filetype) >= 0) {
          elementType = type;
          break;
        }
      }
    }

    return elementType;
  },
};

export { elementUtils };
