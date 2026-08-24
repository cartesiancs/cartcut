import type {
  VideoElementType,
  VideoFilterType,
} from "../../../@types/timeline";
import type { VideoMetadataPerElement } from "../../asset/loadedAssetStore";
import { createTextureNPOT, drawToTexture } from "../gl/texture";
import { Blur } from "./blur";
import { ChromaKey } from "./chromaKey";
import type { BaseFilter } from "./baseFilter";
import { Normal } from "./normal";
import { RadialBlur } from "./radialBlur";

export class VideoFilterPipeline {
  private filters: Record<VideoFilterType["name"] | "normal", BaseFilter<any>>;

  private srcTexture: WebGLTexture;
  private framebufferTexture: WebGLTexture;
  private framebuffer: WebGLFramebuffer;

  /**
   * The size both ping-pong textures are currently allocated at.
   *
   * Tracked on the pipeline rather than per texture because `swapTextures`
   * rotates which handle plays which role — tagging one of them would follow
   * the role, not the allocation. Both are always at canvas size, so one
   * number describes both.
   */
  private allocatedWidth = 0;
  private allocatedHeight = 0;

  constructor(private gl: WebGLRenderingContext) {
    this.filters = {
      normal: new Normal(gl),
      chromakey: new ChromaKey(gl),
      blur: new Blur(gl),
      radialblur: new RadialBlur(gl),
    };

    this.srcTexture = createTextureNPOT(gl);
    this.framebufferTexture = createTextureNPOT(gl);
    const framebuffer = gl.createFramebuffer();
    if (framebuffer == null) {
      throw new Error("WebGL: failed to create framebuffer");
    }
    this.framebuffer = framebuffer;
  }

  render(
    ctx: CanvasRenderingContext2D,
    videoElement: VideoElementType,
    videoMeta: VideoMetadataPerElement,
    isBlocking: boolean,
  ): void {
    if (videoElement.filter.enable === false) {
      return;
    }

    const frameWidth = videoMeta.object.videoWidth;
    const frameHeight = videoMeta.object.videoHeight;

    // Assigning a canvas dimension reallocates and clears the drawing buffer
    // even when the value is identical, so this ran per frame for no reason.
    if (this.gl.canvas.width !== frameWidth) {
      this.gl.canvas.width = frameWidth;
    }
    if (this.gl.canvas.height !== frameHeight) {
      this.gl.canvas.height = frameHeight;
    }

    this.allocateTextures(frameWidth, frameHeight);

    const normal = this.filters["normal"] as Normal;

    // 비디오 프레임을 프레임버퍼에 렌더링
    drawToTexture(
      this.gl,
      this.framebuffer,
      this.framebufferTexture,
      this.gl.canvas.width,
      this.gl.canvas.height,
      () => {
        normal.draw(
          {
            source: videoMeta.object,
            flipY: true, // 비디오 좌표계는 WebGL 좌표계와 반대이므로 Y축을 뒤집어야 함
          },
          this.srcTexture,
        );
      },
    );
    this.swapTextures();

    // 필터 적용 후 프레임버퍼와 텍스쳐를 교체
    for (const { name, value } of videoElement.filter.list) {
      drawToTexture(
        this.gl,
        this.framebuffer,
        this.framebufferTexture,
        this.gl.canvas.width,
        this.gl.canvas.height,
        () => {
          this.filters[name].draw(value, this.srcTexture);
        },
      );
      this.swapTextures();
    }

    // 프레임버퍼(마지막으로 swap했으므로 srcTexture에 담겨있음)를 최종적으로 gl 캔버스에 렌더링
    normal.draw(null, this.srcTexture);

    if (isBlocking) {
      this.gl.finish();
    }

    // gl 캔버스를 메인 캔버스에 렌더링
    ctx.drawImage(
      this.gl.canvas,
      0,
      0,
      videoElement.width,
      videoElement.height,
    );
  }

  /**
   * Size both ping-pong textures, reallocating only when the frame size moves.
   *
   * This was an unconditional `texImage2D(..., null)` on every frame — an
   * 8.29 MB VRAM allocation per frame at 1080p, discarded immediately.
   *
   * Both are sized, not just the current framebuffer target: `swapTextures`
   * will make the other one the target on the next pass, and a target that is
   * still at the previous frame's dimensions renders a torn result.
   */
  private allocateTextures(width: number, height: number): void {
    if (this.allocatedWidth === width && this.allocatedHeight === height) {
      return;
    }

    for (const texture of [this.framebufferTexture, this.srcTexture]) {
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA,
        width,
        height,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        null,
      );
    }
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);

    this.allocatedWidth = width;
    this.allocatedHeight = height;
  }

  swapTextures(): void {
    const temp = this.framebufferTexture;
    this.framebufferTexture = this.srcTexture;
    this.srcTexture = temp;
  }
}
