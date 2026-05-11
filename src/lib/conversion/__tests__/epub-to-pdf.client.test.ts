import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertEpubToPdfInBrowser } from '$lib/conversion/epub-to-pdf.client';

async function buildMinimalEpub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  );
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Teste EPUB Browser</dc:title><dc:creator>Autora Teste</dc:creator><dc:language>pt-BR</dc:language></metadata><manifest><item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter1"/></spine></package>'
  );
  zip.file(
    'OEBPS/chapter1.xhtml',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capitulo Um</title></head><body><h1>Capitulo Um</h1><p>Texto simples para validar a conversao local.</p></body></html>'
  );

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('browser EPUB to PDF conversion', () => {
  it('converts a minimal EPUB without the server endpoint', async () => {
    const result = await convertEpubToPdfInBrowser(await buildMinimalEpub(), {
      pageSize: 'A4',
      margin: 54,
      includeCover: true,
      includeToc: true
    });

    const signature = Buffer.from(result.pdf.slice(0, 5)).toString('ascii');
    expect(signature).toBe('%PDF-');
    expect(result.filename).toBe('Teste_EPUB_Browser.pdf');
    expect(result.chapterCount).toBe(1);
  });
});
