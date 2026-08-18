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

    this.gl.canvas.width = videoMeta.object.videoWidth;
    this.gl.canvas.height = videoMeta.object.videoHeight;

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.framebufferTexture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      this.gl.canvas.width,
      this.gl.canvas.height,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      null,
    );
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);

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

  swapTextures(): void {
    const temp = this.framebufferTexture;
    this.framebufferTexture = this.srcTexture;
    this.srcTexture = temp;
  }
}
