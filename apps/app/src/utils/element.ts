// Element classification now lives in the unified rendering engine so preview
// and export share one implementation. This module keeps the historical
// `elementUtils` shape for existing call-sites and re-exports the engine's
// `getElementType`.
import { getElementType } from "@nugget/preview-engine";

const elementUtils = {
  getElementType,
};

export { elementUtils, getElementType };
