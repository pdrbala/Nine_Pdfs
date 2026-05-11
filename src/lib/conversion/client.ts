import { sanitizeFilename } from '$lib/download';
import type { EpubToPdfOptions } from '$lib/conversion/types';

export interface EpubConversionDownload {
  blob: Blob;
  filename: string;
  title: string;
  chapterCount: number;
  warnings: string[];
}

const EPUB_CONVERSION_ENDPOINT = '/api/convert/epub-to-pdf';
const MAX_BROWSER_EPUB_BYTES = 80 * 1024 * 1024;

class EndpointUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`Endpoint de conversao indisponivel: HTTP ${status}`);
    this.name = 'EndpointUnavailableError';
  }
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

function appendConversionOptions(formData: FormData, options: EpubToPdfOptions): void {
  formData.set('pageSize', options.pageSize);
  formData.set('margin', String(options.margin));
  formData.set('includeCover', String(options.includeCover));
  formData.set('includeToc', String(options.includeToc));
}

function isStaticPagesHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
}

function isEndpointUnavailableStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 405 || status === 501;
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function responseToDownload(
  response: Response,
  fallbackBase: string
): Promise<EpubConversionDownload> {
  if (!response.ok) {
    if (isEndpointUnavailableStatus(response.status)) {
      throw new EndpointUnavailableError(response.status);
    }

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
    filename: getFilenameFromDisposition(response.headers.get('content-disposition'), fallbackBase),
    title,
    chapterCount: Number(response.headers.get('x-epub-chapters') || 0),
    warnings: warningHeader ? warningHeader.split(' | ').filter(Boolean) : []
  };
}

async function submitServerConversion(
  formData: FormData,
  fallbackBase: string
): Promise<EpubConversionDownload> {
  const response = await fetch(EPUB_CONVERSION_ENDPOINT, {
    method: 'POST',
    body: formData
  });

  return responseToDownload(response, fallbackBase);
}

async function convertBytesInBrowser(
  bytes: ArrayBuffer | Uint8Array,
  options: EpubToPdfOptions
): Promise<EpubConversionDownload> {
  const { convertEpubToPdfInBrowser } = await import('$lib/conversion/epub-to-pdf.client');
  const result = await convertEpubToPdfInBrowser(bytes, options);

  return {
    blob: new Blob([toBlobPart(result.pdf)], { type: 'application/pdf' }),
    filename: result.filename,
    title: result.metadata.title,
    chapterCount: result.chapterCount,
    warnings: result.warnings
  };
}

async function convertFileInBrowser(
  file: File,
  options: EpubToPdfOptions
): Promise<EpubConversionDownload> {
  if (file.size > MAX_BROWSER_EPUB_BYTES) {
    throw new Error('EPUB maior que 80 MB.');
  }
  return convertBytesInBrowser(await file.arrayBuffer(), options);
}

async function fetchRemoteEpubInBrowser(epubUrl: string): Promise<ArrayBuffer> {
  const response = await fetch(epubUrl, {
    headers: {
      Accept: 'application/epub+zip,application/octet-stream;q=0.9,*/*;q=0.5'
    }
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar EPUB remoto: HTTP ${response.status}.`);
  }

  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BROWSER_EPUB_BYTES) {
    throw new Error('EPUB remoto maior que 80 MB.');
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BROWSER_EPUB_BYTES) {
    throw new Error('EPUB remoto maior que 80 MB.');
  }

  return bytes;
}

async function convertRemoteUrlInBrowser(
  epubUrl: string,
  options: EpubToPdfOptions
): Promise<EpubConversionDownload> {
  try {
    return await convertBytesInBrowser(await fetchRemoteEpubInBrowser(epubUrl), options);
  } catch (unknownError) {
    const message = unknownError instanceof Error ? unknownError.message : 'Falha ao converter EPUB.';
    throw new Error(
      `${message} No GitHub Pages, EPUB remoto so converte se a origem permitir CORS.`
    );
  }
}

export async function submitEpubConversion(
  file: File,
  options: EpubToPdfOptions
): Promise<EpubConversionDownload> {
  const formData = new FormData();
  formData.set('epub', file);
  appendConversionOptions(formData, options);

  if (isStaticPagesHost()) {
    return convertFileInBrowser(file, options);
  }

  try {
    return await submitServerConversion(formData, file.name);
  } catch (unknownError) {
    if (unknownError instanceof EndpointUnavailableError) {
      return convertFileInBrowser(file, options);
    }
    throw unknownError;
  }
}

export async function submitEpubUrlConversion(
  epubUrl: string,
  fallbackTitle: string,
  options: EpubToPdfOptions
): Promise<EpubConversionDownload> {
  const formData = new FormData();
  formData.set('epubUrl', epubUrl);
  appendConversionOptions(formData, options);

  if (isStaticPagesHost()) {
    return convertRemoteUrlInBrowser(epubUrl, options);
  }

  try {
    return await submitServerConversion(formData, `${fallbackTitle}.epub`);
  } catch (unknownError) {
    if (unknownError instanceof EndpointUnavailableError) {
      return convertRemoteUrlInBrowser(epubUrl, options);
    }
    throw unknownError;
  }
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
