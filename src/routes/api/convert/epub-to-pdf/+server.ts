import { json } from '@sveltejs/kit';
import {
  MAX_EPUB_BYTES,
  convertEpubToPdf,
  normalizeEpubToPdfOptions
} from '$lib/conversion/epub-to-pdf.server';
import type { EpubToPdfOptions } from '$lib/conversion/types';
import type { RequestHandler } from './$types';

function getBoolean(value: FormDataEntryValue | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }
  return String(value) === 'true';
}

function getDispositionFilename(value: string): string {
  return encodeURIComponent(value).replace(/['()]/g, escape);
}

function getAsciiFilename(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
}

export const prerender = false;

function normalizeRemoteUrl(value: FormDataEntryValue | null): URL | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isPrivateHost =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

    return /^https?:$/.test(url.protocol) && !isPrivateHost ? url : null;
  } catch {
    return null;
  }
}

async function fetchRemoteEpub(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/epub+zip,application/octet-stream;q=0.9,*/*;q=0.5'
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar EPUB remoto: HTTP ${response.status}.`);
  }

  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_EPUB_BYTES) {
    throw new Error('EPUB remoto maior que 80 MB.');
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_EPUB_BYTES) {
    throw new Error('EPUB remoto maior que 80 MB.');
  }

  return bytes;
}

export const POST: RequestHandler = async ({ request }) => {
  const formData = await request.formData();
  const file = formData.get('epub');
  const remoteUrl = normalizeRemoteUrl(formData.get('epubUrl'));

  if (!(file instanceof File) && !remoteUrl) {
    return json({ error: 'Envie um arquivo .epub.' }, { status: 400 });
  }

  if (file instanceof File && !file.name.toLowerCase().endsWith('.epub')) {
    return json({ error: 'O arquivo precisa ter extensao .epub.' }, { status: 400 });
  }

  if (file instanceof File && file.size > MAX_EPUB_BYTES) {
    return json({ error: 'EPUB maior que 80 MB.' }, { status: 413 });
  }

  const options = normalizeEpubToPdfOptions({
    pageSize: formData.get('pageSize') === 'Letter' ? 'Letter' : 'A4',
    margin: Number(formData.get('margin') || 54),
    includeCover: getBoolean(formData.get('includeCover'), true),
    includeToc: getBoolean(formData.get('includeToc'), true)
  } satisfies Partial<EpubToPdfOptions>);

  try {
    const input = file instanceof File ? await file.arrayBuffer() : await fetchRemoteEpub(remoteUrl as URL);
    const result = await convertEpubToPdf(input, options);
    const filename = getDispositionFilename(result.filename);
    const asciiFilename = getAsciiFilename(result.filename);
    const body = result.pdf.buffer.slice(
      result.pdf.byteOffset,
      result.pdf.byteOffset + result.pdf.byteLength
    ) as ArrayBuffer;

    return new Response(body, {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(result.pdf.byteLength),
        'content-disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${filename}`,
        'x-epub-title': encodeURIComponent(result.metadata.title),
        'x-epub-chapters': String(result.chapterCount),
        'x-epub-warnings': encodeURIComponent(result.warnings.join(' | '))
      }
    });
  } catch (unknownError) {
    const error = unknownError instanceof Error ? unknownError.message : 'Falha ao converter EPUB.';
    return json({ error }, { status: 422 });
  }
};
