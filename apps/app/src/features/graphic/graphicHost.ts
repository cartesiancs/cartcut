/**
 * The host every caller prepares on, whichever backend draws.
 *
 * It answers for the host `graphicBackend.ts` chose, made on first use, so
 * nothing above the port (`prepare.ts`, `previewSession.ts`, the scopes) knows
 * there are two. Until the backend has been decided it is an empty host:
 * `supported()` is false, so `prepare.ts` asks nothing of it, and `release`
 * and `unmount` have nothing to let go of. Every prepare awaits the decision
 * first (`graphicPipeline.ts`), and nothing here decides it, so a project with
 * no graphics never probes. DOM-free.
 */

import type { GraphicBackend } from "./graphicBackend";
import type { ApplyState, HtmlRasterPort, MountSpec } from "./htmlRasterPort";

export class GraphicHost implements HtmlRasterPort {
  private inner: HtmlRasterPort | null = null;

  constructor(
    private readonly known: () => GraphicBackend | null,
    private readonly make: (backend: Exclude<GraphicBackend, "none">) => HtmlRasterPort,
  ) {}

  private host(): HtmlRasterPort | null {
    if (this.inner == null) {
      const backend = this.known();
      if (backend == null || backend === "none") {
        return null;
      }
      this.inner = this.make(backend);
    }
    return this.inner;
  }

  supported(): boolean {
    return this.host()?.supported() ?? false;
  }

  mount(instanceId: string, spec: MountSpec): void {
    this.host()?.mount(instanceId, spec);
  }

  apply(instanceId: string, state: ApplyState): void {
    this.host()?.apply(instanceId, state);
  }

  settle(): Promise<boolean> {
    return this.host()?.settle() ?? Promise.resolve(true);
  }

  rasterize(instanceId: string, width: number, height: number): CanvasImageSource | null {
    return this.host()?.rasterize(instanceId, width, height) ?? null;
  }

  release(live: ReadonlySet<string>): void {
    this.inner?.release(live);
  }

  unmount(instanceId: string): void {
    this.inner?.unmount(instanceId);
  }
}
