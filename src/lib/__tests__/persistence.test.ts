import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SEARCH_CACHE_KEY, SETTINGS_KEY } from '$lib/constants';
import {
  loadSearchCache,
  loadSettings,
  persistSearchCache,
  type CachedSearchPayload
} from '$lib/persistence';
import type { AmazonBook } from '$lib/amazon';
import type { ParsedCitation, SearchResult, SearchSettings, SourceStatusEntry } from '$lib/types';

const storage = new Map<string, string>();

function installLocalStorageMock(): void {
  storage.clear();

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return storage.has(key) ? storage.get(key)! : null;
      },
      setItem(key: string, value: string): void {
        storage.set(key, String(value));
      },
      removeItem(key: string): void {
        storage.delete(key);
      },
      clear(): void {
        storage.clear();
      },
      key(index: number): string | null {
        return Array.from(storage.keys())[index] || null;
      },
      get length(): number {
        return storage.size;
      }
    }
  });
}

function makeSettings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides
  };
}

function makeCitation(title = 'Livro de teste'): ParsedCitation {
  return {
    authors: [],
    title,
    subtitle: null,
    year: null,
    publisher: null,
    city: null,
    edition: null,
    type: 'book',
    isbn: null,
    doi: null,
    rawQuery: title,
    raw: title,
    _parserSource: 'local'
  };
}

function makeResult(title = 'Livro de teste'): SearchResult {
  return {
    title,
    author: 'Autor de teste',
    authors: ['Autor de teste'],
    year: null,
    publishedDate: null,
    abstract: null,
    journal: null,
    url: null,
    pdfUrl: 'https://example.test/book.pdf',
    epubUrl: null,
    pageUrl: 'https://example.test/book',
    coverUrl: null,
    materialType: 'book',
    pdfStatus: 'ok',
    pdfStatusReason: '',
    source: 'Google Books',
    sourceId: 'google_books',
    sourceKind: 'catalog',
    sourceWeight: 0.16,
    confidence: 0.9,
    doi: null,
    categories: [],
    extra: null
  };
}

function makeSourceStatus(): Record<string, SourceStatusEntry> {
  return {
    google_books: {
      label: 'Google Books',
      status: 'done',
      count: 1
    }
  };
}

function makeAmazonBook(title = 'Livro de teste'): AmazonBook {
  return {
    source: 'amazon',
    marketplace: 'com.br',
    asin: '1234567890',
    title,
    subtitle: null,
    authors: [{ name: 'Autor de teste', role: 'Autor', url: null }],
    url: 'https://www.amazon.com.br/dp/1234567890',
    canonicalUrl: 'https://www.amazon.com.br/dp/1234567890',
    imageUrl: null,
    binding: 'Livro',
    language: 'Português',
    publisher: null,
    publicationDate: null,
    edition: null,
    pages: null,
    isbn10: null,
    isbn13: null,
    dimensions: null,
    weight: null,
    rating: null,
    reviewCount: null,
    price: null,
    listPrice: null,
    availability: null,
    description: null,
    about: [],
    categories: [],
    bestSellersRank: null,
    rawDetails: {},
    confidence: 0.86,
    officialSignals: ['amazon_detail_page'],
    extractedAt: '2026-05-07T00:00:00.000Z'
  };
}

function makePayload(title = 'Livro de teste'): Omit<CachedSearchPayload, 'cachedAt' | 'rawInput'> {
  return {
    parsedCitation: makeCitation(title),
    results: [makeResult(title)],
    sourceStatus: makeSourceStatus(),
    amazonReferenceBook: makeAmazonBook(title),
    amazonCheckStatus: 'ready',
    amazonCheckError: ''
  };
}

describe('search cache persistence', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  it('loads a cached search by normalized input and settings key', () => {
    const settings = makeSettings();

    persistSearchCache('  Livro de teste  ', settings, makePayload());

    const cached = loadSearchCache('Livro de teste', settings);
    expect(cached?.parsedCitation.title).toBe('Livro de teste');
    expect(cached?.results[0]?.pdfUrl).toBe('https://example.test/book.pdf');
    expect(cached?.sourceStatus.google_books?.status).toBe('done');
    expect(cached?.amazonReferenceBook?.title).toBe('Livro de teste');
    expect(cached?.amazonCheckStatus).toBe('ready');
  });

  it('separates cached searches by search mode and CORE API key presence', () => {
    const baseSettings = makeSettings({ searchMode: 'complete', coreApiKey: '' });
    const focusedSettings = makeSettings({ searchMode: 'focused', coreApiKey: '' });
    const keyedSettings = makeSettings({ searchMode: 'complete', coreApiKey: 'secret' });

    persistSearchCache('Livro de teste', baseSettings, makePayload('Completo'));
    persistSearchCache('Livro de teste', focusedSettings, makePayload('Focado'));
    persistSearchCache('Livro de teste', keyedSettings, makePayload('Com chave'));

    expect(loadSearchCache('Livro de teste', baseSettings)?.parsedCitation.title).toBe('Completo');
    expect(loadSearchCache('Livro de teste', focusedSettings)?.parsedCitation.title).toBe('Focado');
    expect(loadSearchCache('Livro de teste', keyedSettings)?.parsedCitation.title).toBe('Com chave');
  });

  it('returns null for missing entries and invalid cache JSON', () => {
    const settings = makeSettings();

    expect(loadSearchCache('Nada salvo', settings)).toBeNull();

    localStorage.setItem(SEARCH_CACHE_KEY, '{invalid');

    expect(loadSearchCache('Nada salvo', settings)).toBeNull();
  });

  it('normalizes older cached searches that do not have Amazon Check fields', () => {
    const settings = makeSettings();

    localStorage.setItem(
      SEARCH_CACHE_KEY,
      JSON.stringify([
        {
          key: JSON.stringify({
            input: 'Cache antigo',
            searchMode: 'complete',
            hasCoreApiKey: false
          }),
          payload: {
            rawInput: 'Cache antigo',
            parsedCitation: makeCitation('Cache antigo'),
            results: [makeResult('Cache antigo')],
            sourceStatus: makeSourceStatus(),
            cachedAt: 1
          }
        }
      ])
    );

    const cached = loadSearchCache('Cache antigo', settings);

    expect(cached?.amazonReferenceBook).toBeNull();
    expect(cached?.amazonCheckStatus).toBe('idle');
    expect(cached?.amazonCheckError).toBe('');
  });

  it('overwrites the same cached search instead of duplicating it', () => {
    const settings = makeSettings();

    persistSearchCache('Mesmo livro', settings, makePayload('Primeiro titulo'));
    persistSearchCache('Mesmo livro', settings, makePayload('Segundo titulo'));

    const cached = loadSearchCache('Mesmo livro', settings);
    const entries = JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) || '[]') as unknown[];

    expect(cached?.parsedCitation.title).toBe('Segundo titulo');
    expect(entries).toHaveLength(1);
  });

  it('keeps only the 30 most recent cached searches', () => {
    const settings = makeSettings();

    for (let index = 0; index < 35; index += 1) {
      persistSearchCache(`Livro ${index}`, settings, makePayload(`Livro ${index}`));
    }

    const entries = JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) || '[]') as Array<{
      payload: CachedSearchPayload;
    }>;

    expect(entries).toHaveLength(30);
    expect(entries[0]?.payload.rawInput).toBe('Livro 34');
    expect(entries.some((entry) => entry.payload.rawInput === 'Livro 0')).toBe(false);
  });

  it('defaults cached search usage on when loading older settings', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        coreApiKey: '',
        prioritizeReadyPdf: true,
        convertEpubToPdfByDefault: false,
        searchMode: 'focused'
      })
    );

    expect(loadSettings()).toMatchObject({
      convertEpubToPdfByDefault: false,
      searchMode: 'focused',
      useCachedSearch: true
    });
  });
});
