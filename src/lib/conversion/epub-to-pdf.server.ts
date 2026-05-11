import PDFDocument from 'pdfkit';
import type { EpubToPdfOptions, EpubToPdfResult } from '$lib/conversion/types';
import {
  MAX_EPUB_BYTES,
  normalizeEpubToPdfOptions,
  parseEpub,
  sanitizeEpubPdfFilename,
  sanitizePdfText,
  type ParsedEpub
} from '$lib/conversion/epub-to-pdf.shared';
import { normalizeWhitespace } from '$lib/utils';

export { MAX_EPUB_BYTES, normalizeEpubToPdfOptions };

function writeParagraphs(doc: PDFKit.PDFDocument, text: string): void {
  sanitizePdfText(text)
    .split(/\n{2,}/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean)
    .forEach((paragraph) => {
      doc.font('Times-Roman').fontSize(11).text(paragraph, {
        align: 'left',
        lineGap: 2
      });
      doc.moveDown(0.8);
    });
}

async function renderPdf(parsed: ParsedEpub, options: EpubToPdfOptions): Promise<Uint8Array> {
  const doc = new PDFDocument({
    size: options.pageSize,
    margin: options.margin,
    info: {
      Title: parsed.metadata.title,
      Author: parsed.metadata.authors.join(', '),
      Creator: 'Nine PDFs'
    }
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.font('Times-Bold').fontSize(24).text(sanitizePdfText(parsed.metadata.title), {
    align: 'center'
  });
  if (parsed.metadata.authors.length) {
    doc.moveDown(0.6);
    doc.font('Times-Roman').fontSize(13).text(sanitizePdfText(parsed.metadata.authors.join(', ')), {
      align: 'center'
    });
  }
  if (parsed.metadata.publisher || parsed.metadata.date) {
    doc.moveDown(0.4);
    doc
      .font('Times-Roman')
      .fontSize(10)
      .fillColor('#555555')
      .text(sanitizePdfText([parsed.metadata.publisher, parsed.metadata.date].filter(Boolean).join(' - ')), {
        align: 'center'
      });
    doc.fillColor('#000000');
  }

  if (options.includeCover && parsed.coverImage) {
    try {
      doc.moveDown(1.2);
      doc.image(Buffer.from(parsed.coverImage), {
        fit: [320, 420],
        align: 'center',
        valign: 'center'
      });
    } catch {
      parsed.warnings.push('Capa encontrada, mas nao foi possivel inserir a imagem no PDF.');
    }
  }

  if (options.includeToc) {
    doc.addPage();
    doc.font('Times-Bold').fontSize(18).text('Sumario');
    doc.moveDown();
    parsed.chapters.forEach((chapter, index) => {
      doc.font('Times-Roman').fontSize(11).text(`${index + 1}. ${sanitizePdfText(chapter.title)}`);
    });
  }

  parsed.chapters.forEach((chapter) => {
    doc.addPage();
    doc.font('Times-Bold').fontSize(17).text(sanitizePdfText(chapter.title));
    doc.moveDown();
    writeParagraphs(doc, chapter.text);
  });

  doc.end();
  return new Uint8Array(await done);
}

export async function convertEpubToPdf(
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
