import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { EpubToPdfOptions, EpubToPdfResult } from '$lib/conversion/types';
import {
  normalizeEpubToPdfOptions,
  parseEpub,
  sanitizeEpubPdfFilename,
  sanitizePdfText,
  type ParsedEpub
} from '$lib/conversion/epub-to-pdf.shared';
import { normalizeWhitespace } from '$lib/utils';

const PAGE_SIZES: Record<EpubToPdfOptions['pageSize'], [number, number]> = {
  A4: [595.28, 841.89],
  Letter: [612, 792]
};

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = normalizeWhitespace(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = word;
  });

  if (current) {
    lines.push(current);
  }

  return lines;
}

function looksLikePng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

async function renderPdf(parsed: ParsedEpub, options: EpubToPdfOptions): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(parsed.metadata.title);
  if (parsed.metadata.authors.length) {
    pdfDoc.setAuthor(parsed.metadata.authors.join(', '));
  }
  pdfDoc.setCreator('Nine PDFs');

  const regularFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const pageSize = PAGE_SIZES[options.pageSize];
  const margin = options.margin;
  const lineColor = rgb(0, 0, 0);
  let page: PDFPage = pdfDoc.addPage(pageSize);
  let y = page.getHeight() - margin;

  function addPage(): void {
    page = pdfDoc.addPage(pageSize);
    y = page.getHeight() - margin;
  }

  function ensureSpace(height: number): void {
    if (y - height < margin) {
      addPage();
    }
  }

  function drawTextLine(text: string, font: PDFFont, size: number, lineHeight = size * 1.35): void {
    ensureSpace(lineHeight);
    page.drawText(text, {
      x: margin,
      y,
      size,
      font,
      color: lineColor
    });
    y -= lineHeight;
  }

  function drawCentered(text: string, font: PDFFont, size: number, lineHeight = size * 1.35): void {
    const maxWidth = page.getWidth() - margin * 2;
    wrapText(text, font, size, maxWidth).forEach((line) => {
      ensureSpace(lineHeight);
      page.drawText(line, {
        x: Math.max(margin, (page.getWidth() - font.widthOfTextAtSize(line, size)) / 2),
        y,
        size,
        font,
        color: lineColor
      });
      y -= lineHeight;
    });
  }

  function drawParagraphs(text: string): void {
    sanitizePdfText(text)
      .split(/\n{2,}/)
      .map((paragraph) => normalizeWhitespace(paragraph))
      .filter(Boolean)
      .forEach((paragraph) => {
        wrapText(paragraph, regularFont, 11, page.getWidth() - margin * 2).forEach((line) => {
          drawTextLine(line, regularFont, 11, 14.5);
        });
        y -= 7;
      });
  }

  drawCentered(sanitizePdfText(parsed.metadata.title), boldFont, 24, 30);
  if (parsed.metadata.authors.length) {
    y -= 10;
    drawCentered(sanitizePdfText(parsed.metadata.authors.join(', ')), regularFont, 13, 18);
  }
  if (parsed.metadata.publisher || parsed.metadata.date) {
    y -= 4;
    drawCentered(
      sanitizePdfText([parsed.metadata.publisher, parsed.metadata.date].filter(Boolean).join(' - ')),
      regularFont,
      10,
      14
    );
  }

  if (options.includeCover && parsed.coverImage) {
    try {
      const cover =
        parsed.coverImageMediaType === 'image/png' || looksLikePng(parsed.coverImage)
          ? await pdfDoc.embedPng(parsed.coverImage)
          : parsed.coverImageMediaType === 'image/jpeg' ||
              parsed.coverImageMediaType === 'image/jpg' ||
              looksLikeJpeg(parsed.coverImage)
            ? await pdfDoc.embedJpg(parsed.coverImage)
            : null;

      if (cover) {
        const scaled = cover.scaleToFit(320, 420);
        ensureSpace(scaled.height + 24);
        page.drawImage(cover, {
          x: (page.getWidth() - scaled.width) / 2,
          y: y - scaled.height,
          width: scaled.width,
          height: scaled.height
        });
        y -= scaled.height + 24;
      }
    } catch {
      parsed.warnings.push('Capa encontrada, mas nao foi possivel inserir a imagem no PDF.');
    }
  }

  if (options.includeToc) {
    addPage();
    drawTextLine('Sumario', boldFont, 18, 25);
    y -= 8;
    parsed.chapters.forEach((chapter, index) => {
      wrapText(`${index + 1}. ${sanitizePdfText(chapter.title)}`, regularFont, 11, page.getWidth() - margin * 2)
        .forEach((line) => drawTextLine(line, regularFont, 11, 14.5));
    });
  }

  parsed.chapters.forEach((chapter) => {
    addPage();
    drawTextLine(sanitizePdfText(chapter.title), boldFont, 17, 24);
    y -= 8;
    drawParagraphs(chapter.text);
  });

  return pdfDoc.save();
}

export async function convertEpubToPdfInBrowser(
  input: ArrayBuffer | Uint8Array,
  options: Partial<EpubToPdfOptions> = {}
): Promise<EpubToPdfResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const normalizedOptions = normalizeEpubToPdfOptions(options);
  const parsed = await parseEpub(bytes);
  const pdf = await renderPdf(parsed, normalizedOptions);

  return {
    filename: `${sanitizeEpubPdfFilename(parsed.metadata.title)}.pdf`,
    metadata: parsed.metadata,
    chapterCount: parsed.chapters.length,
    warnings: parsed.warnings,
    pdf
  };
}
