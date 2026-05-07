import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '$lib/constants';
import {
  buildParsedFallback,
  buildResult,
  buildSearchQuery,
  calculateConfidence,
  getDirectAdapters,
  getManualSearchEntries,
  getSortedResults
} from '$lib/engine';

describe('engine baseline', () => {
  it('parses a sparse title without inventing an author', () => {
    const parsed = buildParsedFallback('Sexo e temperamento');

    expect(parsed?.title).toBe('Sexo e temperamento');
    expect(parsed?.authors).toEqual([]);
    expect(parsed?._parserSource).toBe('local');
  });

  it('builds a compact title + primary author query', () => {
    const parsed = buildParsedFallback('MEAD, Margaret. Sexo e temperamento. Sao Paulo: Perspectiva, 2000.');

    expect(parsed).not.toBeNull();
    expect(buildSearchQuery(parsed!)).toBe('Sexo e temperamento Margaret Mead');
  });

  it('adds Google Books as a direct catalog source', () => {
    expect(getDirectAdapters().some((adapter) => adapter.sourceId === 'google_books')).toBe(true);
  });

  it('adds legal catalog and institutional manual searches', () => {
    const parsed = buildParsedFallback('MEAD, Margaret. Sexo e temperamento. Sao Paulo: Perspectiva, 2000.');
    const entries = getManualSearchEntries(parsed!);
    const sourceIds = entries.map((entry) => entry.sourceId);

    expect(sourceIds).toContain('publisher_official');
    expect(sourceIds).toContain('google_books_manual');
    expect(sourceIds).toContain('institutional_pdf');
    expect(sourceIds).toContain('brazilian_repositories_pdf');
    expect(sourceIds).toContain('scielo_books');
    expect(sourceIds).toContain('doab');
    expect(decodeURIComponent(entries.find((entry) => entry.sourceId === 'institutional_pdf')!.manualUrl)).toContain(
      'site:books.scielo.org'
    );
  });

  it('does not expose pirate-focused manual sources', () => {
    const parsed = buildParsedFallback('MEAD, Margaret. Sexo e temperamento. Sao Paulo: Perspectiva, 2000.');
    const sourceIds = getManualSearchEntries(parsed!).map((entry) => entry.sourceId);

    expect(sourceIds).not.toContain('dokumen_pub');
    expect(sourceIds).not.toContain('library_genesis');
    expect(sourceIds).not.toContain('z_library');
    expect(sourceIds).not.toContain('pdf_drive');
  });

  it('can show only the focused catalog search manual links', () => {
    const parsed = buildParsedFallback('MEAD, Margaret. Sexo e temperamento. Sao Paulo: Perspectiva, 2000.');
    const sourceIds = getManualSearchEntries(parsed!, 'focused').map((entry) => entry.sourceId);

    expect(sourceIds).toContain('google_books_manual');
    expect(sourceIds).toContain('institutional_pdf');
    expect(sourceIds).toContain('worldcat');
    expect(sourceIds).not.toContain('google_scholar');
    expect(sourceIds).not.toContain('project_muse');
    expect(sourceIds).not.toContain('jstor');
  });

  it('adds EPUB-focused manual sources', () => {
    const parsed = buildParsedFallback('Sexo e temperamento');
    const entries = getManualSearchEntries(parsed!);

    expect(entries.some((entry) => entry.sourceId === 'internet_archive_epub')).toBe(true);
    expect(entries.some((entry) => entry.sourceId === 'project_gutenberg_manual')).toBe(true);
    expect(entries.some((entry) => entry.sourceId === 'manybooks')).toBe(true);
    expect(entries.some((entry) => entry.sourceId === 'marxists_pt')).toBe(true);
    expect(entries.some((entry) => entry.sourceId === 'marxists_org')).toBe(true);
  });

  it('adds Marxists Internet Archive as a direct source for classic works', () => {
    expect(getDirectAdapters().some((adapter) => adapter.sourceId === 'marxists_archive')).toBe(true);
  });

  it('adds Senado Federal as a direct source for Brazilian classics', async () => {
    const parsed = {
      ...buildParsedFallback('A Ilusão Americana')!,
      authors: [{ lastName: 'PRADO', firstName: 'Eduardo' }],
      raw: 'A Ilusão Americana Eduardo Prado'
    };
    const adapter = getDirectAdapters().find((entry) => entry.sourceId === 'senado_federal')!;
    const response = await adapter.search(parsed, DEFAULT_SETTINGS);

    expect(response.results[0]?.pdfUrl).toContain('Ilusao_americana.pdf');
  });

  it('matches canonical Marxists Archive works directly', async () => {
    const parsed = {
      ...buildParsedFallback('O Estado e a Revolução')!,
      authors: [{ lastName: 'LENIN', firstName: '' }],
      raw: 'O Estado e a Revolução Lenin'
    };
    const adapter = getDirectAdapters().find((entry) => entry.sourceId === 'marxists_archive')!;
    const response = await adapter.search(parsed, DEFAULT_SETTINGS);

    expect(response.results[0]?.pdfUrl).toContain('estado-e-a-revolucao.pdf');
  });

  it('penalizes analytical articles that only discuss the requested book', () => {
    const parsed = buildParsedFallback('MARX, Karl. O capital. Sao Paulo: Boitempo, 2013.')!;
    const confidence = calculateConfidence(parsed, {
      title: 'O capital em debate: critica e atualidade',
      author: 'Maria Silva',
      authors: ['Maria Silva'],
      year: '2020',
      publishedDate: null,
      pdfUrl: 'https://example.test/article.pdf',
      epubUrl: null,
      pageUrl: 'https://example.test/article',
      materialType: 'article',
      pdfStatus: 'ok',
      sourceId: 'crossref',
      doi: '10.1234/example'
    });

    expect(confidence).toBeLessThan(0.45);
  });

  it('ranks verified PDFs before EPUB-only results', () => {
    const parsed = buildParsedFallback('Sexo e temperamento')!;
    const epub = buildResult(parsed, 'Project Gutenberg', {
      sourceId: 'project_gutenberg',
      title: 'Sexo e temperamento',
      epubUrl: 'https://example.test/book.epub',
      materialType: 'book'
    });
    const pdf = buildResult(parsed, 'Internet Archive', {
      sourceId: 'internet_archive',
      title: 'Sexo e temperamento',
      pdfUrl: 'https://example.test/book.pdf',
      pdfStatus: 'ok',
      materialType: 'book'
    });

    expect(getSortedResults([epub, pdf])[0].pdfUrl).toBe(pdf.pdfUrl);
  });
});
