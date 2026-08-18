"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.elementUtils = void 0;
const elementUtils = {
    getElementType(filetype) {
        let elementType = "undefined";
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
exports.elementUtils = elementUtils;
//# sourceMappingURL=element.js.map