import { scrapeAmazonBookFromSearch } from '../src/lib/amazon.ts';

const { JSDOM } = await import('jsdom');
globalThis.DOMParser = new JSDOM('').window.DOMParser;

const query = process.argv.slice(2).join(' ') || 'Dom Quixote';

const result = await scrapeAmazonBookFromSearch(query, {
  marketplace: 'com.br',
  timeoutMs: 20000,
  maxCandidates: 8,
  requestHeaders: {
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  }
});

console.log(
  JSON.stringify(
    {
      status: result.status,
      query: result.query,
      searchFetchVia: result.searchFetchVia,
      detailFetchVia: result.detailFetchVia,
      warnings: result.warnings,
      selectedCandidate: result.selectedCandidate
        ? {
            asin: result.selectedCandidate.asin,
            title: result.selectedCandidate.title,
            score: result.selectedCandidate.score,
            productUrl: result.selectedCandidate.productUrl
          }
        : null,
      book: result.book
        ? {
            asin: result.book.asin,
            title: result.book.title,
            authors: result.book.authors,
            publisher: result.book.publisher,
            publicationDate: result.book.publicationDate,
            isbn10: result.book.isbn10,
            isbn13: result.book.isbn13,
            pages: result.book.pages,
            rating: result.book.rating,
            reviewCount: result.book.reviewCount,
            price: result.book.price,
            confidence: result.book.confidence,
            url: result.book.url
          }
        : null
    },
    null,
    2
  )
);
