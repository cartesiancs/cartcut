/**
 * Expanding a placed template: copying its contents into the project.
 *
 * The first time a template clip is expanded, the installed template behind it
 * is forked into a composition this project owns, and that one clip is pointed
 * at the copy. Other clips placed from the same installed template, and other
 * projects, keep the original. Duplicating the expanded clip afterwards copies
 * the reference, so both copies name one composition, the way two shortcuts
 * name one folder.
 *
 * What the copy holds is what the clip showed: its fills are baked into the
 * slot elements (`compose.ts#bakeFills`) and cleared from the clip, so opening
 * the composition shows the same picture the timeline did. The slot marks stay
 * in the copy, so a duplicate can still be filled differently.
 *
 * Pure, DOM-free and store-free. Declines by identity.
 */

import type { TemplateElementType } from "../../@types/timeline";
import type { TemplateData } from "../template/compose";
import { bakeFills } from "../template/compose";
import { ingestDocument } from "../timeline/ingest";
import { SCHEMA_VERSION } from "../timeline/tracks";
import {
  isProjectTemplateId,
  projectTemplateId,
  type Composition,
  type ProjectTimelines,
} from "./project";
import { adoptOrphans, rekeyContent } from "./rekey";

export type ForkOptions = {
  /** The new composition's id. Minted by the caller, so the result is testable. */
  compositionId: string;
  /** Fresh ids for the copy's elements and tracks. */
  idGen: () => string;
  /** The project's bake rate (`frameRate.ts#projectBakeHz`), or leave the bakes. */
  bakeHz?: number;
};

/**
 * The project with `elementId`'s template forked into a composition.
 *
 * Declines, returning `project` itself, when the element is not a template,
 * already names a composition (expanding that one opens it instead), names a
 * different template from `data`, or when `compositionId` is empty or taken.
 */
export function forkTemplate(
  project: ProjectTimelines,
  elementId: string,
  data: TemplateData,
  options: ForkOptions,
): ProjectTimelines {
  const element = project.main.elements[elementId];
  if (element?.filetype !== "template") {
    return project;
  }
  const placed = element as TemplateElementType;
  if (isProjectTemplateId(placed.templateId) || placed.templateId !== data.id) {
    return project;
  }
  const id = options.compositionId;
  if (id === "" || project.compositions[id] != null) {
    return project;
  }

  // In this order: the fills are the instance's, the orphans need rows before
  // their ids are replaced, and ingress runs last over the final document so
  // the bakes and the derived fields are this project's.
  const baked = bakeFills(data, placed);
  const adopted = adoptOrphans(
    { tracks: data.tracks ?? [], elements: baked },
    options.idGen,
  );
  const rekeyed = rekeyContent(adopted, options.idGen);
  const ingested = ingestDocument(
    { schemaVersion: SCHEMA_VERSION, ...rekeyed },
    options.bakeHz,
  );

  const composition: Composition = {
    id,
    name: placed.name || data.name,
    size: { w: data.size.w, h: data.size.h },
    source: { templateId: data.id, name: data.name },
    tracks: ingested.tracks,
    elements: ingested.elements,
  };

  return {
    main: {
      ...project.main,
      elements: {
        ...project.main.elements,
        [elementId]: {
          ...placed,
          templateId: projectTemplateId(id),
          fills: {},
        } as TemplateElementType,
      },
    },
    compositions: { ...project.compositions, [id]: composition },
  };
}
