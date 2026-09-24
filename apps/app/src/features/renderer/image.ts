import type { ImageElementType } from "../../@types/timeline";
import type { ElementRenderFunction } from "./type";

import { loadedAssetStore } from "../asset/loadedAssetStore";
import { boxOutline, paintDecoration } from "./decoration";

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

  // The silhouette is the box: this is one `drawImage` filling `0,0,w,h`, so a
  // shadow cast from the box is a shadow cast from the picture. A transparent
  // PNG therefore casts a rectangular shadow rather than a shaped one, which
  // is what a card wants and what every design tool's Drop Shadow on a frame
  // does — a shaped one would need the alpha channel and a second buffer.
  paintDecoration(ctx, imageElement, boxOutline(width, height), () => {
    ctx.drawImage(loadedImage, 0, 0, width, height);
  });
};
