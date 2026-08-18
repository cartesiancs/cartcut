const elementUtils = {
  getElementType(filetype): "undefined" | "static" | "dynamic" {
    let elementType: any = "undefined";
    const elementFileExtensionType = {
      static: ["image", "text", "png", "jpg", "jpeg", "gif", "shape"],
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
