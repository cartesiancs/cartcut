import type { ImageElementType } from "../../@types/timeline";
import type { ElementRenderFunction } from "./type";

import { loadedAssetStore } from "../asset/loadedAssetStore";

export const renderImage: ElementRenderFunction<ImageElementType> = (
  ctx,
  elementId,
  imageElement,
  timelineCursor,
) => {
  const { width, height } = imageElement;
  const loadedImage = loadedAssetStore
    .getState()
    .getImage(imageElement.localpath);

  if (loadedImage == null) {
    // Can render skeleton here
    return;
  }

  // One `drawImage` filling `0,0,w,h`, and nothing else: the border, the
  // shadow and the rounded corners are drawn around this by
  // `element.ts#drawDirect`, in box space, because the crop's scale is already
  // on the context here and an outline traced under it would miss the box.
  ctx.drawImage(loadedImage, 0, 0, width, height);
};
