/**
 * The browser's half of `templateLink.ts`: `fetch`, the stores, the toast.
 *
 * Kept to wiring so the decisions stay in the port-driven module, which the
 * `node` suite runs.
 */

import { renderOptionStore } from "../../states/renderOptionStore";
import { previewViewportStore } from "../../states/previewViewportStore";
import { selectionStore } from "../../states/selectionStore";
import { setProjectFps } from "../editor/frameRate";
import { addTemplateToTimeline } from "./addTemplate";
import {
  exampleTemplateReader,
  openTemplateLink,
  templateSlugFrom,
  type TemplateHttpPort,
  type TemplateLinkResult,
} from "./templateLink";
import {
  installedTemplates,
  loadTemplate,
  ngtEntriesOf,
  setTemplateLibrary,
  setTemplateReader,
} from "./templateRegistry";

const fetchHttp: TemplateHttpPort = {
  async text(path) {
    try {
      const response = await fetch(path);
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  },
  async bytes(path) {
    try {
      const response = await fetch(path);
      return response.ok ? await response.arrayBuffer() : null;
    } catch {
      return null;
    }
  },
  async exists(path) {
    try {
      const response = await fetch(path, { method: "HEAD" });
      return response.ok;
    } catch {
      return false;
    }
  },
};

let readerInstalled = false;

function installReader(): void {
  if (readerInstalled) {
    return;
  }
  readerInstalled = true;
  const previous = setTemplateReader((listing) => current(listing));
  const current = exampleTemplateReader(fetchHttp, ngtEntriesOf, previous);
}

/** The slug this page was opened with, if any. */
export function linkedTemplateSlug(): string | null {
  return templateSlugFrom(window.location.search);
}

/** Open the template the page address names. */
export async function openLinkedTemplate(
  slug: string,
): Promise<TemplateLinkResult> {
  installReader();
  return openTemplateLink(slug, {
    http: fetchHttp,
    register(listing) {
      setTemplateLibrary([
        ...installedTemplates().filter((entry) => entry.id !== listing.id),
        listing,
      ]);
    },
    load: loadTemplate,
    applyFrame(size, fps) {
      const options = renderOptionStore.getState().options;
      if (options.previewSize.w !== size.w || options.previewSize.h !== size.h) {
        renderOptionStore.getState().updateOptions({
          ...options,
          previewSize: { w: size.w, h: size.h },
        });
        previewViewportStore.getState().fit(size.w, size.h);
      }
      if (fps != null) {
        setProjectFps(fps);
      }
    },
    place: (templateId) => addTemplateToTimeline(templateId, { startMs: 0 }),
    select(elementId) {
      selectionStore.getState().setIds([elementId]);
    },
  });
}
