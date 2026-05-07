import { describe, expect, it } from 'vitest';
import { scoreAmazonMatch } from '$lib/amazon-check';
import type { AmazonBook } from '$lib/amazon';
import type { SearchResult } from '$lib/types';

const amazonBook: AmazonBook = {
  source: 'amazon',
  marketplace: 'com.br',
  asin: '8594318677',
  title: 'Dom Quixote',
  subtitle: null,
  authors: [{ name: 'Miguel de Cervantes', role: 'Autor', url: null }],
  url: 'https://www.amazon.com.br/dp/8594318677',
  canonicalUrl: 'https://www.amazon.com.br/dp/8594318677',
  imageUrl: null,
  binding: 'Capa comum',
  language: 'Português',
  publisher: 'Principis',
  publicationDate: '18 julho 2019',
  edition: null,
  pages: 304,
  isbn10: '8594318677',
  isbn13: '978-8594318671',
  dimensions: null,
  weight: null,
  rating: 4.7,
  reviewCount: 3431,
  price: null,
  listPrice: null,
  availability: null,
  description: null,
  about: [],
  categories: [],
  bestSellersRank: null,
  rawDetails: {},
  confidence: 0.99,
  officialSignals: [],
  extractedAt: '2026-05-07T00:00:00.000Z'
};

function makeResult(partial: Partial<SearchResult>): SearchResult {
  return {
    title: 'Dom Quixote',
    author: 'Miguel de Cervantes',
    authors: ['Miguel de Cervantes'],
    year: '2019',
    publishedDate: null,
    abstract: null,
    journal: null,
    url: null,
    pdfUrl: null,
    epubUrl: null,
    pageUrl: null,
    materialType: 'book',
    pdfStatus: 'none',
    pdfStatusReason: '',
    source: 'Fixture',
    sourceId: 'fixture',
    confidence: 0.8,
    doi: null,
    categories: [],
    extra: null,
    ...partial
  };
}

describe('amazon check scoring', () => {
  it('scores exact ISBN and metadata matches near the top', () => {
    const check = scoreAmazonMatch(
      makeResult({ extra: { isbn: '978-8594318671', publisher: 'Principis' } }),
      amazonBook
    );

    expect(check.score).toBeGreaterThanOrEqual(92);
  });

  it('keeps unrelated titles low', () => {
    const check = scoreAmazonMatch(
      makeResult({
        title: 'O Primo Basílio',
        author: 'Eça de Queirós',
        authors: ['Eça de Queirós'],
        year: '1878'
      }),
      amazonBook
    );

    expect(check.score).toBeLessThan(45);
  });
});
