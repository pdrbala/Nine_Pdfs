import { sanitizeFilename } from '$lib/download';
import type { EpubToPdfOptions } from '$lib/conversion/types';

export interface EpubConversionDownload {
  blob: Blob;
  filename: string;
  title: string;
  chapterCount: number;
  warnings: string[];
}

function safeDecodeHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function getFilenameFromDisposition(
  disposition: string | null,
  fallbackBase = 'epub_convertido'
): string {
  const header = disposition || '';
  const encodedMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    return safeDecodeHeader(encodedMatch[1].replace(/"/g, ''));
  }

  const fallbackMatch = header.match(/filename="?([^";]+)"?/i);
  if (fallbackMatch?.[1]) {
    return fallbackMatch[1];
  }

  return `${sanitizeFilename(fallbackBase.replace(/\.epub$/i, ''))}.pdf`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

export async function submitEpubConversion(
  file: File,
  options: EpubToPdfOptions
): Promise<EpubConversionDownload> {
  const formData = new FormData();
  formData.set('epub', file);
  formData.set('pageSize', options.pageSize);
  formData.set('margin', String(options.margin));
  formData.set('includeCover', String(options.includeCover));
  formData.set('includeToc', String(options.includeToc));

  const response = await fetch('/api/convert/epub-to-pdf', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    let message = 'Falha ao converter EPUB.';
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error || message;
    } catch {
      // Failure responses normally use JSON; keep the generic message otherwise.
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const title = safeDecodeHeader(response.headers.get('x-epub-title') || '');
  const warningHeader = safeDecodeHeader(response.headers.get('x-epub-warnings') || '').trim();

  return {
    blob,
    filename: getFilenameFromDisposition(response.headers.get('content-disposition'), file.name),
    title,
    chapterCount: Number(response.headers.get('x-epub-chapters') || 0),
    warnings: warningHeader ? warningHeader.split(' | ').filter(Boolean) : []
  };
}

export async function submitEpubUrlConversion(
  epubUrl: string,
  fallbackTitle: string,
  options: EpubToPdfOptions
): Promise<EpubConversionDownload> {
  const formData = new FormData();
  formData.set('epubUrl', epubUrl);
  formData.set('pageSize', options.pageSize);
  formData.set('margin', String(options.margin));
  formData.set('includeCover', String(options.includeCover));
  formData.set('includeToc', String(options.includeToc));

  const response = await fetch('/api/convert/epub-to-pdf', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    let message = 'Falha ao converter EPUB.';
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error || message;
    } catch {
      // Failure responses normally use JSON; keep the generic message otherwise.
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const title = safeDecodeHeader(response.headers.get('x-epub-title') || '');
  const warningHeader = safeDecodeHeader(response.headers.get('x-epub-warnings') || '').trim();

  return {
    blob,
    filename: getFilenameFromDisposition(response.headers.get('content-disposition'), `${fallbackTitle}.epub`),
    title,
    chapterCount: Number(response.headers.get('x-epub-chapters') || 0),
    warnings: warningHeader ? warningHeader.split(' | ').filter(Boolean) : []
  };
}

export async function downloadEpub(url: string, title: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('fetch failed');
    }

    const blob = await response.blob();
    const filename = `${sanitizeFilename(title)}.epub`;
    downloadBlob(blob, filename);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
