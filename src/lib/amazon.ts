export type AmazonScrapeStatus = 'success' | 'partial' | 'no_results';

export type AmazonFetchFailureKind = 'http' | 'blocked' | 'cors' | 'network' | 'parse';

export interface AmazonAuthor {
  name: string;
  role: string | null;
  url: string | null;
}

export interface AmazonMoney {
  display: string;
  amount: number | null;
  currency: string | null;
}

export interface AmazonBookSearchCandidate {
  source: 'amazon_search';
  marketplace: string;
  query: string;
  position: number;
  asin: string;
  title: string;
  authors: string[];
  language: string | null;
  publicationDate: string | null;
  format: string | null;
  productUrl: string;
  imageUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  price: AmazonMoney | null;
  isSponsored: boolean;
  badges: string[];
  score: number;
  officialSignals: string[];
  rawByline: string;
}

export interface AmazonBook {
  source: 'amazon';
  marketplace: string;
  asin: string | null;
  title: string;
  subtitle: string | null;
  authors: AmazonAuthor[];
  url: string | null;
  canonicalUrl: string | null;
  imageUrl: string | null;
  binding: string | null;
  language: string | null;
  publisher: string | null;
  publicationDate: string | null;
  edition: string | null;
  pages: number | null;
  isbn10: string | null;
  isbn13: string | null;
  dimensions: string | null;
  weight: string | null;
  rating: number | null;
  reviewCount: number | null;
  price: AmazonMoney | null;
  listPrice: AmazonMoney | null;
  availability: string | null;
  description: string | null;
  about: string[];
  categories: string[];
  bestSellersRank: string | null;
  rawDetails: Record<string, string>;
  confidence: number;
  officialSignals: string[];
  extractedAt: string;
}

export interface AmazonScrapeResult {
  source: 'amazon';
  status: AmazonScrapeStatus;
  marketplace: string;
  query: string;
  searchUrl: string;
  selectedCandidate: AmazonBookSearchCandidate | null;
  candidates: AmazonBookSearchCandidate[];
  book: AmazonBook | null;
  searchFetchVia: string | null;
  detailFetchVia: string | null;
  warnings: string[];
}

export interface AmazonSearchUrlOptions {
  marketplace?: string;
  searchIndex?: string;
}

export type AmazonProxyBuilder = (url: string) => string;

export interface AmazonScrapeOptions extends AmazonSearchUrlOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxCandidates?: number;
  includeSponsored?: boolean;
  proxyChain?: AmazonProxyBuilder[];
  requestHeaders?: Record<string, string>;
  extractedAt?: string;
}

export interface AmazonHtmlFetchResult {
  html: string;
  via: string;
  finalUrl: string;
  status: number;
}

export interface AmazonParseOptions extends AmazonSearchUrlOptions {
  query?: string;
  baseUrl?: string;
  includeSponsored?: boolean;
  maxCandidates?: number;
  selectedCandidate?: AmazonBookSearchCandidate | null;
  extractedAt?: string;
}

export class AmazonScrapeError extends Error {
  kind: AmazonFetchFailureKind;
  status?: number;
  via?: string;

  constructor(kind: AmazonFetchFailureKind, message: string, extra: { status?: number; via?: string } = {}) {
    super(message);
    this.name = 'AmazonScrapeError';
    this.kind = kind;
    this.status = extra.status;
    this.via = extra.via;
  }
}

const DEFAULT_MARKETPLACE = 'com.br';
const DEFAULT_SEARCH_INDEX = 'stripbooks';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CANDIDATE_LIMIT = 12;

const MARKETPLACE_HOSTS: Record<string, string> = {
  br: 'www.amazon.com.br',
  'com.br': 'www.amazon.com.br',
  us: 'www.amazon.com',
  com: 'www.amazon.com',
  uk: 'www.amazon.co.uk',
  'co.uk': 'www.amazon.co.uk',
  ca: 'www.amazon.ca',
  de: 'www.amazon.de',
  es: 'www.amazon.es',
  fr: 'www.amazon.fr',
  it: 'www.amazon.it',
  mx: 'www.amazon.com.mx',
  'com.mx': 'www.amazon.com.mx',
  jp: 'www.amazon.co.jp',
  'co.jp': 'www.amazon.co.jp',
  au: 'www.amazon.com.au',
  'com.au': 'www.amazon.com.au',
  in: 'www.amazon.in'
};

const DEFAULT_PROXY_CHAIN: AmazonProxyBuilder[] = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`
];

const TOKEN_STOPWORDS = new Set([
  'a',
  'o',
  'as',
  'os',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'e',
  'em',
  'para',
  'por',
  'um',
  'uma',
  'the',
  'and',
  'of',
  'book',
  'livro',
  'edicao',
  'edition'
]);

const DERIVATIVE_TITLE_HINTS = [
  'resumo',
  'summary',
  'analise',
  'analysis',
  'guia',
  'guide',
  'workbook',
  'caderno',
  'comentado',
  'comments'
];

export function getAmazonHost(marketplace = DEFAULT_MARKETPLACE): string {
  const clean = marketplace
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^amazon\./, '')
    .replace(/^www\.amazon\./, '');

  if (marketplace.includes('amazon.') && marketplace.includes('.')) {
    return marketplace
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
  }

  return MARKETPLACE_HOSTS[clean] || `www.amazon.${clean || DEFAULT_MARKETPLACE}`;
}

export function buildAmazonSearchUrl(query: string, options: AmazonSearchUrlOptions = {}): string {
  const trimmed = normalizeText(query);
  const host = getAmazonHost(options.marketplace);
  const params = new URLSearchParams();
  params.set('k', trimmed);
  params.set('i', options.searchIndex || DEFAULT_SEARCH_INDEX);
  params.set('ref', 'nb_sb_noss');
  return `https://${host}/s?${params.toString()}`;
}

export async function fetchAmazonHtml(
  url: string,
  options: Pick<AmazonScrapeOptions, 'fetcher' | 'timeoutMs' | 'proxyChain' | 'requestHeaders'> = {}
): Promise<AmazonHtmlFetchResult> {
  const fetcher = options.fetcher || globalThis.fetch;
  if (!fetcher) {
    throw new AmazonScrapeError('network', 'fetch is not available in this environment');
  }

  const attempts = [
    { via: 'direct', url },
    ...(options.proxyChain ?? DEFAULT_PROXY_CHAIN).map((buildProxy, index) => ({
      via: `proxy:${index + 1}`,
      url: buildProxy(url)
    }))
  ];

  let lastError: AmazonScrapeError | null = null;

  for (const attempt of attempts) {
    try {
      const response = await fetchWithTimeout(fetcher, attempt.url, {
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        headers: options.requestHeaders || {}
      });

      if (!response.ok) {
        throw new AmazonScrapeError('http', `Amazon returned HTTP ${response.status}`, {
          status: response.status,
          via: attempt.via
        });
      }

      const html = await response.text();
      if (isAmazonBlockedHtml(html)) {
        throw new AmazonScrapeError('blocked', 'Amazon returned a bot-check or captcha page', {
          status: response.status,
          via: attempt.via
        });
      }

      return {
        html,
        via: response.headers.get('x-amazon-fetch-via') || attempt.via,
        finalUrl: response.headers.get('x-amazon-final-url') || response.url || attempt.url,
        status: response.status
      };
    } catch (unknownError) {
      if (unknownError instanceof AmazonScrapeError) {
        lastError = unknownError;
      } else {
        const message = unknownError instanceof Error ? unknownError.message : 'Network failure';
        const kind: AmazonFetchFailureKind =
          unknownError instanceof TypeError ? 'cors' : 'network';
        lastError = new AmazonScrapeError(kind, message, { via: attempt.via });
      }
    }
  }

  throw lastError || new AmazonScrapeError('network', 'Amazon fetch failed');
}

export function createAmazonHtmlEndpointFetcher(
  fetcher: typeof fetch = globalThis.fetch,
  endpoint = '/api/amazon-html'
): typeof fetch {
  return async (input, init) => {
    const targetUrl = input instanceof Request ? input.url : String(input);
    const proxyUrl = `${endpoint}?url=${encodeURIComponent(targetUrl)}`;
    return fetcher(proxyUrl, {
      method: 'GET',
      signal: init?.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    });
  };
}

export function parseAmazonSearchHtml(
  html: string,
  options: AmazonParseOptions = {}
): AmazonBookSearchCandidate[] {
  if (isAmazonBlockedHtml(html)) {
    throw new AmazonScrapeError('blocked', 'Amazon search HTML is a bot-check page');
  }

  const doc = parseHtml(html);
  const marketplace = options.marketplace || DEFAULT_MARKETPLACE;
  const baseUrl = options.baseUrl || `https://${getAmazonHost(marketplace)}/`;
  const query = normalizeText(options.query || '');
  const maxCandidates = options.maxCandidates || DEFAULT_CANDIDATE_LIMIT;
  const cards = Array.from(
    doc.querySelectorAll('[data-component-type="s-search-result"][data-asin], .s-result-item[data-asin]')
  );

  const candidates: AmazonBookSearchCandidate[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    const asin = normalizeText(card.getAttribute('data-asin') || '');
    if (!asin || seen.has(asin)) {
      continue;
    }

    const titleLink =
      card.querySelector('[data-cy="title-recipe"] a[href*="/dp/"]') ||
      card.querySelector('a[href*="/dp/"]') ||
      card.querySelector('a[href*="/gp/product/"]');
    const href = titleLink?.getAttribute('href') || '';
    const productUrl = buildCanonicalProductUrl(asin, href, baseUrl, marketplace);
    const titleNode =
      card.querySelector('[data-cy="title-recipe"] h2 span') ||
      card.querySelector('h2[aria-label]') ||
      card.querySelector('h2 span');
    const title = normalizeText(titleNode?.textContent || titleNode?.getAttribute('aria-label') || '');
    if (!title || !productUrl) {
      continue;
    }

    const titleBlock = card.querySelector('[data-cy="title-recipe"]') || card;
    const rawByline = findSearchByline(titleBlock);
    const byline = parseSearchByline(rawByline);
    const isSponsored = isSponsoredSearchCard(card);

    if (isSponsored && options.includeSponsored === false) {
      continue;
    }

    const image = card.querySelector('img.s-image, img[data-image-latency="s-product-image"], img');
    const imageUrl =
      image?.getAttribute('src') ||
      image?.getAttribute('data-src') ||
      image?.getAttribute('data-old-hires') ||
      null;
    const rating = parseRating(
      textOrAttr(card.querySelector('[data-cy="reviews-ratings-slot"] .a-icon-alt, .a-icon-alt'), 'aria-label')
    );
    const reviewCount = extractSearchReviewCount(card);
    const format = normalizeText(
      card.querySelector('[data-cy="price-recipe"] a.a-text-bold')?.textContent ||
        card.querySelector('[data-cy="format-recipe"]')?.textContent ||
        ''
    );
    const priceText = normalizeText(
      card.querySelector('[data-cy="price-recipe"] .a-price .a-offscreen')?.textContent ||
        card.querySelector('.a-price .a-offscreen')?.textContent ||
        ''
    );
    const badges = Array.from(card.querySelectorAll('.a-badge-text, [data-component-type="s-status-badge-component"]'))
      .map((node) => normalizeText(node.textContent || ''))
      .filter(Boolean);

    const candidate: AmazonBookSearchCandidate = {
      source: 'amazon_search',
      marketplace,
      query,
      position: candidates.length + 1,
      asin,
      title,
      authors: byline.authors,
      language: byline.language,
      publicationDate: byline.publicationDate,
      format: format || null,
      productUrl,
      imageUrl,
      rating,
      reviewCount,
      price: priceText ? parseMoney(priceText) : null,
      isSponsored,
      badges,
      score: 0,
      officialSignals: [],
      rawByline
    };

    candidate.officialSignals = getCandidateSignals(candidate);
    candidate.score = scoreAmazonCandidate(candidate, query);
    seen.add(asin);
    candidates.push(candidate);

    if (candidates.length >= maxCandidates) {
      break;
    }
  }

  return candidates.sort((left, right) => right.score - left.score);
}

export function pickOfficialAmazonCandidate(
  candidates: AmazonBookSearchCandidate[]
): AmazonBookSearchCandidate | null {
  const organic = candidates.filter((candidate) => !candidate.isSponsored);
  const pool = organic.length ? organic : candidates;
  return [...pool].sort((left, right) => {
    const scoreDiff = right.score - left.score;
    if (scoreDiff) return scoreDiff;
    const reviewDiff = (right.reviewCount || 0) - (left.reviewCount || 0);
    if (reviewDiff) return reviewDiff;
    return left.position - right.position;
  })[0] || null;
}

export function parseAmazonBookDetailHtml(html: string, options: AmazonParseOptions = {}): AmazonBook {
  if (isAmazonBlockedHtml(html)) {
    throw new AmazonScrapeError('blocked', 'Amazon detail HTML is a bot-check page');
  }

  const doc = parseHtml(html);
  const marketplace = options.marketplace || DEFAULT_MARKETPLACE;
  const baseUrl = options.baseUrl || options.selectedCandidate?.productUrl || `https://${getAmazonHost(marketplace)}/`;
  const selectedCandidate = options.selectedCandidate || null;
  const rawDetails = collectProductDetails(doc);
  const canonicalUrl = getAbsoluteUrl(doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '', baseUrl);
  const asin =
    normalizeText(
      (doc.querySelector('#ASIN') as HTMLInputElement | null)?.value ||
        doc.querySelector('[name="ASIN"]')?.getAttribute('value') ||
        doc.querySelector('[data-csa-c-asin]')?.getAttribute('data-csa-c-asin') ||
        extractAsinFromUrl(canonicalUrl || baseUrl) ||
        selectedCandidate?.asin ||
        ''
    ) || null;
  const title = normalizeText(
    doc.querySelector('#productTitle')?.textContent ||
      doc.querySelector('#ebooksProductTitle')?.textContent ||
      selectedCandidate?.title ||
      ''
  );
  const subtitleText = normalizeText(doc.querySelector('#productSubtitle')?.textContent || '');
  const subtitle = subtitleText || null;
  const subtitleParts = subtitleText.split(/\s+[–-]\s+/);
  const binding = normalizeText(subtitleParts[0] || selectedCandidate?.format || '') || null;
  const authors = extractDetailAuthors(doc, baseUrl, selectedCandidate);
  const imageUrl = extractDetailImageUrl(doc) || selectedCandidate?.imageUrl || null;
  const rating = parseRating(
    textOrAttr(doc.querySelector('#acrPopover .a-icon-alt, [data-hook="rating-out-of-text"], .a-icon-alt'), 'title')
  ) ?? selectedCandidate?.rating ?? null;
  const reviewCount = parseReviewCount(
    textOrAttr(doc.querySelector('#acrCustomerReviewText, [data-hook="total-review-count"]'), 'aria-label')
  ) ?? selectedCandidate?.reviewCount ?? null;
  const priceText = normalizeText(
    doc.querySelector('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen')?.textContent ||
      doc.querySelector('#tp_price_block_total_price_ww .a-offscreen')?.textContent ||
      doc.querySelector('#price .a-offscreen')?.textContent ||
      doc.querySelector('.a-price .a-offscreen')?.textContent ||
      selectedCandidate?.price?.display ||
      ''
  );
  const listPriceText = normalizeText(
    doc.querySelector('.a-text-price .a-offscreen')?.textContent ||
      doc.querySelector('#listPrice .a-offscreen')?.textContent ||
      ''
  );
  const description = normalizeText(
    doc.querySelector('#bookDescription_feature_div .a-expander-content')?.textContent ||
      doc.querySelector('#productDescription')?.textContent ||
      ''
  );
  const about = Array.from(
    doc.querySelectorAll('#feature-bullets li span.a-list-item, #bookDescription_feature_div li')
  )
    .map((node) => normalizeText(node.textContent || ''))
    .filter(Boolean);
  const categories = extractCategories(doc);
  const publisher = pickDetail(rawDetails, ['editora', 'publisher']);
  const publicationDate =
    pickDetail(rawDetails, ['data da publicacao', 'publication date']) ||
    selectedCandidate?.publicationDate ||
    null;
  const language = pickDetail(rawDetails, ['idioma', 'language']) || selectedCandidate?.language || null;
  const pagesText = pickDetail(rawDetails, ['numero de paginas', 'print length', 'pages']);
  const book: AmazonBook = {
    source: 'amazon',
    marketplace,
    asin,
    title,
    subtitle,
    authors,
    url: canonicalUrl || (asin ? `https://${getAmazonHost(marketplace)}/dp/${asin}` : selectedCandidate?.productUrl || null),
    canonicalUrl,
    imageUrl,
    binding,
    language,
    publisher,
    publicationDate,
    edition: pickDetail(rawDetails, ['edicao', 'edition']),
    pages: pagesText ? parseInteger(pagesText) : null,
    isbn10: pickDetail(rawDetails, ['isbn-10', 'isbn 10']),
    isbn13: pickDetail(rawDetails, ['isbn-13', 'isbn 13']),
    dimensions: pickDetail(rawDetails, ['dimensoes', 'dimensions']),
    weight: pickDetail(rawDetails, ['peso do produto', 'item weight']),
    rating,
    reviewCount,
    price: priceText ? parseMoney(priceText) : selectedCandidate?.price || null,
    listPrice: listPriceText ? parseMoney(listPriceText) : null,
    availability: normalizeText(doc.querySelector('#availability span')?.textContent || '') || null,
    description: description || null,
    about,
    categories,
    bestSellersRank: pickDetail(rawDetails, ['ranking dos mais vendidos', 'best sellers rank']),
    rawDetails,
    confidence: 0,
    officialSignals: [],
    extractedAt: options.extractedAt || new Date().toISOString()
  };

  book.officialSignals = getBookSignals(book, selectedCandidate);
  book.confidence = scoreAmazonBook(book);
  return book;
}

export async function scrapeAmazonBookFromSearch(
  query: string,
  options: AmazonScrapeOptions = {}
): Promise<AmazonScrapeResult> {
  const trimmed = normalizeText(query);
  const marketplace = options.marketplace || DEFAULT_MARKETPLACE;
  const searchUrl = buildAmazonSearchUrl(trimmed, options);
  const warnings: string[] = [];

  if (!trimmed) {
    return {
      source: 'amazon',
      status: 'no_results',
      marketplace,
      query: trimmed,
      searchUrl,
      selectedCandidate: null,
      candidates: [],
      book: null,
      searchFetchVia: null,
      detailFetchVia: null,
      warnings: ['empty_query']
    };
  }

  const searchFetch = await fetchAmazonHtml(searchUrl, options);
  const candidates = parseAmazonSearchHtml(searchFetch.html, {
    ...options,
    marketplace,
    query: trimmed,
    baseUrl: searchFetch.finalUrl || searchUrl
  });
  const selectedCandidate = pickOfficialAmazonCandidate(candidates);

  if (!selectedCandidate) {
    return {
      source: 'amazon',
      status: 'no_results',
      marketplace,
      query: trimmed,
      searchUrl,
      selectedCandidate: null,
      candidates,
      book: null,
      searchFetchVia: searchFetch.via,
      detailFetchVia: null,
      warnings
    };
  }

  try {
    const detailFetch = await fetchAmazonHtml(selectedCandidate.productUrl, options);
    const book = parseAmazonBookDetailHtml(detailFetch.html, {
      ...options,
      marketplace,
      query: trimmed,
      baseUrl: selectedCandidate.productUrl,
      selectedCandidate
    });

    return {
      source: 'amazon',
      status: 'success',
      marketplace,
      query: trimmed,
      searchUrl,
      selectedCandidate,
      candidates,
      book,
      searchFetchVia: searchFetch.via,
      detailFetchVia: detailFetch.via,
      warnings
    };
  } catch (unknownError) {
    const message = unknownError instanceof Error ? unknownError.message : 'detail_fetch_failed';
    warnings.push(message);
    return {
      source: 'amazon',
      status: 'partial',
      marketplace,
      query: trimmed,
      searchUrl,
      selectedCandidate,
      candidates,
      book: buildBookFromCandidate(selectedCandidate, options.extractedAt),
      searchFetchVia: searchFetch.via,
      detailFetchVia: null,
      warnings
    };
  }
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  url: string,
  options: { timeoutMs: number; headers: Record<string, string> }
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetcher(url, {
      method: 'GET',
      mode: 'cors',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        ...options.headers
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseHtml(html: string): Document {
  if (typeof DOMParser === 'undefined') {
    throw new AmazonScrapeError('parse', 'DOMParser is required. Run this module in a browser-like client.');
  }

  return new DOMParser().parseFromString(html, 'text/html');
}

function isAmazonBlockedHtml(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('validatecaptcha') ||
    lower.includes('robot check') ||
    lower.includes('enter the characters you see below') ||
    lower.includes('api-services-support@amazon')
  );
}

function normalizeText(value: string): string {
  return value
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value: string): string {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*:\s*$/, '')
    .toLowerCase();
}

function normalizeForCompare(value: string): string {
  return normalizeKey(value).replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

function tokenize(value: string): string[] {
  return normalizeForCompare(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !TOKEN_STOPWORDS.has(token));
}

function overlapScore(query: string, title: string): number {
  const queryTokens = new Set(tokenize(query));
  const titleTokens = new Set(tokenize(title));
  if (!queryTokens.size || !titleTokens.size) {
    return 0;
  }

  let hits = 0;
  queryTokens.forEach((token) => {
    if (titleTokens.has(token)) hits += 1;
  });
  return hits / queryTokens.size;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(0.99, Number(value.toFixed(4))));
}

function getAbsoluteUrl(href: string, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href || null;
  }
}

function buildCanonicalProductUrl(
  asin: string,
  href: string,
  baseUrl: string,
  marketplace: string
): string {
  const fromHref = getAbsoluteUrl(href, baseUrl);
  const host = getAmazonHost(marketplace);
  const extractedAsin = extractAsinFromUrl(fromHref || '') || asin;
  return extractedAsin ? `https://${host}/dp/${extractedAsin}` : fromHref || '';
}

function extractAsinFromUrl(url: string): string | null {
  const match = url.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})(?:[/?#]|$)/i);
  return match?.[1] || null;
}

function textOrAttr(node: Element | null, attr: string): string {
  if (!node) return '';
  return normalizeText(node.getAttribute(attr) || node.textContent || '');
}

function parseDecimal(value: string): number | null {
  const multiplier = /\b(mil|k|thousand)\b/i.test(value) ? 1000 : 1;
  const match = normalizeText(value).match(/\d+(?:[.,]\d+)*/);
  if (!match) return null;

  let raw = match[0];
  const comma = raw.lastIndexOf(',');
  const dot = raw.lastIndexOf('.');

  if (comma >= 0 && dot >= 0) {
    const decimalSep = comma > dot ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    raw = raw.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (comma >= 0) {
    const parts = raw.split(',');
    raw = parts[parts.length - 1]?.length === 3 ? parts.join('') : raw.replace(',', '.');
  } else if (dot >= 0) {
    const parts = raw.split('.');
    raw = parts[parts.length - 1]?.length === 3 ? parts.join('') : raw;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed * multiplier : null;
}

function parseInteger(value: string): number | null {
  const decimal = parseDecimal(value);
  return decimal === null ? null : Math.round(decimal);
}

function parseRating(value: string): number | null {
  const rating = parseDecimal(value);
  return rating !== null && rating <= 5 ? rating : null;
}

function parseReviewCount(value: string): number | null {
  return parseInteger(value.replace(/[()]/g, ''));
}

function parseMoney(display: string): AmazonMoney {
  const clean = normalizeText(display);
  const currency =
    clean.includes('R$') ? 'BRL' : clean.includes('$') ? 'USD' : clean.includes('EUR') || clean.includes('€') ? 'EUR' : clean.includes('£') ? 'GBP' : null;

  return {
    display: clean,
    amount: parseDecimal(clean),
    currency
  };
}

function extractSearchReviewCount(card: Element): number | null {
  const reviewBlock = card.querySelector('[data-cy="reviews-block"]') || card;
  const values = Array.from(
    reviewBlock.querySelectorAll('a[aria-label], a.s-underline-text, a[href*="customerReviews"]')
  )
    .map((node) => textOrAttr(node, 'aria-label'))
    .filter((text) => /\d/.test(text) && !/\b(estrela|star|rating)\b/i.test(text))
    .map(parseReviewCount)
    .filter((count): count is number => count !== null);

  if (values.length) {
    return Math.max(...values);
  }

  return parseReviewCount(normalizeText(reviewBlock.textContent || '').replace(/\b\d(?:[,.]\d)?\s+de\s+5\b/i, ''));
}

function findSearchByline(titleBlock: Element): string {
  const rows = Array.from(titleBlock.querySelectorAll('.a-row, [class*="a-color-secondary"]'));
  const candidate = rows
    .map((row) => normalizeText(row.textContent || ''))
    .find((text) => /\b(por|by)\b/i.test(text) || /\b(edicao|edition|edição)\b/i.test(text));
  return candidate || '';
}

function parseSearchByline(value: string): {
  language: string | null;
  authors: string[];
  publicationDate: string | null;
} {
  const raw = normalizeText(value);
  const parts = raw
    .split(/\s+\|\s+|\s+•\s+/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
  let language: string | null = null;
  let authors: string[] = [];
  let publicationDate: string | null = null;

  for (const part of parts) {
    if (/^(edicao|edição|edition)\b/i.test(part)) {
      language = normalizeText(part.replace(/^(edicao|edição|edition)\s*/i, '')) || null;
      continue;
    }

    if (/^(por|by)\b/i.test(part)) {
      authors = splitAuthorNames(part.replace(/^(por|by)\s*/i, ''));
      continue;
    }

    if (/\b\d{4}\b|\b\d{1,2}\s+[a-zA-Z]{3,}/.test(part)) {
      publicationDate = part;
    }
  }

  return { language, authors, publicationDate };
}

function splitAuthorNames(value: string): string[] {
  return normalizeText(value)
    .split(/\s+(?:e|and|&)\s+|,\s*/)
    .map((name) => normalizeText(name))
    .filter(Boolean);
}

function isSponsoredSearchCard(card: Element): boolean {
  const text = normalizeKey(card.textContent || '');
  return (
    text.includes('patrocinado') ||
    text.includes('sponsored') ||
    Boolean(card.querySelector('[aria-label*="Sponsored"], [aria-label*="Patrocinado"], .puis-sponsored-label-text'))
  );
}

function getCandidateSignals(candidate: AmazonBookSearchCandidate): string[] {
  const signals = ['amazon_search_result'];
  if (candidate.asin) signals.push('asin');
  if (/\/dp\/[A-Z0-9]{10}/i.test(candidate.productUrl)) signals.push('canonical_dp_url');
  if (!candidate.isSponsored) signals.push('organic_result');
  if (candidate.format && /(capa|paperback|hardcover|kindle|livro|book)/i.test(candidate.format)) {
    signals.push('book_format');
  }
  if (candidate.rating !== null || candidate.reviewCount !== null) signals.push('customer_reviews');
  return signals;
}

function scoreAmazonCandidate(candidate: AmazonBookSearchCandidate, query: string): number {
  const queryOverlap = overlapScore(query, candidate.title);
  const normalizedTitle = normalizeForCompare(candidate.title);
  const normalizedQuery = normalizeForCompare(query);
  const derivativePenalty = DERIVATIVE_TITLE_HINTS.some(
    (hint) => normalizedTitle.includes(hint) && !normalizedQuery.includes(hint)
  )
    ? 0.14
    : 0;
  const positionBoost = Math.max(0, 0.08 - (candidate.position - 1) * 0.012);
  const score =
    0.16 +
    queryOverlap * 0.42 +
    (candidate.asin ? 0.12 : 0) +
    (candidate.productUrl ? 0.08 : 0) +
    (candidate.isSponsored ? -0.22 : 0.12) +
    (candidate.authors.length ? 0.05 : 0) +
    (candidate.imageUrl ? 0.04 : 0) +
    (candidate.rating !== null ? 0.02 : 0) +
    (candidate.reviewCount !== null ? 0.02 : 0) +
    (candidate.format ? 0.04 : 0) +
    positionBoost -
    derivativePenalty;

  return clampScore(score);
}

function collectProductDetails(doc: Document): Record<string, string> {
  const details: Record<string, string> = {};

  Array.from(doc.querySelectorAll('#detailBullets_feature_div li > span.a-list-item, .detail-bullet-list li > span.a-list-item')).forEach(
    (item) => {
      const labelNode = item.querySelector('.a-text-bold');
      const label = normalizeKey(labelNode?.textContent || '');
      if (!label) return;

      const clone = item.cloneNode(true) as Element;
      clone.querySelector('.a-text-bold')?.remove();
      const value = normalizeText(clone.textContent || '');
      if (value) details[label] = value;
    }
  );

  Array.from(doc.querySelectorAll('#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #productOverview_feature_div tr')).forEach(
    (row) => {
      const label = normalizeKey(row.querySelector('th, .a-span3')?.textContent || '');
      const value = normalizeText(row.querySelector('td, .a-span9')?.textContent || '');
      if (label && value) details[label] = value;
    }
  );

  Array.from(doc.querySelectorAll('.rpi-attribute-content')).forEach((attribute) => {
    const label = normalizeKey(attribute.querySelector('.rpi-attribute-label')?.textContent || '');
    const value = normalizeText(attribute.querySelector('.rpi-attribute-value')?.textContent || '');
    if (label && value) details[label] = value;
  });

  return details;
}

function pickDetail(details: Record<string, string>, labels: string[]): string | null {
  for (const label of labels) {
    const key = normalizeKey(label);
    if (details[key]) {
      return details[key];
    }
  }
  return null;
}

function extractDetailAuthors(
  doc: Document,
  baseUrl: string,
  selectedCandidate: AmazonBookSearchCandidate | null
): AmazonAuthor[] {
  const byline = doc.querySelector('#bylineInfo');
  const authors = byline
    ? Array.from(byline.querySelectorAll('.author'))
        .map((node) => {
          const anchor = node.querySelector('a');
          const name = normalizeText(anchor?.textContent || node.textContent || '');
          const role = normalizeText(node.querySelector('.contribution')?.textContent || '')
            .replace(/[(),]/g, '')
            .trim();
          return {
            name,
            role: role || null,
            url: getAbsoluteUrl(anchor?.getAttribute('href') || '', baseUrl)
          };
        })
        .filter((author) => author.name)
    : [];

  if (authors.length) {
    return authors;
  }

  return (selectedCandidate?.authors || []).map((name) => ({
    name,
    role: 'Autor',
    url: null
  }));
}

function extractDetailImageUrl(doc: Document): string | null {
  const landing = doc.querySelector('#landingImage, img.a-dynamic-image');
  const dynamic = landing?.getAttribute('data-a-dynamic-image') || '';
  if (dynamic) {
    try {
      const parsed = JSON.parse(dynamic) as Record<string, unknown>;
      const first = Object.keys(parsed)[0];
      if (first) return first;
    } catch {
      // Keep the normal src fallback below.
    }
  }

  return landing?.getAttribute('data-old-hires') || landing?.getAttribute('src') || null;
}

function extractCategories(doc: Document): string[] {
  const categories = [
    ...Array.from(doc.querySelectorAll('#wayfinding-breadcrumbs_feature_div a')),
    ...Array.from(doc.querySelectorAll('ul.zg_hrsr a'))
  ]
    .map((node) => normalizeText(node.textContent || ''))
    .filter(Boolean);

  return Array.from(new Set(categories));
}

function getBookSignals(
  book: AmazonBook,
  selectedCandidate: AmazonBookSearchCandidate | null
): string[] {
  const signals = ['amazon_detail_page'];
  if (book.asin) signals.push('asin');
  if (book.canonicalUrl || (book.url && /\/dp\/[A-Z0-9]{10}/i.test(book.url))) signals.push('canonical_dp_url');
  if (book.isbn10 || book.isbn13) signals.push('isbn');
  if (book.publisher) signals.push('publisher');
  if (book.publicationDate) signals.push('publication_date');
  if (book.rawDetails && Object.keys(book.rawDetails).length) signals.push('product_details');
  if (selectedCandidate && !selectedCandidate.isSponsored) signals.push('organic_search_result');
  return signals;
}

function scoreAmazonBook(book: AmazonBook): number {
  const score =
    0.28 +
    (book.asin ? 0.14 : 0) +
    (book.title ? 0.12 : 0) +
    (book.authors.length ? 0.1 : 0) +
    (book.isbn10 || book.isbn13 ? 0.12 : 0) +
    (book.publisher ? 0.07 : 0) +
    (book.publicationDate ? 0.06 : 0) +
    (book.canonicalUrl ? 0.05 : 0) +
    (Object.keys(book.rawDetails).length ? 0.07 : 0) +
    (book.description ? 0.04 : 0) +
    (book.rating !== null || book.reviewCount !== null ? 0.02 : 0);

  return clampScore(score);
}

function buildBookFromCandidate(candidate: AmazonBookSearchCandidate, extractedAt?: string): AmazonBook {
  const book: AmazonBook = {
    source: 'amazon',
    marketplace: candidate.marketplace,
    asin: candidate.asin,
    title: candidate.title,
    subtitle: null,
    authors: candidate.authors.map((name) => ({ name, role: 'Autor', url: null })),
    url: candidate.productUrl,
    canonicalUrl: candidate.productUrl,
    imageUrl: candidate.imageUrl,
    binding: candidate.format,
    language: candidate.language,
    publisher: null,
    publicationDate: candidate.publicationDate,
    edition: null,
    pages: null,
    isbn10: null,
    isbn13: null,
    dimensions: null,
    weight: null,
    rating: candidate.rating,
    reviewCount: candidate.reviewCount,
    price: candidate.price,
    listPrice: null,
    availability: null,
    description: null,
    about: [],
    categories: [],
    bestSellersRank: null,
    rawDetails: {},
    confidence: clampScore(candidate.score * 0.72),
    officialSignals: [...candidate.officialSignals, 'search_result_only'],
    extractedAt: extractedAt || new Date().toISOString()
  };
  return book;
}
