"use strict";
/**
 * Test-only helpers for the renderer suites.
 *
 * `@napi-rs/canvas` gives a real Skia 2D context in Node, so the renderers can
 * be exercised exactly as the browser runs them and asserted on actual pixels
 * rather than on recorded call sequences.
 *
 * The timeline element types are wide and fully required, so building one inline
 * per test buries the two or three fields a test actually cares about. These
 * factories supply a neutral element and take an override patch.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.audioElement = exports.textElement = exports.videoElement = exports.shapeElement = exports.gifElement = exports.imageElement = exports.inactiveAnimation = exports.points = exports.inkBounds = exports.pixel = exports.solid = exports.scene = void 0;
const canvas_1 = require("@napi-rs/canvas");
/** A canvas plus its 2D context, typed as the renderers expect. */
function scene(w, h, background) {
    const canvas = (0, canvas_1.createCanvas)(w, h);
    const ctx = canvas.getContext("2d");
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
    }
    return { canvas, ctx };
}
exports.scene = scene;
/** A solid-colour canvas usable as a `drawImage` source. */
function solid(w, h, color) {
    const c = (0, canvas_1.createCanvas)(w, h);
    const cx = c.getContext("2d");
    cx.fillStyle = color;
    cx.fillRect(0, 0, w, h);
    return c;
}
exports.solid = solid;
function pixel(canvas, x, y) {
    const d = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
}
exports.pixel = pixel;
/** Bounding box and count of everything drawn over a pure-black background. */
function inkBounds(canvas) {
    const { width, height } = canvas;
    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) {
                count++;
                if (x < minX)
                    minX = x;
                if (x > maxX)
                    maxX = x;
                if (y < minY)
                    minY = y;
                if (y > maxY)
                    maxY = y;
            }
        }
    }
    return { minX, maxX, minY, maxY, count };
}
exports.inkBounds = inkBounds;
/** Baked `[timeMs, value]` animation points, the form `interpolate` samples. */
function points(...pairs) {
    return pairs.map(([t, v]) => [t, v]);
}
exports.points = points;
const placed = {
    key: "el",
    localpath: "/tmp/asset",
    trackId: "track-1",
    priority: 1,
    blob: "",
    startTime: 0,
    duration: 4000,
    location: { x: 0, y: 0 },
    timelineOptions: { color: "#ffffff" },
};
const visual = {
    width: 100,
    height: 100,
    ratio: 1,
    opacity: 100,
    rotation: 0,
};
/** All four tracks present and inactive — the neutral animation state. */
function inactiveAnimation() {
    return {
        opacity: { isActivate: false, x: [], ax: [] },
        position: { isActivate: false, x: [], y: [], ax: [], ay: [] },
        scale: { isActivate: false, x: [], ax: [] },
        rotation: { isActivate: false, x: [], ax: [] },
    };
}
exports.inactiveAnimation = inactiveAnimation;
function imageElement(over = {}) {
    return Object.assign(Object.assign(Object.assign(Object.assign({}, placed), visual), { filetype: "image", animation: inactiveAnimation() }), over);
}
exports.imageElement = imageElement;
function gifElement(over = {}) {
    return Object.assign(Object.assign(Object.assign(Object.assign({}, placed), visual), { filetype: "gif" }), over);
}
exports.gifElement = gifElement;
function shapeElement(over = {}) {
    return Object.assign(Object.assign(Object.assign(Object.assign({}, placed), visual), { filetype: "shape", animation: { opacity: { isActivate: false, x: [], ax: [] } }, oWidth: 100, oHeight: 100, shape: [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 100],
        ], option: { fillColor: "#ff0000" } }), over);
}
exports.shapeElement = shapeElement;
function videoElement(over = {}) {
    return Object.assign(Object.assign(Object.assign(Object.assign({}, placed), visual), { filetype: "video", animation: inactiveAnimation(), trim: { startTime: 0, endTime: 4000 }, sourceDuration: 4000, isExistAudio: true, codec: { video: "h264", audio: "aac" }, speed: 1, filter: { enable: false, list: [] }, origin: { width: 100, height: 100 } }), over);
}
exports.videoElement = videoElement;
function textElement(over = {}) {
    return Object.assign(Object.assign(Object.assign(Object.assign({}, placed), visual), { filetype: "text", animation: inactiveAnimation(), text: "AB", textcolor: "#ffffff", fontsize: 40, fontpath: "", fontname: "sans-serif", fontweight: "normal", fonttype: "ttf", letterSpacing: 0, options: {
            isBold: false,
            isItalic: false,
            align: "left",
            outline: { enable: false, size: 0, color: "#000000" },
        }, background: { enable: false, color: "#000000" }, widthInner: 100, width: 200, height: 60 }), over);
}
exports.textElement = textElement;
function audioElement(over = {}) {
    return Object.assign(Object.assign(Object.assign({}, placed), { filetype: "audio", trim: { startTime: 0, endTime: 4000 }, sourceDuration: 4000, speed: 1 }), over);
}
exports.audioElement = audioElement;
//# sourceMappingURL=testing.js.map