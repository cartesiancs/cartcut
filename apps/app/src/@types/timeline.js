"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.animatableProperties = exports.canAnimate = exports.isVisualTimelineElement = void 0;
function isVisualTimelineElement(element) {
    return element.filetype !== "audio";
}
exports.isVisualTimelineElement = isVisualTimelineElement;
function canAnimate(element) {
    // GIF and audio have no `animation` field, so offering a keyframe editor for
    // them opens a panel with nothing to edit. The old check gated on "static and
    // not text", which let GIF through and kept video out — backwards on both.
    return (element.filetype === "image" ||
        element.filetype === "video" ||
        element.filetype === "text" ||
        element.filetype === "shape");
}
exports.canAnimate = canAnimate;
/**
 * Which properties an element can actually animate.
 *
 * Shape is `OpacityAnimatable` only — its type carries no position, scale or
 * rotation tracks, so those keyframes would have nowhere to live.
 */
function animatableProperties(element) {
    if (!canAnimate(element)) {
        return [];
    }
    if (element.filetype === "shape") {
        return ["opacity"];
    }
    return ["position", "opacity", "scale", "rotation"];
}
exports.animatableProperties = animatableProperties;
//# sourceMappingURL=timeline.js.map