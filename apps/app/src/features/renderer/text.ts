import type { TextElementType } from "../../@types/timeline";
import type { ElementRenderFunction } from "./type";

function getWrappedLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
) {
  const textSplited = text.split(" ");
  const lines: {
    line: string;
    width: number;
    ascent: number;
    descent: number;
  }[] = [];
  let currentLine = textSplited[0];

  for (let i = 1; i < textSplited.length; i++) {
    const word = textSplited[i];
    const candidate = `${currentLine} ${word}`;
    const candidateMetrics = ctx.measureText(candidate);

    if (candidateMetrics.width < width) {
      currentLine += " " + word;
    } else {
      const currentLineMetrics = ctx.measureText(currentLine);
      lines.push({
        line: currentLine,
        width: currentLineMetrics.width,
        ascent: currentLineMetrics.actualBoundingBoxAscent,
        descent: currentLineMetrics.actualBoundingBoxDescent,
      });
      currentLine = word;
    }
  }

  const lineMetrics = ctx.measureText(currentLine);
  lines.push({
    line: currentLine,
    width: lineMetrics.width,
    ascent: lineMetrics.actualBoundingBoxAscent,
    descent: lineMetrics.actualBoundingBoxDescent,
  });
  return lines;
}

export const renderText: ElementRenderFunction<TextElementType> = (
  ctx,
  elementId,
  textElement,
  timelineCursor,
) => {
  let { width, height, fontsize: fontSize } = textElement;

  ctx.fillStyle = textElement.textcolor;
  ctx.lineWidth = 0;
  // `letterSpacing` is missing from the DOM types this repo's TypeScript ships
  // with, though every browser the app runs in supports it.
  (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
    `${textElement.letterSpacing}px`;

  ctx.font = `${textElement.options.isItalic ? "italic" : ""} ${
    textElement.options.isBold ? "bold" : ""
  } ${fontSize}px ${textElement.fontname}`;

  const textAlignOrigin = ctx.textAlign;
  let textY = textElement.fontsize ?? 0;
  for (const {
    line,
    width: lineWidth,
    ascent: lineAscent,
    descent: lineDescent,
  } of getWrappedLines(ctx, textElement.text, width)) {
    const backgroundPadding = 12;
    let textX: number;
    let backgroundX: number;
    switch (textElement.options.align) {
      case "left":
        textX = 0;
        backgroundX = -backgroundPadding;
        break;
      case "center":
        textX = width / 2;
        backgroundX = textX - lineWidth / 2 - backgroundPadding;
        break;
      case "right":
        textX = width;
        backgroundX = textX - lineWidth - backgroundPadding;
        break;
      default:
        textX = 0;
        backgroundX = -backgroundPadding;
    }
    ctx.textAlign = textElement.options.align;

    if (textElement.background.enable) {
      ctx.fillStyle = textElement.background.color;
      ctx.fillRect(
        backgroundX,
        textY - lineAscent - backgroundPadding,
        lineWidth + backgroundPadding * 2,
        lineAscent + lineDescent + backgroundPadding * 2,
      );
    }

    if (textElement.options.outline.enable) {
      ctx.lineWidth = textElement.options.outline.size;
      ctx.strokeStyle = textElement.options.outline.color;
      ctx.strokeText(line, textX, textY);
    }

    ctx.fillStyle = textElement.textcolor;
    ctx.fillText(line, textX, textY);
    textY += height;
  }
  ctx.textAlign = textAlignOrigin;
};
