import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { getFilenameFromDisposition, submitEpubConversion } from '$lib/conversion/client';

async function buildMinimalEpub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  );
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fallback Local</dc:title><dc:creator>Autora Teste</dc:creator><dc:language>pt-BR</dc:language></metadata><manifest><item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter1"/></spine></package>'
  );
  zip.file(
    'OEBPS/chapter1.xhtml',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capitulo Um</title></head><body><h1>Capitulo Um</h1><p>Texto simples para validar fallback.</p></body></html>'
  );

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('conversion client helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers RFC 5987 UTF-8 filenames', () => {
    const filename = getFilenameFromDisposition(
      'attachment; filename="fallback.pdf"; filename*=UTF-8\'\'Sexo%20e%20temperamento.pdf'
    );

    expect(filename).toBe('Sexo e temperamento.pdf');
  });

  it('falls back to the uploaded EPUB basename', () => {
    expect(getFilenameFromDisposition(null, 'obra-teste.epub')).toBe('obra-teste.pdf');
  });

  it('converts locally when the server endpoint is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', {
        status: 404
      })
    );

    const bytes = await buildMinimalEpub();
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = new File([body], 'fallback.epub', {
      type: 'application/epub+zip'
    });
    const result = await submitEpubConversion(file, {
      pageSize: 'A4',
      margin: 54,
      includeCover: true,
      includeToc: true
    });

    expect(result.filename).toBe('Fallback_Local.pdf');
    expect(result.chapterCount).toBe(1);
    expect(result.blob.type).toBe('application/pdf');
  });
});

