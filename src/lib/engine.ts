import {
  COMPLEMENTARY_SOURCE_IDS,
  DEFAULT_GEMINI_API_KEY,
  DEFAULT_GEMINI_MODEL,
  DIRECT_RESULTS_LIMIT,
  FOCUSED_SEARCH_CATALOG_SOURCE_IDS,
  FOCUSED_SEARCH_METADATA_SOURCE_IDS,
  FOCUSED_SEARCH_SOURCE_IDS,
  FULLTEXT_SOURCE_IDS,
  METADATA_SOURCE_IDS,
  RATE_LIMIT_DEFAULT_SECONDS
} from '$lib/constants';
import { fetchAnnasSearch, type AnnasResult } from '$lib/annas';
import {
  attachSearchMetadata,
  buildCitationFromParts,
  buildSparseCandidatePrompt,
  compareTitleOverlap,
  createSparseCandidate,
  dedupeSparseCandidates,
  formatAuthorsDisplay,
  isSparseCitation,
  markParserSource,
  parseCitation,
  safeJsonParse
} from '$lib/parser';
import type {
  FetchError,
  ManualSearchEntry,
  MaterialType,
  ParsedCitation,
  PdfStatus,
  SearchAdapter,
  SearchAdapterResponse,
  SearchResult,
  SearchRunCallbacks,
  SearchSettings,
  SearchMode,
  SearchSourceKind,
  SourceStatusEntry,
  SparseCandidate
} from '$lib/types';
import {
  getSourceConfidenceWeight,
  getSourcePriority,
  makeManualUrl,
  normalizeForCompare,
  normalizeTitleForCompare,
  normalizeWhitespace,
  titleCaseName,
  tokenize
} from '$lib/utils';

type FetchResponseType = 'json' | 'text' | 'arrayBuffer';

interface FetchWithFallbackResult<T = unknown> {
  data: T;
  via: string;
  contentType: string;
  finalUrl: string;
  status: number;
}

interface PdfProbeResult {
  status: PdfStatus;
  reason: string;
  contentType?: string;
  finalUrl?: string;
}

type DirectSearchPhase = 'metadata' | 'fulltext' | 'complementary';

interface DirectSearchAdapter extends SearchAdapter {
  phase: DirectSearchPhase;
  sourceKind: SearchSourceKind;
}

const METADATA_SOURCE_SET = new Set<string>([...METADATA_SOURCE_IDS]);

const SOURCE_NAME_TO_ID: Record<string, string> = {
  'Internet Archive': 'internet_archive',
  'Open Library': 'open_library',
  DOAJ: 'doaj',
  'Semantic Scholar': 'semantic_scholar',
  Unpaywall: 'unpaywall',
  BASE: 'base',
  'CORE.ac.uk': 'core',
  CrossRef: 'crossref',
  'Google Books': 'google_books',
  ERIC: 'eric',
  'PubMed / PMC': 'pmc',
  'SciELO Brasil': 'scielo_brasil',
  OpenAlex: 'openalex',
  'Project Gutenberg': 'project_gutenberg',
  Zenodo: 'zenodo',
  'Senado Federal': 'senado_federal',
  'Marxists Internet Archive': 'marxists_archive',
  HAL: 'hal',
  "Anna's Archive": 'annas_archive'
};

export const pdfProbeCache = new Map<string, Promise<PdfProbeResult>>();

function normalizeDoi(value: string | null | undefined): string {
  return normalizeWhitespace(String(value || ''))
    .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

function pickYear(value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const match = String(value).match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? match[1] : null;
}

function normalizeAuthorNames(value: unknown): string[] {
  if (!value) {
    return [];
  }

  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((entry) => {
      if (!entry) {
        return [];
      }
      if (typeof entry === 'string') {
        return entry.split(/\s*;\s*|\s*,\s*(?=[A-ZÀ-Ý][a-zà-ÿ])/).filter(Boolean);
      }
      if (typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const joined = normalizeWhitespace(
          `${String(record.firstName || record.given || '')} ${String(record.lastName || record.family || record.name || '')}`
        );
        return joined ? [joined] : [];
      }
      return [];
    })
    .map((entry) => normalizeWhitespace(String(entry)))
    .filter(Boolean);
}

function buildResultKey(result: Partial<SearchResult>): string {
  const doi = normalizeDoi(result.doi);
  if (doi) {
    return `doi:${doi}`;
  }

  const url = normalizeWhitespace(String(result.pdfUrl || result.epubUrl || result.pageUrl || result.url || ''));
  if (url) {
    return `url:${normalizeForCompare(url)}`;
  }

  const title = normalizeTitleForCompare(result.title || '');
  const authors = normalizeTitleForCompare(
    Array.isArray(result.authors) ? result.authors.join(' ') : result.author || ''
  );
  const year = pickYear(result.year || result.publishedDate || null);
  return `meta:${title}::${authors}::${year || ''}`;
}

function getResultStrength(result: Partial<SearchResult>): number {
  const verifiedScore =
    result.pdfStatus === 'ok' ? 0.4 : result.pdfUrl ? 0.24 : result.epubUrl ? 0.2 : result.pageUrl ? 0.12 : 0;
  const confidenceScore = Math.max(Math.min(Number(result.confidence || 0), 1), 0) * 0.3;
  const sourceWeight = getSourceConfidenceWeight(result.sourceId) * 0.8;
  const metadataRichness =
    (normalizeDoi(result.doi) ? 0.08 : 0) +
    (Array.isArray(result.authors) && result.authors.length ? 0.05 : result.author ? 0.04 : 0) +
    (result.year ? 0.03 : 0) +
    (result.abstract ? 0.03 : 0) +
    (result.materialType && result.materialType !== 'unknown' ? 0.02 : 0);

  return verifiedScore + confidenceScore + sourceWeight + metadataRichness;
}

function mergeResultPair(existing: SearchResult, incoming: SearchResult): SearchResult {
  const preferred = getResultStrength(incoming) >= getResultStrength(existing) ? incoming : existing;
  const fallback = preferred === incoming ? existing : incoming;

  return {
    ...fallback,
    ...preferred,
    paperId: preferred.paperId || fallback.paperId || null,
    title:
      preferred.title && preferred.title.length >= (fallback.title || '').length
        ? preferred.title
        : fallback.title,
    author:
      preferred.author && preferred.author !== 'Autor não identificado'
        ? preferred.author
        : fallback.author,
    authors:
      (preferred.authors && preferred.authors.length ? preferred.authors : fallback.authors) || [],
    year: preferred.year || fallback.year || null,
    publishedDate: preferred.publishedDate || fallback.publishedDate || null,
    abstract: preferred.abstract || fallback.abstract || null,
    journal: preferred.journal || fallback.journal || null,
    url: preferred.url || fallback.url || preferred.pageUrl || fallback.pageUrl || null,
    pdfUrl: preferred.pdfUrl || fallback.pdfUrl || null,
    epubUrl: preferred.epubUrl || fallback.epubUrl || null,
    pageUrl: preferred.pageUrl || fallback.pageUrl || preferred.url || fallback.url || null,
    coverUrl: preferred.coverUrl || fallback.coverUrl || null,
    materialType:
      preferred.materialType !== 'unknown' ? preferred.materialType : fallback.materialType,
    pdfStatus:
      preferred.pdfStatus === 'ok'
        ? 'ok'
        : fallback.pdfStatus === 'ok'
          ? 'ok'
          : preferred.pdfStatus !== 'none'
            ? preferred.pdfStatus
            : fallback.pdfStatus,
    pdfStatusReason: preferred.pdfStatusReason || fallback.pdfStatusReason || '',
    source: preferred.source || fallback.source,
    sourceId: preferred.sourceId || fallback.sourceId,
    sourceKind: preferred.sourceKind || fallback.sourceKind,
    sourceWeight: Math.max(preferred.sourceWeight || 0, fallback.sourceWeight || 0),
    confidence: Math.max(preferred.confidence || 0, fallback.confidence || 0),
    doi: preferred.doi || fallback.doi || null,
    categories: preferred.categories?.length ? preferred.categories : fallback.categories || [],
    extra: { ...(fallback.extra || {}), ...(preferred.extra || {}) }
  };
}

function mergeResultsCollection(
  existing: SearchResult[],
  incoming: SearchResult[]
): { merged: SearchResult[]; newItems: SearchResult[] } {
  const map = new Map<string, SearchResult>();
  const existingKeys = new Set<string>();

  existing.forEach((result) => {
    const key = buildResultKey(result);
    existingKeys.add(key);
    map.set(key, result);
  });

  const newItems: SearchResult[] = [];

  incoming.forEach((result) => {
    const key = buildResultKey(result);
    const previous = map.get(key);

    if (previous) {
      map.set(key, mergeResultPair(previous, result));
      return;
    }

    map.set(key, result);
    if (!existingKeys.has(key)) {
      newItems.push(result);
    }
  });

  return {
    merged: Array.from(map.values()),
    newItems
  };
}

function hasMeaningfulAuthors(authors: ParsedCitation['authors']): boolean {
  return (
    Array.isArray(authors) &&
    authors.some((author) => author && author.lastName && author.lastName !== 'ET AL.')
  );
}

export function getPrimaryAuthorQuery(citation: ParsedCitation): string {
  const firstAuthor = citation.authors.find((author) => author.lastName !== 'ET AL.');
  if (!firstAuthor) {
    return '';
  }

  return normalizeWhitespace(`${firstAuthor.firstName} ${titleCaseName(firstAuthor.lastName)}`);
}

function getPrimaryAuthorLastName(citation: ParsedCitation): string {
  const firstAuthor = citation.authors.find((author) => author.lastName !== 'ET AL.');
  if (!firstAuthor) {
    return '';
  }

  return titleCaseName(firstAuthor.lastName);
}

function getSearchTitle(
  citation: ParsedCitation,
  options: { includeSubtitle?: boolean; preferMainTitle?: boolean } = {}
): string {
  const { includeSubtitle = false, preferMainTitle = false } = options;
  const mainTitle = normalizeWhitespace(citation.title || '');
  const subtitle = normalizeWhitespace(citation.subtitle || '');

  if (!mainTitle) {
    return '';
  }

  if (preferMainTitle || !subtitle) {
    return mainTitle;
  }

  const subtitleTokenCount = tokenize(subtitle).length;
  if (!includeSubtitle && subtitleTokenCount > 0) {
    return mainTitle;
  }

  return normalizeWhitespace([mainTitle, subtitle].filter(Boolean).join(' '));
}

interface QueryOptions {
  includeSubtitle?: boolean;
  includeAuthor?: boolean;
  authorMode?: 'full' | 'last' | 'full_last';
  includeYear?: boolean;
  includePublisher?: boolean;
  preferMainTitle?: boolean;
}

export function buildSearchQuery(
  citation: ParsedCitation,
  options: QueryOptions = {}
): string {
  const {
    includeSubtitle = false,
    includeAuthor = true,
    authorMode = 'full',
    includeYear = false,
    includePublisher = false,
    preferMainTitle = false
  } = options;

  const titleQuery = getSearchTitle(citation, {
    includeSubtitle,
    preferMainTitle
  });
  const authorFull = includeAuthor ? getPrimaryAuthorQuery(citation) : '';
  const authorLast = includeAuthor ? getPrimaryAuthorLastName(citation) : '';
  const authorQuery =
    authorMode === 'last'
      ? authorLast
      : authorMode === 'full_last'
        ? normalizeWhitespace([authorFull, authorLast].filter(Boolean).join(' '))
        : authorFull;

  return normalizeWhitespace(
    [
      titleQuery,
      authorQuery,
      includeYear ? citation.year : '',
      includePublisher ? citation.publisher : ''
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function buildQueryVariants(citation: ParsedCitation): string[] {
  const variants = [
    citation.doi ? normalizeDoi(citation.doi) : '',
    buildSearchQuery(citation, { includeSubtitle: false, includeAuthor: true, authorMode: 'full' }),
    buildSearchQuery(citation, { includeSubtitle: false, includeAuthor: true, authorMode: 'last' }),
    buildSearchQuery(citation, { includeSubtitle: true, includeAuthor: true, authorMode: 'full' }),
    buildSearchQuery(citation, { includeSubtitle: false, includeAuthor: false, preferMainTitle: true }),
    buildSearchQuery(citation, { includeSubtitle: true, includeAuthor: false })
  ];

  return Array.from(
    new Set(
      variants
        .map((entry) => normalizeWhitespace(entry))
        .filter(Boolean)
    )
  );
}

function buildSiteSearchQuery(
  citation: ParsedCitation,
  domain: string,
  extraTerms = ''
): string {
  const quotedTitle = getSearchTitle(citation, {
    includeSubtitle: false,
    preferMainTitle: true
  });
  const quotedAuthor = getPrimaryAuthorQuery(citation);
  return normalizeWhitespace(
    [
      `site:${domain}`,
      quotedTitle ? `"${quotedTitle}"` : '',
      quotedAuthor ? `"${quotedAuthor}"` : '',
      extraTerms
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function buildExactWebQuery(citation: ParsedCitation, extraTerms = ''): string {
  const title = getSearchTitle(citation, {
    includeSubtitle: false,
    preferMainTitle: true
  });
  const author = getPrimaryAuthorQuery(citation);

  return normalizeWhitespace(
    [title ? `"${title}"` : '', author ? `"${author}"` : '', extraTerms].filter(Boolean).join(' ')
  );
}

function buildBroadSiteSearchQuery(
  citation: ParsedCitation,
  domain: string,
  extraTerms = ''
): string {
  return normalizeWhitespace(
    [
      `site:${domain}`,
      buildSearchQuery(citation, {
        includeSubtitle: false,
        includeAuthor: true,
        authorMode: 'full',
        preferMainTitle: true
      }),
      extraTerms
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function makeFetchError(
  kind: FetchError['kind'],
  message: string,
  extra: Partial<FetchError> = {}
): FetchError {
  const error = new Error(message) as FetchError;
  error.kind = kind;
  Object.assign(error, extra);
  return error;
}

async function parseResponseByType(
  response: Response,
  responseType: FetchResponseType
): Promise<unknown> {
  if (responseType === 'arrayBuffer') {
    return response.arrayBuffer();
  }

  if (responseType === 'text') {
    return response.text();
  }

  return response.json();
}

export async function fetchWithFallbacks<T = unknown>(
  url: string,
  options: {
    responseType?: FetchResponseType;
    headers?: Record<string, string>;
    allowProxy?: boolean;
  } = {}
): Promise<FetchWithFallbackResult<T>> {
  const { responseType = 'json', headers = {}, allowProxy = true } = options;
  const attempts = [{ id: 'direct', url }];

  if (allowProxy) {
    attempts.push(
      { id: 'allorigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
      { id: 'corsproxy', url: `https://corsproxy.io/?${encodeURIComponent(url)}` }
    );
  }

  let lastError: FetchError | null = null;

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: 'GET',
        mode: 'cors',
        headers: {
          Accept:
            responseType === 'json'
              ? 'application/json,text/plain,*/*'
              : responseType === 'arrayBuffer'
                ? 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5'
                : 'text/plain,*/*',
          ...headers
        }
      });

      if (response.status === 429) {
        const retryAfter =
          Number(response.headers.get('retry-after')) || RATE_LIMIT_DEFAULT_SECONDS;
        throw makeFetchError('rate_limit', 'Limite de requisições atingido', {
          retryAfter
        });
      }

      if (!response.ok) {
        throw makeFetchError('http', `HTTP ${response.status}`, {
          status: response.status
        });
      }

      return {
        data: (await parseResponseByType(response, responseType)) as T,
        via: attempt.id,
        contentType: response.headers.get('content-type') || '',
        finalUrl: response.url || attempt.url,
        status: response.status
      };
    } catch (unknownError) {
      const error = unknownError as Partial<FetchError> | TypeError;

      if ((error as FetchError).kind === 'rate_limit') {
        throw error as FetchError;
      }

      const message = error instanceof Error ? error.message : 'Falha de rede';
      const kind: FetchError['kind'] =
        (error as FetchError).kind || (error instanceof TypeError ? 'cors' : 'network');

      lastError = makeFetchError(kind, message, {
        status: (error as FetchError).status || 0
      });

      if (kind === 'http' && (error as FetchError).status && (error as FetchError).status! < 500) {
        throw lastError;
      }
    }
  }

  throw lastError || makeFetchError('cors', 'CORS bloqueado');
}

function sniffBinarySignature(buffer: ArrayBuffer): 'pdf' | 'html' | 'unknown' {
  const bytes = new Uint8Array(buffer || new ArrayBuffer(0)).slice(0, 320);
  const ascii = Array.from(bytes)
    .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ' '))
    .join('')
    .toLowerCase();

  if (ascii.startsWith('%pdf-')) {
    return 'pdf';
  }

  if (
    ascii.includes('<html') ||
    ascii.includes('<!doctype') ||
    ascii.includes('not found') ||
    ascii.includes('404')
  ) {
    return 'html';
  }

  return 'unknown';
}

async function probePdfUrl(url: string): Promise<PdfProbeResult> {
  if (!url) {
    return { status: 'none', reason: '' };
  }

  if (pdfProbeCache.has(url)) {
    return pdfProbeCache.get(url) as Promise<PdfProbeResult>;
  }

  const task = (async () => {
    try {
      const payload = await fetchWithFallbacks<ArrayBuffer>(url, {
        responseType: 'arrayBuffer',
        headers: { Range: 'bytes=0-2047' }
      });

      const signature = sniffBinarySignature(payload.data);
      const contentType = payload.contentType || '';

      if (/application\/pdf/i.test(contentType) || signature === 'pdf') {
        return {
          status: 'ok',
          reason: '',
          contentType,
          finalUrl: payload.finalUrl || url
        } satisfies PdfProbeResult;
      }

      if (signature === 'html' || /text\/html|application\/xhtml\+xml/i.test(contentType)) {
        return {
          status: 'broken',
          reason: 'Página HTML em vez de PDF',
          contentType,
          finalUrl: payload.finalUrl || url
        } satisfies PdfProbeResult;
      }

      return {
        status: 'unknown',
        reason: 'Arquivo não pôde ser confirmado',
        contentType,
        finalUrl: payload.finalUrl || url
      } satisfies PdfProbeResult;
    } catch (unknownError) {
      const error = unknownError as FetchError;
      if (error.kind === 'http' && [404, 410].includes(error.status || 0)) {
        return {
          status: 'broken',
          reason: `HTTP ${error.status}`,
          contentType: '',
          finalUrl: url
        } satisfies PdfProbeResult;
      }

      return {
        status: 'unknown',
        reason: error.message || 'Falha ao validar PDF',
        contentType: '',
        finalUrl: url
      } satisfies PdfProbeResult;
    }
  })();

  pdfProbeCache.set(url, task);
  return task;
}

export async function probeIsPdf(url: string): Promise<PdfProbeResult> {
  return probePdfUrl(url);
}

function hasDownloadOrPage(result: Partial<SearchResult>): boolean {
  return Boolean(result.pdfUrl || result.epubUrl || result.pageUrl);
}

async function collectVariantResults(
  citation: ParsedCitation,
  queries: string[],
  runner: (query: string) => Promise<SearchResult[]>
): Promise<SearchResult[]> {
  let collected: SearchResult[] = [];
  let lastError: unknown = null;

  for (const query of queries) {
    if (!query) {
      continue;
    }

    try {
      const batch = (await runner(query)).filter(hasDownloadOrPage);
      collected = dedupeResults([...collected, ...batch]);

      const strongEnough = collected.some(
        (result) =>
          (result.confidence || 0) >= 0.82 &&
          (Boolean(result.doi) || result.pdfStatus === 'ok' || Boolean(result.pdfUrl || result.epubUrl))
      );

      if (strongEnough || collected.length >= DIRECT_RESULTS_LIMIT) {
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!collected.length && lastError) {
    throw lastError;
  }

  return collected;
}

function mapMaterialType(value: string, source = ''): MaterialType {
  const clean = normalizeForCompare(`${value || ''} ${source || ''}`);
  if (!clean) {
    return 'unknown';
  }
  if (/(thesis|dissertation|dissertacao|tese|monografia)/.test(clean)) {
    return 'thesis';
  }
  if (/(preprint|posted content)/.test(clean)) {
    return 'preprint';
  }
  if (/(report|working paper|technical report|relatorio)/.test(clean)) {
    return 'report';
  }
  if (/(chapter|book section|book chapter|capitulo)/.test(clean)) {
    return 'chapter';
  }
  if (/(book|monograph|internet archive|open library|google books)/.test(clean)) {
    return 'book';
  }
  if (
    /(article|journal|paper|periodico|revista|crossref|semantic scholar|openalex|zenodo|hal|pubmed|pmc|doaj|scielo|eric)/.test(
      clean
    )
  ) {
    return 'article';
  }
  return 'unknown';
}

function inferMaterialType(
  citation: ParsedCitation,
  source: string,
  partial: Record<string, unknown> = {}
): MaterialType {
  const explicit = mapMaterialType(String(partial.materialType || partial.type || ''), source);
  if (explicit !== 'unknown') {
    return explicit;
  }

  const citationType = mapMaterialType(citation.type || '', source);
  if (citationType !== 'unknown') {
    return citationType;
  }

  return mapMaterialType(source, source);
}

function getTitleMatchDetails(left: string, right: string): {
  overlap: number;
  coverage: number;
  exact: boolean;
  prefix: boolean;
  leftCount: number;
  rightCount: number;
} {
  const leftNorm = normalizeTitleForCompare(left);
  const rightNorm = normalizeTitleForCompare(right);
  const leftTokens = new Set(tokenize(leftNorm));
  const rightTokens = new Set(tokenize(rightNorm));
  const sharedTokens = Array.from(leftTokens).filter((token) => rightTokens.has(token));
  const overlap = leftTokens.size ? sharedTokens.length / leftTokens.size : 0;
  const coverage = Math.max(
    leftTokens.size && rightTokens.size
      ? sharedTokens.length / Math.min(leftTokens.size, rightTokens.size)
      : 0,
    compareTitleOverlap(leftNorm, rightNorm)
  );
  return {
    overlap,
    coverage,
    leftCount: leftTokens.size,
    rightCount: rightTokens.size,
    exact: Boolean(leftNorm && rightNorm && leftNorm === rightNorm),
    prefix: Boolean(
      leftNorm &&
        rightNorm &&
        (leftNorm.startsWith(rightNorm) ||
          rightNorm.startsWith(leftNorm) ||
          leftNorm.includes(rightNorm) ||
          rightNorm.includes(leftNorm))
    )
  };
}

function isLikelyArticleAboutWork(
  citation: ParsedCitation,
  candidate: Pick<SearchResult, 'title' | 'materialType'>
): boolean {
  if (candidate.materialType !== 'article' || !citation.title || !candidate.title) {
    return false;
  }

  const titleDetails = getTitleMatchDetails(
    `${citation.title} ${citation.subtitle || ''}`,
    candidate.title
  );
  const candidateTokens = tokenize(candidate.title);
  const citationTokens = tokenize(`${citation.title} ${citation.subtitle || ''}`);
  const extraTokenRatio = candidateTokens.length / Math.max(citationTokens.length, 1);
  const analyticalMarkers = /\b(acerca|sobre|em|revisitando|relendo|teoria|categoria|leitura|resenha|ensaio|análise|analise|crítica|critica|reforma|atualidade|contribui)/i;

  return !titleDetails.exact && titleDetails.coverage >= 0.7 && extraTokenRatio >= 2.2 && analyticalMarkers.test(candidate.title);
}

function shouldPreferBookCatalogs(citation: ParsedCitation): boolean {
  return (
    citation.type === 'book' ||
    citation.type === 'unknown' ||
    Boolean(citation.isbn) ||
    isSparseCitation(citation)
  );
}

function getSparseCandidateTitle(candidate: SparseCandidate): string {
  return normalizeWhitespace([candidate.title, candidate.subtitle].filter(Boolean).join(' '));
}

function rankSparseCandidatesForPrompt(
  rawText: string,
  fallbackParsed: ParsedCitation,
  candidates: SparseCandidate[]
): SparseCandidate[] {
  const fallbackTitle = normalizeWhitespace(
    [fallbackParsed.title, fallbackParsed.subtitle].filter(Boolean).join(' ')
  );
  const sourceBonus: Record<string, number> = {
    'Google Books': 0.18,
    'Open Library': 0.16,
    'Project Gutenberg': 0.15,
    'SciELO Brasil': 0.04,
    CrossRef: 0
  };
  const analyticalMarkers = /\b(acerca|about|sobre|revisitando|relendo|reading|leitura|review|resenha|ensaio|analise|analysis|critica|critical|debate|teoria|theory|categoria|atualidade|contribui)\b/i;
  const ranked = candidates
    .map((candidate) => {
      const candidateTitle = getSparseCandidateTitle(candidate);
      const rawDetails = getTitleMatchDetails(candidateTitle, rawText);
      const fallbackDetails = getTitleMatchDetails(candidateTitle, fallbackTitle);
      const titleCoverage = Math.max(rawDetails.coverage, fallbackDetails.coverage);
      const authorText = formatAuthorsDisplay(candidate.authors);
      const authorInRaw = authorText ? compareTitleOverlap(authorText, rawText) : 0;
      const expectedAuthorText = formatAuthorsDisplay(fallbackParsed.authors);
      const expectedAuthorScore =
        expectedAuthorText && authorText ? compareTitleOverlap(expectedAuthorText, authorText) : 0.5;
      const candidateExtraRatio = rawDetails.leftCount / Math.max(rawDetails.rightCount, 1);
      let score =
        (candidate.score || 0) +
        titleCoverage * 0.18 +
        authorInRaw * 0.2 +
        (sourceBonus[candidate.source] || 0) +
        (candidate.isbn ? 0.08 : 0);

      if (rawDetails.prefix || fallbackDetails.prefix || rawDetails.exact || fallbackDetails.exact) {
        score += 0.08;
      }

      if (candidate.type === 'book') {
        score += 0.24;
      } else if (candidate.type === 'article') {
        score -= 0.28;
      }

      if (candidate.type === 'article' && candidate.doi) {
        score -= 0.08;
      }

      if (candidate.type === 'article' && authorInRaw < 0.3) {
        score -= 0.12;
      }

      if (expectedAuthorText && authorText && expectedAuthorScore < 0.25) {
        score -= 0.65;
      }

      if (titleCoverage < 0.45 && !rawDetails.prefix && !fallbackDetails.prefix) {
        score -= 0.55;
      }

      if (
        candidate.type === 'article' &&
        candidateExtraRatio >= 1.45 &&
        analyticalMarkers.test(candidateTitle)
      ) {
        score -= 0.35;
      }

      return {
        ...candidate,
        score: Number(Math.max(0, Math.min(1.5, score)).toFixed(3))
      };
    })
    .filter((candidate) => candidate.score >= 0.16)
    .sort((left, right) => right.score - left.score);

  const books = ranked.filter((candidate) => candidate.type === 'book');
  if (!books.length) {
    return ranked.slice(0, 8);
  }

  return [...books, ...ranked.filter((candidate) => candidate.type !== 'book').slice(0, 2)].slice(0, 8);
}

function canUseSparseCandidateAsFallback(candidate: SparseCandidate | null): candidate is SparseCandidate {
  return Boolean(
    candidate &&
      candidate.type === 'book' &&
      candidate.score >= 0.55 &&
      ['Google Books', 'Open Library', 'Project Gutenberg'].includes(candidate.source)
  );
}

export function calculateConfidence(
  citation: ParsedCitation,
  candidate: Pick<
    SearchResult,
    | 'title'
    | 'author'
    | 'authors'
    | 'year'
    | 'publishedDate'
    | 'pdfUrl'
    | 'epubUrl'
    | 'pageUrl'
    | 'materialType'
    | 'pdfStatus'
    | 'sourceId'
  > & {
    doi?: string | null;
  }
): number {
  if (
    citation.doi &&
    candidate.doi &&
    normalizeDoi(citation.doi) === normalizeDoi(candidate.doi)
  ) {
    return 1;
  }

  const titleDetails = getTitleMatchDetails(
    `${citation.title} ${citation.subtitle || ''}`,
    candidate.title || ''
  );
  const authorScore = hasMeaningfulAuthors(citation.authors)
    ? compareTitleOverlap(
        formatAuthorsDisplay(citation.authors),
        Array.isArray(candidate.authors) && candidate.authors.length
          ? candidate.authors.join(', ')
          : candidate.author || ''
      )
    : 0.5;
  const availabilityScore =
    candidate.pdfStatus === 'ok'
      ? 1
      : candidate.pdfUrl
        ? 0.82
        : candidate.epubUrl
          ? 0.78
          : candidate.pageUrl
            ? 0.66
            : 0.3;
  const yearScore =
    citation.year && (candidate.year || candidate.publishedDate)
      ? String(candidate.year || candidate.publishedDate).includes(String(citation.year))
        ? 1
        : 0
      : 0.5;
  const typeScore =
    citation.type && citation.type !== 'unknown'
      ? candidate.materialType === citation.type
        ? 1
        : candidate.materialType === 'unknown'
          ? 0.5
          : 0.12
      : candidate.materialType !== 'unknown'
        ? 0.78
        : 0.52;
  const titleWeight = hasMeaningfulAuthors(citation.authors) || citation.year ? 0.44 : 0.58;
  const authorWeight = hasMeaningfulAuthors(citation.authors) ? 0.16 : 0.04;
  const sourceBonus = getSourceConfidenceWeight(candidate.sourceId);
  const titleScore = titleDetails.exact
    ? 1
    : Math.max(titleDetails.coverage * 0.92, titleDetails.overlap * 0.84);
  const extraTitleRatio = titleDetails.rightCount / Math.max(titleDetails.leftCount, 1);
  let score =
    titleScore * titleWeight +
    authorScore * authorWeight +
    availabilityScore * 0.12 +
    yearScore * 0.08 +
    typeScore * 0.08 +
    sourceBonus +
    (candidate.doi ? 0.05 : 0) +
    (Array.isArray(candidate.authors) && candidate.authors.length ? 0.03 : 0);

  if (titleDetails.exact) {
    score += 0.16;
  } else if (titleDetails.prefix) {
    score += 0.08;
  } else if (titleDetails.coverage > 0.86) {
    score += 0.06;
  }

  if (hasMeaningfulAuthors(citation.authors) && authorScore < 0.2 && !candidate.doi) {
    score *= 0.58;
  }

  if (!titleDetails.exact && extraTitleRatio >= 2.4) {
    score *= candidate.materialType === 'article' ? 0.56 : 0.72;
  }

  if (isLikelyArticleAboutWork(citation, candidate as SearchResult)) {
    score *= 0.42;
  }

  if (
    citation.year &&
    (candidate.year || candidate.publishedDate) &&
    !String(candidate.year || candidate.publishedDate).includes(String(citation.year))
  ) {
    score -= 0.08;
  }

  if (titleDetails.coverage < 0.32 && !titleDetails.exact && !titleDetails.prefix) {
    score *= hasMeaningfulAuthors(citation.authors) ? 0.62 : 0.48;
  }

  return Number(Math.max(Math.min(score, 1), 0.03).toFixed(2));
}

export function buildResult(
  citation: ParsedCitation,
  source: string,
  partial: Record<string, unknown>
): SearchResult {
  const sourceId =
    normalizeWhitespace(String(partial.sourceId || '')) ||
    SOURCE_NAME_TO_ID[source] ||
    normalizeForCompare(source).replace(/\s+/g, '_') ||
    undefined;
  const authors = normalizeAuthorNames(partial.authors || partial.author);
  const authorFallback = hasMeaningfulAuthors(citation.authors)
    ? formatAuthorsDisplay(citation.authors)
    : '';
  const result: SearchResult = {
    paperId: normalizeWhitespace(String(partial.paperId || partial.id || '')) || null,
    title: normalizeWhitespace(String(partial.title || citation.title || 'Sem título')),
    author: normalizeWhitespace(String(partial.author || authors.join(', ') || authorFallback)),
    authors,
    year: pickYear(partial.year) || null,
    publishedDate: normalizeWhitespace(String(partial.publishedDate || '')) || null,
    abstract: normalizeWhitespace(String(partial.abstract || '')) || null,
    journal: normalizeWhitespace(String(partial.journal || partial.containerTitle || '')) || null,
    url:
      normalizeWhitespace(String(partial.url || partial.pageUrl || partial.pdfUrl || partial.epubUrl || '')) || null,
    pdfUrl: normalizeWhitespace(String(partial.pdfUrl || '')) || null,
    epubUrl: normalizeWhitespace(String(partial.epubUrl || '')) || null,
    pageUrl: normalizeWhitespace(String(partial.pageUrl || partial.pdfUrl || partial.epubUrl || '')) || null,
    coverUrl: normalizeWhitespace(String(partial.coverUrl || '')) || null,
    materialType: inferMaterialType(citation, source, partial),
    pdfStatus: (partial.pdfStatus as PdfStatus) || (partial.pdfUrl ? 'unknown' : 'none'),
    pdfStatusReason: normalizeWhitespace(String(partial.pdfStatusReason || '')),
    source,
    sourceId,
    sourceKind: (partial.sourceKind as SearchSourceKind) || 'fulltext',
    sourceWeight: getSourceConfidenceWeight(sourceId),
    confidence: 0,
    doi: normalizeDoi(String(partial.doi || '')) || null,
    categories: Array.isArray(partial.categories)
      ? partial.categories.map((entry) => normalizeWhitespace(String(entry))).filter(Boolean)
      : [],
    extra:
      partial.extra && typeof partial.extra === 'object'
        ? (partial.extra as Record<string, unknown>)
        : null
  };

  result.confidence =
    typeof partial.confidence === 'number'
      ? partial.confidence
      : calculateConfidence(citation, result);

  return result;
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  return mergeResultsCollection([], results).merged.sort((left, right) => right.confidence - left.confidence);
}

function getResultConfidenceThreshold(citation: ParsedCitation | null): number {
  if (!citation || !citation.title) {
    return 0.05;
  }

  const authors = hasMeaningfulAuthors(citation.authors);
  if (!authors && !citation.year) {
    return 0.48;
  }
  if (!authors || !citation.year) {
    return 0.34;
  }
  return 0.26;
}

function toCitationAuthors(names: string[]): ParsedCitation['authors'] {
  return names
    .map((name) => normalizeWhitespace(name))
    .filter(Boolean)
    .map((name) => {
      const parts = name.split(' ').filter(Boolean);
      const lastName = (parts.pop() || '').toUpperCase();
      return {
        lastName,
        firstName: parts.join(' ')
      };
    })
    .filter((author) => author.lastName || author.firstName);
}

function inferTrailingAuthorFromSparseRaw(
  rawText: string,
  fallbackParsed: ParsedCitation
): ParsedCitation | null {
  if (!isSparseCitation(fallbackParsed) || hasMeaningfulAuthors(fallbackParsed.authors)) {
    return null;
  }

  const words = normalizeWhitespace(rawText).split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    return null;
  }

  const particles = new Set(['da', 'de', 'do', 'das', 'dos', 'del', 'della', 'di', 'von', 'van']);
  const knownMononyms = new Set(['lenin', 'stalin', 'trotsky']);
  const isNameToken = (token: string) => {
    const clean = token.replace(/[.,;:!?()[\]"']/g, '');
    return Boolean(clean) && clean[0] === clean[0].toUpperCase() && /[A-Za-zÀ-ÿ]/.test(clean);
  };
  const isParticle = (token: string) => particles.has(normalizeForCompare(token));
  const hasViableTitle = (tokens: string[]) => {
    const title = normalizeWhitespace(tokens.join(' '));
    return title.length >= 4 && tokenize(title).length >= 1;
  };
  const buildParsed = (titleTokens: string[], authorNames: string[]): ParsedCitation | null => {
    if (!hasViableTitle(titleTokens)) {
      return null;
    }

    const parsed: ParsedCitation = {
      ...fallbackParsed,
      title: normalizeWhitespace(titleTokens.join(' ')),
      subtitle: null,
      authors: toCitationAuthors(authorNames),
      raw: normalizeWhitespace(rawText)
    };
    parsed.rawQuery = buildSearchQuery(parsed);
    return parsed.authors.length && parsed.title ? parsed : null;
  };

  const lastFour = words.slice(-4);
  if (
    lastFour.length === 4 &&
    lastFour.every(isNameToken) &&
    hasViableTitle(words.slice(0, -4))
  ) {
    return buildParsed(words.slice(0, -4), [
      `${lastFour[0]} ${lastFour[1]}`,
      `${lastFour[2]} ${lastFour[3]}`
    ]);
  }

  const lastThree = words.slice(-3);
  if (
    lastThree.length === 3 &&
    isNameToken(lastThree[0]) &&
    isParticle(lastThree[1]) &&
    isNameToken(lastThree[2]) &&
    hasViableTitle(words.slice(0, -3))
  ) {
    return buildParsed(words.slice(0, -3), [lastThree.join(' ')]);
  }

  const lastOne = words[words.length - 1];
  if (
    lastOne &&
    knownMononyms.has(normalizeForCompare(lastOne)) &&
    hasViableTitle(words.slice(0, -1))
  ) {
    return buildParsed(words.slice(0, -1), [lastOne]);
  }

  const lastTwo = words.slice(-2);
  if (
    lastTwo.length === 2 &&
    lastTwo.every(isNameToken) &&
    hasViableTitle(words.slice(0, -2))
  ) {
    return buildParsed(words.slice(0, -2), [lastTwo.join(' ')]);
  }

  return null;
}

function chooseBestMetadataResult(
  citation: ParsedCitation,
  results: SearchResult[]
): SearchResult | null {
  const prefersBookCatalogs = shouldPreferBookCatalogs(citation);
  const ranked = [...results]
    .filter((result) => (result.confidence || 0) >= getResultConfidenceThreshold(citation))
    .filter((result) => {
      if (!prefersBookCatalogs || citation.doi) {
        return true;
      }

      const titleDetails = getTitleMatchDetails(
        `${citation.title} ${citation.subtitle || ''}`,
        result.title
      );
      const authorScore = hasMeaningfulAuthors(citation.authors)
        ? compareTitleOverlap(
            formatAuthorsDisplay(citation.authors),
            Array.isArray(result.authors) && result.authors.length
              ? result.authors.join(', ')
              : result.author || ''
          )
        : 0.5;
      const extraTitleRatio = titleDetails.rightCount / Math.max(titleDetails.leftCount, 1);
      const closeTitle =
        titleDetails.exact ||
        titleDetails.prefix ||
        (titleDetails.coverage >= 0.88 && extraTitleRatio <= 1.35);

      if (hasMeaningfulAuthors(citation.authors) && authorScore < 0.35) {
        return false;
      }

      if (result.materialType !== 'book' && result.materialType !== 'unknown') {
        return false;
      }

      return (
        closeTitle &&
        extraTitleRatio <= 1.35 &&
        authorScore >= 0.45 &&
        !isLikelyArticleAboutWork(citation, result)
      );
    })
    .sort((left, right) => {
      const doiDiff = Number(Boolean(right.doi)) - Number(Boolean(left.doi));
      if (doiDiff) {
        return doiDiff;
      }

      const pdfDiff = Number(Boolean(right.pdfUrl || right.epubUrl)) - Number(Boolean(left.pdfUrl || left.epubUrl));
      if (pdfDiff) {
        return pdfDiff;
      }

      const coverageDiff =
        getTitleMatchDetails(`${citation.title} ${citation.subtitle || ''}`, right.title).coverage -
        getTitleMatchDetails(`${citation.title} ${citation.subtitle || ''}`, left.title).coverage;
      if (coverageDiff) {
        return coverageDiff;
      }

      return getResultStrength(right) - getResultStrength(left);
    });

  return ranked[0] || null;
}

function enrichCitationWithMetadata(
  citation: ParsedCitation,
  metadataResult: SearchResult | null
): ParsedCitation {
  if (!metadataResult) {
    return citation;
  }

  const titleMatch = getTitleMatchDetails(
    `${citation.title} ${citation.subtitle || ''}`,
    metadataResult.title || ''
  );
  if (shouldPreferBookCatalogs(citation) && !citation.doi) {
    const authorScore = hasMeaningfulAuthors(citation.authors)
      ? compareTitleOverlap(
          formatAuthorsDisplay(citation.authors),
          Array.isArray(metadataResult.authors) && metadataResult.authors.length
            ? metadataResult.authors.join(', ')
            : metadataResult.author || ''
        )
      : 0.5;
    const extraTitleRatio = titleMatch.rightCount / Math.max(titleMatch.leftCount, 1);
    const closeTitle =
      titleMatch.exact ||
      titleMatch.prefix ||
      (titleMatch.coverage >= 0.88 && extraTitleRatio <= 1.35);

    if (
      metadataResult.materialType !== 'book' ||
      !closeTitle ||
      (hasMeaningfulAuthors(citation.authors) && authorScore < 0.45)
    ) {
      return citation;
    }
  }

  const recoveredAuthors =
    Array.isArray(metadataResult.authors) && metadataResult.authors.length
      ? toCitationAuthors(metadataResult.authors)
      : [];
  const nextCitation: ParsedCitation = {
    ...citation,
    title:
      titleMatch.coverage >= 0.8 && metadataResult.title ? metadataResult.title : citation.title,
    authors: hasMeaningfulAuthors(citation.authors)
      ? citation.authors
      : recoveredAuthors.length
        ? recoveredAuthors
        : citation.authors,
    year: citation.year || (pickYear(metadataResult.year || metadataResult.publishedDate) as string | null),
    doi: citation.doi || metadataResult.doi || null,
    type:
      citation.type !== 'unknown'
        ? citation.type
        : metadataResult.materialType === 'book' ||
            metadataResult.materialType === 'thesis' ||
            metadataResult.materialType === 'article'
          ? metadataResult.materialType
          : citation.type,
    rawQuery: citation.rawQuery,
    _searchEnriched: citation._searchEnriched || Boolean(metadataResult.doi || recoveredAuthors.length),
    _searchCandidateSource: citation._searchCandidateSource || metadataResult.source
  };

  nextCitation.rawQuery = buildSearchQuery(nextCitation);
  return nextCitation;
}

function createBaseResponse(
  source: string,
  sourceId: string,
  tier: 1 | 2 | 3,
  manualUrl: string
): SearchAdapterResponse {
  return {
    source,
    sourceId,
    tier,
    status: 'success',
    manualUrl: manualUrl || '',
    results: [],
    error: null
  };
}

function buildGoogleFallbackUrl(citation: ParsedCitation): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`${buildExactWebQuery(citation)} filetype:pdf`)}`;
}

function isRelevantEnoughForCitation(citation: ParsedCitation, result: SearchResult): boolean {
  if (!shouldPreferBookCatalogs(citation)) {
    return true;
  }

  const titleDetails = getTitleMatchDetails(
    `${citation.title} ${citation.subtitle || ''}`,
    result.title || ''
  );
  const authorScore = hasMeaningfulAuthors(citation.authors)
    ? compareTitleOverlap(
        formatAuthorsDisplay(citation.authors),
        Array.isArray(result.authors) && result.authors.length
          ? result.authors.join(', ')
          : result.author || ''
      )
    : 0.5;
  const confidence = result.confidence || 0;

  if (hasMeaningfulAuthors(citation.authors) && authorScore < 0.18 && confidence < 0.72) {
    return false;
  }

  if (result.materialType === 'article') {
    if (isLikelyArticleAboutWork(citation, result)) {
      return false;
    }

    if (!titleDetails.exact && !titleDetails.prefix && confidence < 0.68) {
      return false;
    }
  }

  if (
    titleDetails.coverage < 0.42 &&
    !titleDetails.exact &&
    !titleDetails.prefix &&
    confidence < 0.78
  ) {
    return false;
  }

  return true;
}

async function hardenResultEntry(entry: SearchResult): Promise<SearchResult> {
  if (!entry || !entry.pdfUrl) {
    return entry;
  }

  const probe = await probePdfUrl(entry.pdfUrl);
  const hardened: SearchResult = {
    ...entry,
    pdfStatus: probe.status,
    pdfStatusReason: probe.reason || entry.pdfStatusReason || ''
  };

  if (probe.status === 'broken') {
    hardened.pdfUrl = null;
  }

  return hardened;
}

function finalizeAdapterResponse(
  citation: ParsedCitation,
  response: SearchAdapterResponse
): SearchAdapterResponse {
  const finalized: SearchAdapterResponse = {
    ...response,
    results: dedupeResults(response.results || [])
      .filter((result) => (result.confidence || 0) >= getResultConfidenceThreshold(citation))
      .filter((result) => isRelevantEnoughForCitation(citation, result))
      .slice(0, DIRECT_RESULTS_LIMIT)
  };

  if (!finalized.results.length && finalized.status === 'success') {
    finalized.status = 'no_results';
  }

  if (finalized.status === 'success' && !finalized.manualUrl) {
    finalized.manualUrl = buildGoogleFallbackUrl(citation);
  }

  return finalized;
}

async function hardenAdapterResponse(
  citation: ParsedCitation,
  response: SearchAdapterResponse
): Promise<SearchAdapterResponse> {
  if (response.sourceId === 'annas_archive') {
    return response;
  }

  if (response.tier !== 1 || !response.results.length) {
    return finalizeAdapterResponse(citation, response);
  }

  const hardenedResults = (
    await Promise.all(response.results.map((entry) => hardenResultEntry(entry)))
  ).filter((entry) => entry && hasDownloadOrPage(entry));

  return finalizeAdapterResponse(citation, {
    ...response,
    results: hardenedResults
  });
}

function mapAdapterFailure(
  adapter: SearchAdapter,
  citation: ParsedCitation,
  error: FetchError
): SearchAdapterResponse {
  const base = createBaseResponse(adapter.source, adapter.sourceId, adapter.tier, adapter.manualUrl(citation));

  if (error.kind === 'rate_limit') {
    base.status = 'error';
    base.error = 'Limite de requisições atingido — tente novamente em 60s';
    return base;
  }

  if (error.kind === 'cors' || error.kind === 'network') {
    base.status = 'cors_blocked';
    base.error = 'CORS bloqueado — use o link manual';
    return base;
  }

  base.status = 'error';
  base.error = `Falha na consulta: ${error.message || 'erro desconhecido'}`;
  return base;
}

async function fetchSparseCandidatesFromOpenLibrary(query: string): Promise<SparseCandidate[]> {
  const url = `https://openlibrary.org/search.json?${new URLSearchParams({
    title: query,
    limit: '5'
  }).toString()}`;

  const payload = await fetchWithFallbacks<any>(url);
  return (payload.data?.docs || []).map((doc: any) =>
    createSparseCandidate('Open Library', {
      title: doc.title,
      subtitle: doc.subtitle,
      authors: doc.author_name || [],
      year: doc.first_publish_year,
      publisher: Array.isArray(doc.publisher) ? doc.publisher[0] : doc.publisher,
      isbn: Array.isArray(doc.isbn) ? doc.isbn[0] : doc.isbn,
      type: 'book',
      pageUrl: doc.key ? `https://openlibrary.org${doc.key}` : null
    })
  );
}

async function fetchSparseCandidatesFromGoogleBooks(query: string): Promise<SparseCandidate[]> {
  const url = `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({
    q: `intitle:${query}`,
    maxResults: '5',
    printType: 'books'
  }).toString()}`;

  const payload = await fetchWithFallbacks<any>(url, { allowProxy: false });
  return (payload.data?.items || []).map((item: any) => {
    const info = item.volumeInfo || {};
    const isbn =
      (Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [])
        .map((entry: any) => entry.identifier)
        .find(Boolean) || null;

    return createSparseCandidate('Google Books', {
      title: info.title,
      subtitle: info.subtitle,
      authors: info.authors || [],
      year: info.publishedDate,
      publisher: info.publisher,
      isbn,
      type: 'book',
      pageUrl: info.infoLink || info.previewLink || item.selfLink
    });
  });
}

async function fetchSparseCandidatesFromCrossRef(query: string): Promise<SparseCandidate[]> {
  const payload = await fetchWithFallbacks<any>(
    `https://api.crossref.org/works?${new URLSearchParams({
      'query.bibliographic': query,
      rows: '5',
      select: 'DOI,title,subtitle,author,published,URL,publisher,type'
    }).toString()}`
  );

  return ((payload.data?.message || {}).items || []).map((item: any) =>
    createSparseCandidate('CrossRef', {
      title: Array.isArray(item.title) ? item.title[0] : item.title,
      subtitle: Array.isArray(item.subtitle) ? item.subtitle[0] : item.subtitle,
      authors: Array.isArray(item.author)
        ? item.author.map((author: any) => ({
            lastName: author.family || '',
            firstName: author.given || ''
          }))
        : [],
      year: (((item.published || {})['date-parts'] || [])[0] || [])[0] || null,
      publisher: item.publisher,
      doi: item.DOI || null,
      type: item.type,
      pageUrl: item.DOI ? `https://doi.org/${item.DOI}` : item.URL
    })
  );
}

async function fetchSparseCandidatesFromScielo(query: string): Promise<SparseCandidate[]> {
  const payload = await fetchWithFallbacks<any>(
    `https://search.scielo.org/api/v1/article/?${new URLSearchParams({
      q: query,
      output: 'json'
    }).toString()}`
  );
  const items = payload.data?.results || payload.data?.articles || payload.data || [];

  return (Array.isArray(items) ? items : []).map((item: any) =>
    createSparseCandidate('SciELO Brasil', {
      title: item.title || item.ti,
      authors: item.author || item.authors || '',
      year: item.publication_year || item.year || item.date,
      publisher: item.journal_title || item.source || '',
      doi: item.doi || null,
      type: 'article',
      pageUrl: item.url || item.link || item.record || item.pdf_url || item.pdf || null
    })
  );
}

async function fetchSparseCandidatesFromProjectGutenberg(query: string): Promise<SparseCandidate[]> {
  const payload = await fetchWithFallbacks<any>(
    `https://gutendex.com/books?${new URLSearchParams({
      search: query,
      mime_type: 'application/epub+zip'
    }).toString()}`
  );

  return (Array.isArray(payload.data?.results) ? payload.data.results : []).map((item: any) =>
    createSparseCandidate('Project Gutenberg', {
      title: item.title,
      authors: Array.isArray(item.authors)
        ? item.authors.map((author: any) => normalizeWhitespace(String(author.name || ''))).filter(Boolean)
        : [],
      year: Array.isArray(item.authors) ? item.authors[0]?.death_year || item.authors[0]?.birth_year : null,
      publisher: 'Project Gutenberg',
      type: 'book',
      pageUrl: item.id ? `https://www.gutenberg.org/ebooks/${item.id}` : null
    })
  );
}

async function fetchSparseTitleCandidates(parsed: ParsedCitation): Promise<SparseCandidate[]> {
  const query = normalizeWhitespace([parsed.title, parsed.subtitle].filter(Boolean).join(' '));
  if (!query || tokenize(query).length < 2) {
    return [];
  }

  const settled = await Promise.allSettled([
    fetchSparseCandidatesFromGoogleBooks(query),
    fetchSparseCandidatesFromOpenLibrary(query),
    fetchSparseCandidatesFromCrossRef(query),
    fetchSparseCandidatesFromScielo(query),
    fetchSparseCandidatesFromProjectGutenberg(query)
  ]);

  const candidates = settled.flatMap((entry) => (entry.status === 'fulfilled' ? entry.value : []));
  return dedupeSparseCandidates(query, candidates);
}

export async function parseCitationWithGemini(
  rawText: string,
  fallbackParsed: ParsedCitation
): Promise<ParsedCitation> {
  const sparse = isSparseCitation(fallbackParsed);
  const sparseFallback = sparse
    ? inferTrailingAuthorFromSparseRaw(rawText, fallbackParsed) || fallbackParsed
    : fallbackParsed;
  const candidates = sparse
    ? rankSparseCandidatesForPrompt(rawText, sparseFallback, await fetchSparseTitleCandidates(sparseFallback))
    : [];
  const bestCandidate = candidates[0] || null;
  const fallbackCandidate = canUseSparseCandidateAsFallback(bestCandidate) ? bestCandidate : null;
  const fallbackBase = fallbackCandidate
    ? buildCitationFromParts(rawText, fallbackCandidate, sparseFallback)
    : sparseFallback;

  const payload = {
    systemInstruction: {
      parts: [
        {
          text:
            'Extract academic citation metadata from ABNT-like or title-only text. Return only valid JSON with keys authors, title, subtitle, year, publisher, city, edition, type, isbn, doi. Each author must have lastName and firstName. Use null when unknown.'
        }
      ]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: buildSparseCandidatePrompt(rawText, sparseFallback, candidates) }]
      }
    ],
    generationConfig: {
      temperature: 0.15,
      responseMimeType: 'application/json'
    }
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(DEFAULT_GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Gemini ${response.status}: ${message.slice(0, 140)}`);
    }

    const data = await response.json();
    const text =
      (((data.candidates || [])[0] || {}).content || {}).parts
        ?.map((part: { text?: string }) => part.text || '')
        .join('')
        .trim() || '';
    const aiParsed = safeJsonParse(text);

    if (!aiParsed || typeof aiParsed !== 'object') {
      const parserSource = fallbackCandidate ? 'catalog' : 'local';
      return attachSearchMetadata(
        markParserSource(fallbackBase, parserSource),
        candidates,
        fallbackCandidate
      ) as ParsedCitation;
    }

    const finalParsed = buildCitationFromParts(
      rawText,
      aiParsed as Record<string, unknown>,
      fallbackBase
    );
    const parserSource = candidates.length ? 'gemini_catalog' : 'gemini';

    return attachSearchMetadata(
      markParserSource(finalParsed, parserSource),
      candidates,
      fallbackCandidate
    ) as ParsedCitation;
  } catch (error) {
    if (fallbackBase) {
      return attachSearchMetadata(
        markParserSource(fallbackBase, fallbackCandidate ? 'catalog' : 'local'),
        candidates,
        fallbackCandidate
      ) as ParsedCitation;
    }

    throw error;
  }
}

async function searchInternetArchive(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'Internet Archive';
  const sourceId = 'internet_archive';
  const manualUrl = `https://archive.org/search?query=${encodeURIComponent(`${buildSearchQuery(citation)} mediatype:texts`)}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const query = `title:(${citation.title || ''}) creator:(${getPrimaryAuthorQuery(citation) || ''})`;
  const params = new URLSearchParams();
  params.set('q', query);
  ['identifier', 'title', 'creator', 'year'].forEach((field) => params.append('fl[]', field));
  params.set('rows', String(DIRECT_RESULTS_LIMIT));
  params.set('output', 'json');

  const payload = await fetchWithFallbacks<any>(
    `https://archive.org/advancedsearch.php?${params.toString()}`
  );
  const docs = payload.data?.response?.docs || [];

  response.results = (
    await Promise.all(
      docs.map(async (doc: any) => {
        const identifier = normalizeWhitespace(String(doc.identifier || ''));
        const files = identifier
          ? await fetchInternetArchiveFileLinks(identifier)
          : { pdfUrl: null, epubUrl: null };

        return buildResult(citation, source, {
          title: doc.title,
          author: Array.isArray(doc.creator) ? doc.creator.join(', ') : doc.creator,
          year: doc.year,
          pdfUrl: files.pdfUrl,
          epubUrl: files.epubUrl,
          pageUrl: identifier ? `https://archive.org/details/${identifier}` : null,
          coverUrl: identifier ? `https://archive.org/services/img/${encodeURIComponent(identifier)}` : null,
          materialType: 'book'
        });
      })
    )
  ).filter(hasDownloadOrPage);

  return finalizeAdapterResponse(citation, response);
}

async function fetchInternetArchiveFileLinks(
  identifier: string
): Promise<{ pdfUrl: string | null; epubUrl: string | null }> {
  try {
    const payload = await fetchWithFallbacks<any>(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    const files = Array.isArray(payload.data?.files) ? payload.data.files : [];
    const downloadableFiles = files.filter((file: any) => {
      const name = normalizeWhitespace(String(file.name || ''));
      return name && !/^__ia_thumb\.jpg$/i.test(name);
    });
    const pdfFile = downloadableFiles.find((file: any) =>
      /pdf/i.test(`${file.format || ''} ${file.name || ''}`)
    );
    const epubFile = downloadableFiles.find((file: any) =>
      /(epub|application\/epub\+zip)/i.test(`${file.format || ''} ${file.name || ''}`)
    );

    const makeDownloadUrl = (file: any): string | null =>
      file?.name
        ? `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(String(file.name))}`
        : null;

    return {
      pdfUrl: makeDownloadUrl(pdfFile),
      epubUrl: makeDownloadUrl(epubFile)
    };
  } catch {
    return { pdfUrl: null, epubUrl: null };
  }
}

async function searchProjectGutenberg(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'Project Gutenberg';
  const sourceId = 'project_gutenberg';
  const query = buildSearchQuery(citation, {
    includeSubtitle: false,
    includeAuthor: true,
    authorMode: 'full',
    preferMainTitle: true
  });
  const manualUrl = `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query)}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const params = new URLSearchParams({
    search: query,
    mime_type: 'application/epub+zip'
  });

  const payload = await fetchWithFallbacks<any>(`https://gutendex.com/books?${params.toString()}`);
  const items = Array.isArray(payload.data?.results) ? payload.data.results : [];

  response.results = items
    .slice(0, DIRECT_RESULTS_LIMIT)
    .map((item: any) => {
      const formats = item.formats && typeof item.formats === 'object' ? item.formats : {};
      const epubEntry = Object.entries(formats).find(([mime, url]) =>
        /application\/epub\+zip/i.test(mime) && typeof url === 'string'
      );
      const htmlEntry = Object.entries(formats).find(([mime, url]) =>
        /text\/html/i.test(mime) && typeof url === 'string'
      );
      const coverEntry = Object.entries(formats).find(([mime, url]) =>
        /^image\//i.test(mime) && typeof url === 'string'
      );
      const authors = Array.isArray(item.authors)
        ? item.authors.map((author: any) => normalizeWhitespace(String(author.name || ''))).filter(Boolean)
        : [];

      return buildResult(citation, source, {
        sourceId,
        sourceKind: 'catalog',
        paperId: item.id,
        title: item.title,
        authors,
        author: authors.join(', '),
        year: Array.isArray(item.authors) ? item.authors[0]?.death_year || item.authors[0]?.birth_year : null,
        epubUrl: epubEntry ? String(epubEntry[1]) : null,
        pageUrl: item.id ? `https://www.gutenberg.org/ebooks/${item.id}` : htmlEntry ? String(htmlEntry[1]) : null,
        coverUrl: coverEntry ? String(coverEntry[1]) : null,
        materialType: 'book',
        categories: Array.isArray(item.bookshelves) ? item.bookshelves : [],
        extra: {
          languages: item.languages || [],
          downloadCount: item.download_count || 0,
          copyright: item.copyright ?? null
        }
      });
    })
    .filter(hasDownloadOrPage);

  return finalizeAdapterResponse(citation, response);
}

function quoteGoogleBooksField(value: string): string {
  const clean = normalizeWhitespace(value).replace(/"/g, '');
  return clean ? `"${clean}"` : '';
}

function buildGoogleBooksQueries(citation: ParsedCitation): string[] {
  const mainTitle = getSearchTitle(citation, {
    includeSubtitle: false,
    preferMainTitle: true
  });
  const fullTitle = getSearchTitle(citation, {
    includeSubtitle: true,
    preferMainTitle: false
  });
  const author = getPrimaryAuthorQuery(citation);
  const queries = [
    citation.isbn ? `isbn:${citation.isbn.replace(/[-\s]/g, '')}` : '',
    normalizeWhitespace(
      [
        mainTitle ? `intitle:${quoteGoogleBooksField(mainTitle)}` : '',
        author ? `inauthor:${quoteGoogleBooksField(author)}` : ''
      ].join(' ')
    ),
    normalizeWhitespace(
      [
        fullTitle ? `intitle:${quoteGoogleBooksField(fullTitle)}` : '',
        author ? `inauthor:${quoteGoogleBooksField(author)}` : ''
      ].join(' ')
    ),
    buildSearchQuery(citation, {
      includeSubtitle: false,
      includeAuthor: true,
      authorMode: 'full',
      preferMainTitle: true
    }),
    buildSearchQuery(citation, {
      includeSubtitle: true,
      includeAuthor: true,
      authorMode: 'full'
    }),
    fullTitle || mainTitle
  ];

  return Array.from(new Set(queries.map((query) => normalizeWhitespace(query)).filter(Boolean)));
}

function getGoogleBooksDownloadLink(accessInfo: any, format: 'pdf' | 'epub'): string | null {
  const entry = accessInfo && typeof accessInfo === 'object' ? accessInfo[format] : null;
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  return entry.isAvailable && entry.downloadLink ? normalizeWhitespace(String(entry.downloadLink)) : null;
}

async function searchGoogleBooks(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'Google Books';
  const sourceId = 'google_books';
  const manualUrl = `https://books.google.com/books?${new URLSearchParams({
    q: buildSearchQuery(citation)
  }).toString()}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);

  response.results = await collectVariantResults(
    citation,
    buildGoogleBooksQueries(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({
          q: query,
          printType: 'books',
          maxResults: String(DIRECT_RESULTS_LIMIT),
          projection: 'lite'
        }).toString()}`,
        { allowProxy: false }
      );

      return (payload.data?.items || []).map((item: any) => {
        const info = item.volumeInfo || {};
        const accessInfo = item.accessInfo || {};
        const title = normalizeWhitespace(
          [info.title, info.subtitle].filter(Boolean).join(': ')
        );
        const authors = Array.isArray(info.authors)
          ? info.authors.map((author: unknown) => normalizeWhitespace(String(author))).filter(Boolean)
          : [];
        const identifiers = Array.isArray(info.industryIdentifiers)
          ? info.industryIdentifiers
              .map((entry: any) => normalizeWhitespace(String(entry.identifier || '')))
              .filter(Boolean)
          : [];

        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'catalog',
          paperId: item.id,
          title,
          authors,
          author: authors.join(', '),
          year: pickYear(info.publishedDate),
          publishedDate: info.publishedDate || null,
          publisher: info.publisher || '',
          pdfUrl: getGoogleBooksDownloadLink(accessInfo, 'pdf'),
          epubUrl: getGoogleBooksDownloadLink(accessInfo, 'epub'),
          pageUrl:
            info.infoLink ||
            info.previewLink ||
            info.canonicalVolumeLink ||
            item.selfLink ||
            null,
          coverUrl:
            info.imageLinks?.thumbnail ||
            info.imageLinks?.smallThumbnail ||
            null,
          materialType: 'book',
          categories: Array.isArray(info.categories) ? info.categories : [],
          extra: {
            publisher: info.publisher || null,
            pageCount: info.pageCount || null,
            printType: info.printType || null,
            language: info.language || null,
            previewLink: info.previewLink || null,
            accessViewStatus: accessInfo.accessViewStatus || null,
            publicDomain: accessInfo.publicDomain ?? null,
            isbn: identifiers[0] || null
          }
        });
      });
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchOpenLibrary(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'Open Library';
  const sourceId = 'open_library';
  const manualUrl = makeManualUrl('https://openlibrary.org/search', {
    q: buildSearchQuery(citation)
  });
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const payload = await fetchWithFallbacks<any>(
    `https://openlibrary.org/search.json?${new URLSearchParams({
      title: citation.title || '',
      author: getPrimaryAuthorQuery(citation),
      limit: String(DIRECT_RESULTS_LIMIT)
    }).toString()}`
  );

  response.results = (payload.data?.docs || [])
    .map((doc: any) => {
      const workId =
        typeof doc.key === 'string'
          ? doc.key
          : doc.cover_edition_key
            ? `/books/${doc.cover_edition_key}`
            : '';
      const readUrl =
        Array.isArray(doc.ia) && doc.ia.length
          ? `https://archive.org/details/${doc.ia[0]}`
          : workId
            ? `https://openlibrary.org${workId}`
            : null;

      const coverUrl =
        typeof doc.cover_i === 'number'
          ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
          : doc.cover_edition_key
            ? `https://covers.openlibrary.org/b/olid/${doc.cover_edition_key}-M.jpg`
            : null;

      return buildResult(citation, source, {
        title: doc.title,
        author: Array.isArray(doc.author_name) ? doc.author_name.join(', ') : '',
        year: doc.first_publish_year,
        pdfUrl: null,
        pageUrl:
          doc.has_fulltext || (doc.ebook_access && doc.ebook_access !== 'no_ebook')
            ? readUrl
            : workId
              ? `https://openlibrary.org${workId}`
              : readUrl,
        coverUrl,
        materialType: 'book'
      });
    })
    .filter((result: SearchResult) => result.pageUrl);

  return finalizeAdapterResponse(citation, response);
}

async function searchDoaj(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'DOAJ';
  const sourceId = 'doaj';
  const manualUrl = `https://doaj.org/search/articles/${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${DIRECT_RESULTS_LIMIT}`
      );

      return (payload.data?.results || []).map((item: any) => {
        const bib = item.bibjson || {};
        const links = Array.isArray(bib.link) ? bib.link : [];
        const fulltextLink =
          item.fulltext_url ||
          (links.find((link: any) => /fulltext|pdf/i.test(link.type || link.title || '')) || {})
            .url ||
          null;

        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'fulltext',
          title: bib.title,
          authors: Array.isArray(bib.author) ? bib.author.map((author: any) => author.name) : [],
          author: Array.isArray(bib.author)
            ? bib.author.map((author: any) => author.name).join(', ')
            : '',
          year: bib.year || item.year,
          pdfUrl: /\.pdf($|\?)/i.test(fulltextLink || '') ? fulltextLink : null,
          pageUrl: fulltextLink || item.id,
          doi: bib.identifier?.find?.((entry: any) => /doi/i.test(entry.type || ''))?.id || null,
          materialType: 'article'
        });
      });
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchSemanticScholar(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'Semantic Scholar';
  const sourceId = 'semantic_scholar';
  const manualUrl = `https://www.semanticscholar.org/search?q=${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://api.semanticscholar.org/graph/v1/paper/search?${new URLSearchParams({
          query,
          fields: 'title,authors,year,openAccessPdf,externalIds,url',
          limit: String(DIRECT_RESULTS_LIMIT)
        }).toString()}`
      );

      return (payload.data?.data || []).map((item: any) =>
        buildResult(citation, source, {
          sourceId,
          sourceKind: 'metadata',
          title: item.title,
          authors: Array.isArray(item.authors) ? item.authors.map((author: any) => author.name) : [],
          author: Array.isArray(item.authors)
            ? item.authors.map((author: any) => author.name).join(', ')
            : '',
          year: item.year,
          pdfUrl: item.openAccessPdf?.url || null,
          pageUrl: item.url || (item.externalIds?.DOI ? `https://doi.org/${item.externalIds.DOI}` : null),
          doi: item.externalIds?.DOI || null,
          materialType: 'article'
        })
      );
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchUnpaywall(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'Unpaywall';
  const sourceId = 'unpaywall';
  const manualUrl = `https://api.unpaywall.org/v2/search/?${new URLSearchParams({
    query: buildSearchQuery(citation),
    email: 'search@pdfsearch.app'
  }).toString()}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const payload = citation.doi
    ? await fetchWithFallbacks<any>(
        `https://api.unpaywall.org/v2/${encodeURIComponent(normalizeDoi(citation.doi))}?email=search@pdfsearch.app`
      )
    : await fetchWithFallbacks<any>(manualUrl);
  const items = citation.doi
    ? [payload.data].filter(Boolean)
    : payload.data?.results || payload.data?.items || payload.data?.data || [];

  response.results = items
    .map((item: any) => {
      const best = item.best_oa_location || item.oa_location || {};
      const pageUrl = best.url || (item.doi ? `https://doi.org/${item.doi}` : null);
      return buildResult(citation, source, {
        sourceId,
        sourceKind: 'fulltext',
        title: item.title || item.display_name,
        authors: Array.isArray(item.z_authors)
          ? item.z_authors.map((author: any) =>
              normalizeWhitespace(`${author.given || ''} ${author.family || ''}`)
            )
          : [],
        author: Array.isArray(item.z_authors)
          ? item.z_authors.map((author: any) => author.family || author.given || '').join(', ')
          : '',
        year: item.year || item.published_date,
        publishedDate: item.published_date || null,
        pdfUrl: best.url_for_pdf || null,
        pageUrl,
        doi: item.doi || null,
        materialType: 'article'
      });
    })
    .filter(hasDownloadOrPage);

  return finalizeAdapterResponse(citation, response);
}

async function searchBase(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'BASE';
  const sourceId = 'base';
  const manualUrl = `https://www.base-search.net/Search/Results?lookfor=${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const baseQueries = citation.doi
    ? [`dcidentifier:${normalizeDoi(citation.doi)}`, ...buildQueryVariants(citation).map((query) => `dctitle:${query}`)]
    : [
        `dctitle:${getSearchTitle(citation, { preferMainTitle: true })} dcperson:${getPrimaryAuthorQuery(citation)}`,
        `dctitle:${buildSearchQuery(citation, { includeSubtitle: true, includeAuthor: true })}`,
        `dctitle:${getSearchTitle(citation, { preferMainTitle: true })}`
      ];

  response.results = await collectVariantResults(citation, baseQueries, async (query) => {
    const payload = await fetchWithFallbacks<any>(
      `https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi?${new URLSearchParams({
        func: 'PerformSearch',
        query,
        hits: String(DIRECT_RESULTS_LIMIT),
        format: 'json'
      }).toString()}`
    );

    const records = payload.data?.records || payload.data?.response?.records || [];
    return records.map((record: any) => {
      const directPdf =
        record.fulltext || (record.url && /\.pdf($|\?)/i.test(record.url) ? record.url : null);
      return buildResult(citation, source, {
        sourceId,
        sourceKind: 'fulltext',
        title: record.title || record.dctitle,
        authors: normalizeAuthorNames(record.creator || record.dcperson || record.author),
        author: record.creator || record.dcperson || record.author,
        year: record.year || record.dcdate,
        doi: record.doi || record.dcidentifier || null,
        pdfUrl: directPdf,
        pageUrl: record.url || record.link || record.fulltext || null
      });
    });
  });

  return finalizeAdapterResponse(citation, response);
}

async function searchCore(
  citation: ParsedCitation,
  settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'CORE.ac.uk';
  const sourceId = 'core';
  const manualUrl = `https://core.ac.uk/search?q=${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const headers: Record<string, string> = {};
  if (settings.coreApiKey) {
    headers.Authorization = `Bearer ${settings.coreApiKey}`;
  }

  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://api.core.ac.uk/v3/search/outputs?${new URLSearchParams({
          q: query,
          limit: String(DIRECT_RESULTS_LIMIT)
        }).toString()}`,
        { headers }
      );

      return (payload.data?.results || payload.data?.data || []).map((item: any) =>
        buildResult(citation, source, {
          sourceId,
          sourceKind: 'fulltext',
          title: item.title,
          authors: Array.isArray(item.authors)
            ? item.authors.map((author: any) => author.name || author).filter(Boolean)
            : [],
          author: Array.isArray(item.authors)
            ? item.authors.map((author: any) => author.name || author).join(', ')
            : item.authorsText,
          year: item.yearPublished || item.year,
          doi: item.doi || null,
          pdfUrl: item.downloadUrl || item.fullTextIdentifier || null,
          pageUrl: item.id ? `https://core.ac.uk/works/${item.id}` : item.oaiPmhUrl || null,
          materialType: item.type || item.documentType || ''
        })
      );
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchCrossRef(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'CrossRef';
  const sourceId = 'crossref';
  const manualUrl = `https://search.crossref.org/?q=${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  if (citation.doi) {
    const payload = await fetchWithFallbacks<any>(
      `https://api.crossref.org/works/${encodeURIComponent(normalizeDoi(citation.doi))}`
    );

    response.results = [payload.data?.message]
      .filter(Boolean)
      .map((item: any) => {
        const pdfLink = (Array.isArray(item.link) ? item.link : []).find((link: any) =>
          /application\/pdf/i.test(link['content-type'] || '')
        );
        const title = Array.isArray(item.title) ? item.title[0] : item.title;
        const authorsList = Array.isArray(item.author)
          ? item.author
              .map((author: any) => normalizeWhitespace(`${author.given || ''} ${author.family || ''}`))
              .filter(Boolean)
          : [];

        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'metadata',
          title,
          authors: authorsList,
          author: authorsList.join(', '),
          year: (((item.published || {})['date-parts'] || [])[0] || [])[0] || null,
          pdfUrl: pdfLink ? pdfLink.URL : null,
          pageUrl: item.DOI ? `https://doi.org/${item.DOI}` : item.URL,
          doi: item.DOI || null,
          journal: Array.isArray(item['container-title']) ? item['container-title'][0] : '',
          materialType: item.type || 'article'
        });
      });
  } else {
    const queryVariants = [
      {
        'query.title': getSearchTitle(citation, { preferMainTitle: true }),
        'query.author': getPrimaryAuthorQuery(citation)
      },
      {
        'query.title': getSearchTitle(citation, { includeSubtitle: true }),
        'query.author': getPrimaryAuthorQuery(citation)
      },
      {
        'query.bibliographic': buildSearchQuery(citation, {
          includeSubtitle: false,
          includeAuthor: true,
          authorMode: 'full',
          preferMainTitle: true
        })
      },
      {
        'query.title': getSearchTitle(citation, { preferMainTitle: true })
      }
    ];

    response.results = await collectVariantResults(citation, queryVariants.map((query) => JSON.stringify(query)), async (serialized) => {
      const queryParams = JSON.parse(serialized) as Record<string, string>;
      const payload = await fetchWithFallbacks<any>(
        `https://api.crossref.org/works?${new URLSearchParams({
          ...queryParams,
          rows: String(DIRECT_RESULTS_LIMIT),
          select: 'DOI,title,author,published,link,type,URL,publisher,container-title'
        }).toString()}`
      );

      return (((payload.data?.message || {}).items || []) as any[]).map((item: any) => {
        const pdfLink = (Array.isArray(item.link) ? item.link : []).find((link: any) =>
          /application\/pdf/i.test(link['content-type'] || '')
        );
        const title = Array.isArray(item.title) ? item.title[0] : item.title;
        const authorsList = Array.isArray(item.author)
          ? item.author
              .map((author: any) => normalizeWhitespace(`${author.given || ''} ${author.family || ''}`))
              .filter(Boolean)
          : [];

        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'metadata',
          title,
          authors: authorsList,
          author: authorsList.join(', '),
          year: (((item.published || {})['date-parts'] || [])[0] || [])[0] || null,
          pdfUrl: pdfLink ? pdfLink.URL : null,
          pageUrl: item.DOI ? `https://doi.org/${item.DOI}` : item.URL,
          doi: item.DOI || null,
          journal: Array.isArray(item['container-title']) ? item['container-title'][0] : '',
          materialType: item.type || 'article'
        });
      });
    });
  }

  return finalizeAdapterResponse(citation, response);
}

async function searchOpenAlex(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'OpenAlex';
  const sourceId = 'openalex';
  const manualUrl = `https://openalex.org/works?search=${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const params = new URLSearchParams({
        search: query,
        select:
          'id,title,display_name,authorships,publication_year,doi,type,open_access,primary_location',
        'per-page': String(DIRECT_RESULTS_LIMIT)
      });

      const payload = await fetchWithFallbacks<any>(`https://api.openalex.org/works?${params.toString()}`);

      return (payload.data?.results || []).map((item: any) => {
        const authors = Array.isArray(item.authorships)
          ? item.authorships
              .map((authorship: any) => authorship?.author?.display_name)
              .filter(Boolean)
          : [];
        const pdfUrl =
          item?.primary_location?.pdf_url || item?.open_access?.oa_url || item?.best_oa_location?.pdf_url || null;
        const pageUrl =
          item?.primary_location?.landing_page_url ||
          (item?.doi ? `https://doi.org/${normalizeDoi(item.doi)}` : item?.id || null);

        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'metadata',
          paperId: item.id,
          title: item.display_name || item.title,
          authors,
          year: item.publication_year,
          publishedDate: item.publication_year,
          doi: item.doi,
          pdfUrl,
          pageUrl,
          url: pageUrl,
          materialType: item.type || 'article'
        });
      });
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchZenodo(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'Zenodo';
  const sourceId = 'zenodo';
  const manualUrl = `https://zenodo.org/search?q=${encodeURIComponent(citation.doi || buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://zenodo.org/api/records?${new URLSearchParams({
          q: query,
          size: String(DIRECT_RESULTS_LIMIT),
          sort: 'bestmatch'
        }).toString()}`
      );

      const records = payload.data?.hits?.hits || [];
      return records.map((record: any) => {
        const metadata = record.metadata || {};
        const files = Array.isArray(record.files) ? record.files : [];
        const pdfFile =
          files.find((file: any) => /\.pdf($|\?)/i.test(file?.key || file?.filename || '')) || files[0] || null;
        const authors = Array.isArray(metadata.creators)
          ? metadata.creators.map((creator: any) => creator.name).filter(Boolean)
          : [];
        const pageUrl = record.links?.self_html || record.links?.html || record.links?.self || record.conceptdoi || null;

        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'fulltext',
          paperId: record.id,
          title: metadata.title || record.title,
          authors,
          year: metadata.publication_date || metadata.publication_year,
          publishedDate: metadata.publication_date,
          doi: metadata.doi || record.doi || record.conceptdoi,
          pdfUrl: pdfFile?.links?.self || pdfFile?.links?.download || null,
          pageUrl,
          url: pageUrl,
          journal: metadata.journal?.title || metadata.publication_title || '',
          materialType:
            metadata.resource_type?.title || metadata.upload_type || metadata.resource_type?.type || 'article',
          extra: { license: metadata.license || null }
        });
      });
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchHal(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'HAL';
  const sourceId = 'hal';
  const manualUrl = `https://hal.science/search/index/?q=${encodeURIComponent(citation.doi || buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://api.archives-ouvertes.fr/search/?${new URLSearchParams({
          q: query,
          fl: 'title_s,authFullName_s,publicationDateY_i,fileMain_s,uri_s,doiId_s,docType_s',
          rows: String(DIRECT_RESULTS_LIMIT),
          wt: 'json'
        }).toString()}`
      );

      const docs = payload.data?.response?.docs || [];
      return docs.map((doc: any) =>
        buildResult(citation, source, {
          sourceId,
          sourceKind: 'fulltext',
          paperId: doc.docid || doc.halId_s,
          title: Array.isArray(doc.title_s) ? doc.title_s[0] : doc.title_s,
          authors: Array.isArray(doc.authFullName_s) ? doc.authFullName_s : [],
          year: doc.publicationDateY_i,
          doi: Array.isArray(doc.doiId_s) ? doc.doiId_s[0] : doc.doiId_s,
          pdfUrl: Array.isArray(doc.fileMain_s) ? doc.fileMain_s[0] : doc.fileMain_s,
          pageUrl: Array.isArray(doc.uri_s) ? doc.uri_s[0] : doc.uri_s,
          url: Array.isArray(doc.uri_s) ? doc.uri_s[0] : doc.uri_s,
          materialType: Array.isArray(doc.docType_s) ? doc.docType_s[0] : doc.docType_s || 'article'
        })
      );
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchEric(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'ERIC';
  const sourceId = 'eric';
  const manualUrl = `https://eric.ed.gov/?q=${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://api.ies.ed.gov/eric/?${new URLSearchParams({
          search: query,
          format: 'json',
          rows: String(DIRECT_RESULTS_LIMIT)
        }).toString()}`
      );

      return (payload.data?.response?.docs || payload.data?.docs || []).map((item: any) => {
        const pageUrl = item.url || (item.id ? `https://eric.ed.gov/?id=${item.id}` : null);
        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'fulltext',
          title: item.title,
          authors: Array.isArray(item.author) ? item.author : normalizeAuthorNames(item.author),
          author: Array.isArray(item.author) ? item.author.join(', ') : item.author,
          year: item.publicationdateyear || item.publicationdate,
          pdfUrl: item.fulltext || item.pdf || null,
          pageUrl,
          materialType: item.publicationtype || item.publicationtypecode || ''
        });
      });
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchPmc(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'PubMed / PMC';
  const sourceId = 'pmc';
  const manualUrl = `https://pmc.ncbi.nlm.nih.gov/?term=${encodeURIComponent(buildSearchQuery(citation))}`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const term = normalizeWhitespace(
    citation.doi
      ? `${normalizeDoi(citation.doi)}[DOI] ${citation.title || ''}[Title]`
      : `${citation.title || ''}[Title] ${getPrimaryAuthorQuery(citation) ? `${getPrimaryAuthorQuery(citation)}[Author]` : ''}`
  );
  const payload = await fetchWithFallbacks<any>(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${new URLSearchParams({
      db: 'pmc',
      term,
      retmode: 'json',
      retmax: String(DIRECT_RESULTS_LIMIT)
    }).toString()}`
  );

  response.results = (payload.data?.esearchresult?.idlist || []).map((id: string) => {
    const pmcId = String(id).startsWith('PMC') ? String(id) : `PMC${id}`;
    return buildResult(citation, source, {
      sourceId,
      sourceKind: 'fulltext',
      title: citation.title || pmcId,
      author: formatAuthorsDisplay(citation.authors),
      year: citation.year,
      doi: citation.doi,
      pdfUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcId}/pdf/`,
      pageUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcId}/`,
      materialType: 'article'
    });
  });

  return finalizeAdapterResponse(citation, response);
}

async function searchScielo(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = 'SciELO Brasil';
  const sourceId = 'scielo_brasil';
  const manualUrl = `https://search.scielo.org/?q=${encodeURIComponent(buildSearchQuery(citation))}&lang=pt`;
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  response.results = await collectVariantResults(
    citation,
    buildQueryVariants(citation),
    async (query) => {
      const payload = await fetchWithFallbacks<any>(
        `https://search.scielo.org/api/v1/article/?${new URLSearchParams({
          q: query,
          output: 'json'
        }).toString()}`
      );

      const items = payload.data?.results || payload.data?.articles || payload.data || [];
      return (Array.isArray(items) ? items : []).map((item: any) => {
        const pdfUrl = item.pdf_url || item.pdf || item.link_pdf || null;
        const pageUrl = item.url || item.link || item.record || null;
        return buildResult(citation, source, {
          sourceId,
          sourceKind: 'fulltext',
          title: item.title || item.ti || citation.title,
          authors: normalizeAuthorNames(item.author || item.authors || ''),
          author: item.author || item.authors || '',
          year: item.publication_year || item.year || item.date,
          doi: item.doi || null,
          pdfUrl,
          pageUrl,
          materialType: 'article'
        });
      });
    }
  );

  return finalizeAdapterResponse(citation, response);
}

async function searchSenadoFederal(citation: ParsedCitation): Promise<SearchAdapterResponse> {
  const source = 'Senado Federal';
  const sourceId = 'senado_federal';
  const manualUrl = buildDomainSearchUrl(citation, 'senado.leg.br', 'pdf');
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const query = normalizeForCompare(
    [citation.title, citation.subtitle, formatAuthorsDisplay(citation.authors), citation.raw]
      .filter(Boolean)
      .join(' ')
  );
  const matches = [
    {
      pattern: /abolicionismo.*nabuco|nabuco.*abolicionismo/,
      title: 'O Abolicionismo',
      authors: ['Joaquim Nabuco'],
      year: '2012',
      pdfUrl: 'https://www2.senado.leg.br/bdsf/bitstream/handle/id/518634/000009756.pdf',
      pageUrl: 'https://livraria.senado.leg.br/o-abolicionismo'
    },
    {
      pattern: /ilusao.*americana.*prado|prado.*ilusao.*americana/,
      title: 'A Ilusão Americana',
      authors: ['Eduardo Prado'],
      year: '2025',
      pdfUrl: 'https://www2.senado.leg.br/bdsf/bitstream/handle/id/658134/Ilusao_americana.pdf',
      pageUrl: 'https://livraria.senado.leg.br/a-ilusao-americana'
    }
  ];

  response.results = matches
    .filter((entry) => entry.pattern.test(query))
    .map((entry) =>
      buildResult(citation, source, {
        sourceId,
        sourceKind: 'fulltext',
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        pdfUrl: entry.pdfUrl,
        pageUrl: entry.pageUrl,
        materialType: 'book'
      })
    );

  return finalizeAdapterResponse(citation, response);
}

async function searchMarxistsArchive(citation: ParsedCitation): Promise<SearchAdapterResponse> {
  const source = 'Marxists Internet Archive';
  const sourceId = 'marxists_archive';
  const manualUrl = buildBroadDomainSearchUrl(citation, 'marxists.org/portugues', 'pdf OR epub');
  const response = createBaseResponse(source, sourceId, 1, manualUrl);
  const query = normalizeForCompare(
    [citation.title, citation.subtitle, formatAuthorsDisplay(citation.authors), citation.raw]
      .filter(Boolean)
      .join(' ')
  );
  const matches = [
    {
      pattern: /manifesto.*(partido)?\s*comunista|comunist.*manifesto/,
      title: 'Manifesto do Partido Comunista',
      authors: ['Karl Marx', 'Friedrich Engels'],
      year: '1848',
      pdfUrl: 'https://www.marxists.org/portugues/marx/1848/ManifestoDoPartidoComunista/manifesto.pdf',
      pageUrl: 'https://www.marxists.org/portugues/marx/1848/ManifestoDoPartidoComunista/index.htm'
    },
    {
      pattern: /estado.*revolucao|state.*revolution/,
      title: 'O Estado e a Revolução',
      authors: ['Vladimir Lenin'],
      year: '1918',
      pdfUrl: 'https://www.marxists.org/portugues/lenin/1917/08/estado-e-a-revolucao.pdf',
      pageUrl: 'https://www.marxists.org/portugues/lenin/1917/08/estadoerevolucao/'
    },
    {
      pattern: /imperialismo.*(fase|estagio|superior).*capitalismo|imperialism.*highest.*capitalism/,
      title: 'O Imperialismo, Fase Superior do Capitalismo',
      authors: ['Vladimir Lenin'],
      year: '1917',
      pdfUrl: 'https://www.marxists.org/portugues/lenin/1916/imperialismo/imperialismo.pdf',
      pageUrl: 'https://www.marxists.org/portugues/lenin/1916/imperialismo/'
    },
    {
      pattern: /reforma.*revolucao|reform.*revolution/,
      title: 'Reforma ou Revolução?',
      authors: ['Rosa Luxemburgo'],
      year: '1900',
      pdfUrl: null,
      pageUrl: 'https://www.marxists.org/portugues/luxemburgo/1900/ref_rev/index.htm'
    },
    {
      pattern: /(^| )capital( |$)|capital.*livro.*(1|i)|capital.*book.*(1|i)/,
      title: 'O Capital Livro I',
      authors: ['Karl Marx'],
      year: '1867',
      pdfUrl: null,
      pageUrl: 'https://www.marxists.org/portugues/marx/1867/capital/livro1/index.htm'
    }
  ];

  response.results = matches
    .filter((entry) => entry.pattern.test(query))
    .map((entry) =>
      buildResult(citation, source, {
        sourceId,
        sourceKind: 'fulltext',
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        pdfUrl: entry.pdfUrl,
        pageUrl: entry.pageUrl,
        materialType: 'book'
      })
    );

  return finalizeAdapterResponse(citation, response);
}

function createManualAdapter(
  source: string,
  sourceId: string,
  manualUrlFactory: (citation: ParsedCitation) => string,
  caption = ''
): SearchAdapter {
  return {
    source,
    sourceId,
    tier: 2,
    caption,
    manualUrl: manualUrlFactory,
    search: async (citation) => ({
      source,
      sourceId,
      tier: 2,
      status: 'success',
      manualUrl: manualUrlFactory(citation),
      results: [],
      error: null,
      caption
    })
  };
}

function createBrazilianManualAdapter(
  source: string,
  sourceId: string,
  manualUrlFactory: (citation: ParsedCitation) => string,
  caption = ''
): SearchAdapter {
  return {
    source,
    sourceId,
    tier: 3,
    caption,
    manualUrl: manualUrlFactory,
    search: async (citation) => ({
      source,
      sourceId,
      tier: 3,
      status: 'success',
      manualUrl: manualUrlFactory(citation),
      results: [],
      error: null,
      caption
    })
  };
}

function buildDomainSearchUrl(
  citation: ParsedCitation,
  domain: string,
  extraTerms = ''
): string {
  const query = buildSiteSearchQuery(citation, domain, extraTerms);
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function buildBroadDomainSearchUrl(
  citation: ParsedCitation,
  domain: string,
  extraTerms = ''
): string {
  const query = buildBroadSiteSearchQuery(citation, domain, extraTerms);
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function buildPublisherSearchUrl(citation: ParsedCitation): string {
  const query = normalizeWhitespace(
    [
      buildExactWebQuery(citation),
      citation.publisher || '',
      'editora OR publisher OR oficial OR official'
    ].join(' ')
  );
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function buildInstitutionalPdfSearchUrl(citation: ParsedCitation): string {
  const query = normalizeWhitespace(
    [
      buildExactWebQuery(citation),
      'filetype:pdf',
      '(site:edu.br OR site:gov.br OR site:org.br OR site:books.scielo.org OR site:senado.leg.br)'
    ].join(' ')
  );
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function buildBrazilianRepositoryPdfSearchUrl(citation: ParsedCitation): string {
  const query = normalizeWhitespace(
    [
      buildExactWebQuery(citation),
      'filetype:pdf',
      '(site:repositorio.usp.br OR site:lume.ufrgs.br OR site:pantheon.ufrj.br OR site:repositorio.ufba.br OR site:repositorio.ufmg.br OR site:repositorio.unicamp.br)'
    ].join(' ')
  );
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function buildAnnasManualUrl(citation: ParsedCitation): string {
  const query = buildSearchQuery(citation, {
    includeSubtitle: false,
    includeAuthor: true,
    authorMode: 'last',
    preferMainTitle: true
  });
  const params = new URLSearchParams({ q: query });
  return `https://annas-archive.gl/search?${params.toString()}`;
}

function annasMaterialType(annas: AnnasResult): MaterialType {
  const blob = `${annas.contentType || ''} ${annas.fileFormat || ''}`.toLowerCase();
  if (/thesis|dissert|tese/.test(blob)) return 'thesis';
  if (/article|journal|paper/.test(blob)) return 'article';
  if (/comic/.test(blob)) return 'book';
  if (/report/.test(blob)) return 'report';
  return 'book';
}

const ANNAS_RESULTS_LIMIT = 50;

async function searchAnnasArchive(
  citation: ParsedCitation,
  _settings: SearchSettings
): Promise<SearchAdapterResponse> {
  const source = "Anna's Archive";
  const sourceId = 'annas_archive';
  const manualUrl = buildAnnasManualUrl(citation);
  const response = createBaseResponse(source, sourceId, 1, manualUrl);

  const query = buildSearchQuery(citation, {
    includeSubtitle: false,
    includeAuthor: true,
    authorMode: 'last',
    preferMainTitle: true
  });

  if (!query.trim()) {
    response.status = 'no_results';
    return response;
  }

  const annasResults = await fetchAnnasSearch(query);

  const built = annasResults
    .map((entry) => {
      const reasonBits = [
        entry.fileFormat ? entry.fileFormat.toUpperCase() : null,
        entry.size || null,
        entry.language || null,
        entry.year || null
      ].filter(Boolean) as string[];

      return buildResult(citation, source, {
        sourceId,
        title: entry.title || citation.title,
        author: entry.authors,
        year: entry.year || null,
        pageUrl: entry.detailUrl,
        pdfUrl: null,
        epubUrl: null,
        coverUrl: entry.coverUrl,
        materialType: annasMaterialType(entry),
        pdfStatus: 'unknown' as PdfStatus,
        pdfStatusReason: reasonBits.length
          ? `Anna's Archive · ${reasonBits.join(' · ')}`
          : "Selecionar mirror em Anna's Archive",
        sourceKind: 'catalog' as SearchSourceKind,
        abstract: entry.description || null,
        confidence: 0.85,
        extra: {
          annasMd5: entry.md5,
          annasFileFormat: entry.fileFormat,
          annasSize: entry.size,
          annasLanguage: entry.language,
          annasPublisher: entry.publisher,
          annasFilePath: entry.filePath,
          annasContentType: entry.contentType
        }
      });
    })
    .filter(hasDownloadOrPage);

  response.results = dedupeResults(built).slice(0, ANNAS_RESULTS_LIMIT);
  if (!response.results.length) {
    response.status = 'no_results';
  }
  return response;
}

const directAdapters: SearchAdapter[] = [
  {
    source: 'Google Books',
    sourceId: 'google_books',
    tier: 1,
    manualUrl: (citation) =>
      `https://books.google.com/books?${new URLSearchParams({
        q: buildSearchQuery(citation)
      }).toString()}`,
    search: searchGoogleBooks
  },
  {
    source: 'CrossRef',
    sourceId: 'crossref',
    tier: 1,
    manualUrl: (citation) => `https://search.crossref.org/?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchCrossRef
  },
  {
    source: 'OpenAlex',
    sourceId: 'openalex',
    tier: 1,
    manualUrl: (citation) => `https://openalex.org/works?search=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchOpenAlex
  },
  {
    source: 'Semantic Scholar',
    sourceId: 'semantic_scholar',
    tier: 1,
    manualUrl: (citation) =>
      `https://www.semanticscholar.org/search?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchSemanticScholar
  },
  {
    source: 'Unpaywall',
    sourceId: 'unpaywall',
    tier: 1,
    manualUrl: (citation) =>
      `https://api.unpaywall.org/v2/search/?${new URLSearchParams({
        query: buildSearchQuery(citation),
        email: 'search@pdfsearch.app'
      }).toString()}`,
    search: searchUnpaywall
  },
  {
    source: 'CORE.ac.uk',
    sourceId: 'core',
    tier: 1,
    manualUrl: (citation) => `https://core.ac.uk/search?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchCore
  },
  {
    source: 'PubMed / PMC',
    sourceId: 'pmc',
    tier: 1,
    manualUrl: (citation) =>
      `https://pmc.ncbi.nlm.nih.gov/?term=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchPmc
  },
  {
    source: 'DOAJ',
    sourceId: 'doaj',
    tier: 1,
    manualUrl: (citation) =>
      `https://doaj.org/search/articles/${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchDoaj
  },
  {
    source: 'SciELO Brasil',
    sourceId: 'scielo_brasil',
    tier: 1,
    manualUrl: (citation) =>
      `https://search.scielo.org/?q=${encodeURIComponent(buildSearchQuery(citation))}&lang=pt`,
    search: searchScielo
  },
  {
    source: 'Senado Federal',
    sourceId: 'senado_federal',
    tier: 1,
    manualUrl: (citation) => buildDomainSearchUrl(citation, 'senado.leg.br', 'pdf'),
    search: searchSenadoFederal
  },
  {
    source: 'Marxists Internet Archive',
    sourceId: 'marxists_archive',
    tier: 1,
    manualUrl: (citation) => buildBroadDomainSearchUrl(citation, 'marxists.org/portugues', 'pdf OR epub'),
    search: searchMarxistsArchive
  },
  {
    source: 'Zenodo',
    sourceId: 'zenodo',
    tier: 1,
    manualUrl: (citation) => `https://zenodo.org/search?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchZenodo
  },
  {
    source: 'HAL',
    sourceId: 'hal',
    tier: 1,
    manualUrl: (citation) => `https://hal.science/search/index/?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchHal
  },
  {
    source: 'BASE',
    sourceId: 'base',
    tier: 1,
    manualUrl: (citation) =>
      `https://www.base-search.net/Search/Results?lookfor=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchBase
  },
  {
    source: 'ERIC',
    sourceId: 'eric',
    tier: 1,
    manualUrl: (citation) => `https://eric.ed.gov/?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchEric
  },
  {
    source: 'Internet Archive',
    sourceId: 'internet_archive',
    tier: 1,
    manualUrl: (citation) =>
      `https://archive.org/search?query=${encodeURIComponent(`${buildSearchQuery(citation)} mediatype:texts`)}`,
    search: searchInternetArchive
  },
  {
    source: 'Project Gutenberg',
    sourceId: 'project_gutenberg',
    tier: 1,
    manualUrl: (citation) =>
      `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(buildSearchQuery(citation))}`,
    search: searchProjectGutenberg
  },
  {
    source: 'Open Library',
    sourceId: 'open_library',
    tier: 1,
    manualUrl: (citation) => makeManualUrl('https://openlibrary.org/search', { q: buildSearchQuery(citation) }),
    search: searchOpenLibrary
  },
  {
    source: "Anna's Archive",
    sourceId: 'annas_archive',
    tier: 1,
    caption: 'Catálogo agregado de livros e artigos',
    manualUrl: buildAnnasManualUrl,
    search: searchAnnasArchive
  }
];

const manualAdapters: SearchAdapter[] = [
  createManualAdapter(
    'Editora / pagina oficial',
    'publisher_official',
    buildPublisherSearchUrl,
    'Pagina oficial, sumario, amostra e dados da edicao'
  ),
  createManualAdapter(
    'Google Books',
    'google_books_manual',
    (citation) =>
      `https://books.google.com/books?${new URLSearchParams({
        q: buildSearchQuery(citation)
      }).toString()}`,
    'Catalogo do Google Books com preview e edicoes'
  ),
  createManualAdapter(
    'PDF institucional',
    'institutional_pdf',
    buildInstitutionalPdfSearchUrl,
    'PDFs de dominios educacionais, governamentais e institucionais'
  ),
  createManualAdapter(
    'Repositorios brasileiros',
    'brazilian_repositories_pdf',
    buildBrazilianRepositoryPdfSearchUrl,
    'Busca em repositorios universitarios brasileiros conhecidos'
  ),
  createManualAdapter(
    'SciELO Books',
    'scielo_books',
    (citation) => buildDomainSearchUrl(citation, 'books.scielo.org'),
    'Livros academicos abertos'
  ),
  createManualAdapter(
    'Senado / BDSF',
    'senado_bdsf_manual',
    (citation) => buildDomainSearchUrl(citation, 'senado.leg.br', 'pdf'),
    'Edicoes publicas e acervo institucional brasileiro'
  ),
  createManualAdapter(
    'Google Web (Exato)',
    'google_web_exact',
    (citation) => `https://www.google.com/search?q=${encodeURIComponent(buildExactWebQuery(citation))}`,
    'Busca web com tÃ­tulo e autor entre aspas'
  ),
  createManualAdapter(
    'Internet Archive (EPUB)',
    'internet_archive_epub',
    (citation) =>
      `https://archive.org/search?query=${encodeURIComponent(`${buildSearchQuery(citation)} mediatype:texts format:epub`)}`,
    'Acervo aberto com filtro para EPUB'
  ),
  createManualAdapter(
    'Project Gutenberg',
    'project_gutenberg_manual',
    (citation) =>
      `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Ebooks em domínio público, com EPUB direto'
  ),
  createManualAdapter(
    'Standard Ebooks',
    'standard_ebooks',
    (citation) => `https://standardebooks.org/ebooks?query=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Edições públicas bem formatadas em EPUB'
  ),
  createManualAdapter(
    'ManyBooks',
    'manybooks',
    (citation) => buildBroadDomainSearchUrl(citation, 'manybooks.net', 'epub'),
    'Busca ampla por ebooks gratuitos e EPUB'
  ),
  createManualAdapter(
    'Marxists Internet Archive (PT)',
    'marxists_pt',
    (citation) => buildBroadDomainSearchUrl(citation, 'marxists.org/portugues', 'pdf OR epub'),
    'Acervo marxista em português com textos integrais'
  ),
  createManualAdapter(
    'Marxists Internet Archive',
    'marxists_org',
    (citation) => buildBroadDomainSearchUrl(citation, 'marxists.org', 'pdf OR epub'),
    'Acervo marxista internacional com textos integrais'
  ),
  createManualAdapter(
    'Open Library (ebooks)',
    'open_library_ebooks',
    (citation) => makeManualUrl('https://openlibrary.org/search', {
      q: buildSearchQuery(citation),
      mode: 'ebooks'
    }),
    'Catálogo com leitura digital e links para acervos parceiros'
  ),
  createManualAdapter(
    'PDFCoffee',
    'pdfcoffee',
    (citation) => buildBroadDomainSearchUrl(citation, 'pdfcoffee.com'),
    'Documentos e PDFs enviados por usuários'
  ),
  createManualAdapter(
    'Scribd',
    'scribd',
    (citation) => `https://www.scribd.com/search?query=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Leitura social com PDFs e documentos variados'
  ),
  createManualAdapter(
    'DocDroid',
    'docdroid',
    (citation) => buildDomainSearchUrl(citation, 'docdroid.net'),
    'Host de documentos com busca por domínio'
  ),
  createManualAdapter(
    'Issuu',
    'issuu',
    (citation) => `https://issuu.com/search?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Revistas e documentos publicados por usuários'
  ),
  createManualAdapter(
    'SlideShare',
    'slideshare',
    (citation) =>
      `https://www.slideshare.net/search/slideshow?searchfrom=header&q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Slides, apostilas e apresentações'
  ),
  createManualAdapter(
    'AnyFlip',
    'anyflip',
    (citation) => buildDomainSearchUrl(citation, 'anyflip.com'),
    'Flipbooks e documentos digitalizados'
  ),
  createManualAdapter(
    'Dokumen.pub',
    'dokumen_pub',
    (citation) => buildBroadDomainSearchUrl(citation, 'dokumen.pub', 'pdf OR epub'),
    'Busca ampla em páginas indexadas do Dokumen.pub'
  ),
  createManualAdapter(
    'PDF Drive',
    'pdf_drive',
    (citation) => buildDomainSearchUrl(citation, 'pdfdrive.com'),
    'Busca ampla por PDFs e ebooks'
  ),
  createManualAdapter(
    'Library Genesis',
    'library_genesis',
    (citation) =>
      `https://libgen.is/search.php?req=${encodeURIComponent(buildSearchQuery(citation))}&column=def`,
    'Busca manual em espelho do acervo'
  ),
  createManualAdapter(
    'Z-Library',
    'z_library',
    (citation) =>
      `https://www.google.com/search?q=${encodeURIComponent(`z-library ${buildSearchQuery(citation)}`)}`,
    'Busca manual por marca para contornar domínios instáveis'
  ),
  createManualAdapter(
    'DOAB',
    'doab',
    (citation) => `https://directory.doabooks.org/discover?query=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Directory of Open Access Books'
  ),
  createManualAdapter(
    'OAPEN',
    'oapen',
    (citation) => `https://library.oapen.org/discover?query=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Livros academicos de acesso aberto'
  ),
  createManualAdapter(
    'HathiTrust',
    'hathitrust',
    (citation) =>
      `https://catalog.hathitrust.org/Search/Home?lookfor=${encodeURIComponent(buildSearchQuery(citation))}&searchtype=all`,
    'Catalogo de bibliotecas digitais'
  ),
  createManualAdapter(
    'OpenEdition Books',
    'openedition_books',
    (citation) => `https://books.openedition.org/catalogue?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Livros academicos, especialmente humanidades'
  ),
  createManualAdapter(
    'Google Scholar',
    'google_scholar',
    (citation) => `https://scholar.google.com/scholar?q=${encodeURIComponent(buildExactWebQuery(citation))}`,
    'Busca acadêmica geral'
  ),
  createManualAdapter(
    'Google Books / filetype:pdf',
    'google_books_institutional_pdf',
    buildInstitutionalPdfSearchUrl,
    'Google com filtro de PDF em fontes institucionais'
  ),
  createManualAdapter(
    'WorldCat',
    'worldcat',
    (citation) => `https://www.worldcat.org/search?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Catálogos de bibliotecas'
  ),
  createManualAdapter(
    'Project MUSE',
    'project_muse',
    (citation) => `https://muse.jhu.edu/search?action=search&query=${encodeURIComponent(citation.title || buildSearchQuery(citation))}`,
    'Busca em livros e artigos'
  ),
  createManualAdapter(
    'JSTOR',
    'jstor',
    (citation) => `https://www.jstor.org/action/doBasicSearch?Query=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Acervo acadêmico indexado'
  ),
  createManualAdapter(
    'Studocu',
    'studocu',
    (citation) => buildDomainSearchUrl(citation, 'studocu.com'),
    'Materiais de faculdade, resumos e provas'
  ),
  createManualAdapter(
    'Bookboon',
    'bookboon',
    (citation) => buildDomainSearchUrl(citation, 'bookboon.com'),
    'Livros técnicos e conteúdo educacional'
  ),
  createManualAdapter(
    'Calameo',
    'calameo',
    (citation) => buildDomainSearchUrl(citation, 'calameo.com'),
    'Publicações e revistas digitais'
  ),
  createManualAdapter(
    'FlipHTML5',
    'fliphtml5',
    (citation) => buildDomainSearchUrl(citation, 'fliphtml5.com'),
    'Flipbooks e documentos hospedados'
  ),
  createManualAdapter(
    'Smallpdf',
    'smallpdf',
    (citation) => buildDomainSearchUrl(citation, 'smallpdf.com'),
    'Busca por páginas e materiais hospedados'
  )
];

const brazilianManualAdapters: SearchAdapter[] = [
  createBrazilianManualAdapter(
    'BDTD',
    'bdtd',
    (citation) =>
      `https://bdtd.ibict.br/vufind/Search/Results?lookfor=${encodeURIComponent(buildSearchQuery(citation))}&type=AllFields`,
    'Teses e dissertações no Brasil'
  ),
  createBrazilianManualAdapter(
    'CAPES Periódicos',
    'capes_periodicos',
    (citation) =>
      `https://www.periodicos.capes.gov.br/index.php/acervo/buscador.html?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Busca institucional'
  ),
  createBrazilianManualAdapter(
    'Domínio Público',
    'dominio_publico',
    (citation) =>
      `http://www.dominiopublico.gov.br/pesquisa/ResultadoPesquisaObraForm.do?select_action=&co_midia=2&no_autor=${encodeURIComponent(getPrimaryAuthorQuery(citation))}&no_obra=${encodeURIComponent(citation.title || '')}`,
    'Portal MEC'
  ),
  createBrazilianManualAdapter(
    'Lume UFRGS',
    'lume_ufrgs',
    (citation) => `https://lume.ufrgs.br/discover?query=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Repositório institucional'
  ),
  createBrazilianManualAdapter(
    'Repositório USP',
    'repositorio_usp',
    (citation) => `https://repositorio.usp.br/result.php?filter[]=${encodeURIComponent(citation.title || buildSearchQuery(citation))}`,
    'Acervo USP'
  ),
  createBrazilianManualAdapter(
    'RI UFBA',
    'ri_ufba',
    (citation) => `https://repositorio.ufba.br/handle/ri/1/discover?query=${encodeURIComponent(citation.title || buildSearchQuery(citation))}`,
    'Padrão DSpace'
  ),
  createBrazilianManualAdapter(
    'RI UFMG',
    'ri_ufmg',
    (citation) => `https://repositorio.ufmg.br/handle/1843/BUBD/discover?query=${encodeURIComponent(citation.title || buildSearchQuery(citation))}`,
    'Padrão DSpace'
  ),
  createBrazilianManualAdapter(
    'RI UFRJ',
    'ri_ufrj',
    (citation) => `https://pantheon.ufrj.br/discover?query=${encodeURIComponent(citation.title || buildSearchQuery(citation))}`,
    'Padrão DSpace'
  ),
  createBrazilianManualAdapter(
    'RI UNICAMP',
    'ri_unicamp',
    (citation) => `https://repositorio.unicamp.br/acervo/detalhe?query=${encodeURIComponent(citation.title || buildSearchQuery(citation))}`,
    'Repositório da universidade'
  ),
  createBrazilianManualAdapter(
    'Portal Livre / SciELO Preprints',
    'portal_livre',
    (citation) => `https://preprints.scielo.org/index.php/scielo/search/search?abstractQuery=${encodeURIComponent(citation.title || buildSearchQuery(citation))}`,
    'Preprints em português'
  ),
  createBrazilianManualAdapter(
    'Academia.edu',
    'academia_edu',
    (citation) => `https://www.academia.edu/search?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Busca por compartilhamentos'
  ),
  createBrazilianManualAdapter(
    'ResearchGate',
    'researchgate',
    (citation) => `https://www.researchgate.net/search?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Busca por autores e artigos'
  ),
  createBrazilianManualAdapter(
    'Estante Virtual',
    'estante_virtual',
    (citation) => `https://www.estantevirtual.com.br/busca?q=${encodeURIComponent(buildSearchQuery(citation))}`,
    'Livros em português'
  )
];

const allAdapters = [...directAdapters, ...manualAdapters, ...brazilianManualAdapters];
const adapterMap = new Map(allAdapters.map((adapter) => [adapter.sourceId, adapter]));
const hiddenManualSourceIds = new Set([
  'google_web_pdf',
  'google_web_epub',
  'pdfcoffee',
  'scribd',
  'docdroid',
  'issuu',
  'slideshare',
  'anyflip',
  'dokumen_pub',
  'pdf_drive',
  'library_genesis',
  'z_library',
  'studocu',
  'calameo',
  'fliphtml5',
  'smallpdf'
]);
const focusedManualSourceIds = new Set([
  'publisher_official',
  'google_books_manual',
  'institutional_pdf',
  'brazilian_repositories_pdf',
  'scielo_books',
  'senado_bdsf_manual',
  'google_web_exact',
  'internet_archive_epub',
  'project_gutenberg_manual',
  'standard_ebooks',
  'manybooks',
  'open_library_ebooks',
  'doab',
  'oapen',
  'hathitrust',
  'openedition_books',
  'worldcat',
  'bdtd',
  'dominio_publico',
  'lume_ufrgs',
  'repositorio_usp',
  'ri_ufba',
  'ri_ufmg',
  'ri_ufrj',
  'ri_unicamp'
]);

export function getDirectAdapters(): SearchAdapter[] {
  return [...directAdapters];
}

function getDirectAdaptersByIds(sourceIds: readonly string[]): SearchAdapter[] {
  const allowed = new Set(sourceIds);
  return directAdapters.filter((adapter) => allowed.has(adapter.sourceId));
}

function getAdaptersForSearchMode(searchMode: SearchMode): SearchAdapter[] {
  if (searchMode === 'focused') {
    return getDirectAdaptersByIds(FOCUSED_SEARCH_SOURCE_IDS);
  }

  return getDirectAdapters();
}

export function getManualSearchEntries(
  citation: ParsedCitation,
  searchMode: SearchMode = 'complete'
): ManualSearchEntry[] {
  return [...manualAdapters, ...brazilianManualAdapters]
    .filter((adapter) => !hiddenManualSourceIds.has(adapter.sourceId))
    .filter((adapter) => searchMode === 'complete' || focusedManualSourceIds.has(adapter.sourceId))
    .map((adapter) => ({
      source: adapter.source,
      sourceId: adapter.sourceId,
      tier: adapter.tier as 2 | 3,
      caption: adapter.caption || (adapter.tier === 3 ? 'Busca manual brasileira' : 'Busca manual'),
      manualUrl: adapter.manualUrl(citation)
    }));
}

export function getAdapterById(sourceId: string): SearchAdapter | undefined {
  return adapterMap.get(sourceId);
}

async function executeAdapter(
  adapter: SearchAdapter,
  citation: ParsedCitation,
  settings: SearchSettings,
  onRateLimit?: SearchRunCallbacks['onRateLimit']
): Promise<SearchAdapterResponse> {
  try {
    const response = await adapter.search(citation, settings);
    return await hardenAdapterResponse(citation, response);
  } catch (unknownError) {
    const error = unknownError as FetchError;
    if (error.kind === 'rate_limit' && onRateLimit) {
      onRateLimit(adapter.sourceId, error.retryAfter || RATE_LIMIT_DEFAULT_SECONDS);
    }
    return mapAdapterFailure(adapter, citation, error);
  }
}

export function isSameResult(left: SearchResult, right: SearchResult): boolean {
  const leftKey = buildResultKey(left);
  const rightKey = buildResultKey(right);
  return leftKey === rightKey;
}

function toSourceStatus(response: SearchAdapterResponse, adapter: SearchAdapter): SourceStatusEntry {
  return {
    label: adapter.source,
    status: response.results.length
      ? 'done'
      : response.status === 'no_results'
        ? 'empty'
        : 'error',
    count: response.results.length,
    error: response.error
  };
}

function buildSkippedAdapterResponse(
  adapter: SearchAdapter,
  citation: ParsedCitation
): SearchAdapterResponse {
  return {
    ...createBaseResponse(adapter.source, adapter.sourceId, adapter.tier, adapter.manualUrl(citation)),
    status: 'no_results',
    results: []
  };
}

async function executeAdapterGroup(
  adapters: SearchAdapter[],
  citation: ParsedCitation,
  settings: SearchSettings,
  aggregatedResults: SearchResult[],
  callbacks: SearchRunCallbacks = {}
): Promise<SearchResult[]> {
  let currentResults = [...aggregatedResults];

  const tasks = adapters.map(async (adapter) => {
    const response = await executeAdapter(adapter, citation, settings, callbacks.onRateLimit);
    return { adapter, response };
  });

  const settled = await Promise.allSettled(tasks);

  settled.forEach((entry) => {
    if (entry.status !== 'fulfilled') {
      return;
    }

    const { adapter, response } = entry.value;
    const responseResults = (Array.isArray(response.results) ? response.results : [])
      .map((result) => ({ ...result, sourceId: result.sourceId || response.sourceId || adapter.sourceId }))
      .filter(hasDownloadOrPage);

    const mergeOutcome = mergeResultsCollection(currentResults, responseResults);
    currentResults = dedupeResults(mergeOutcome.merged);

    callbacks.onSourceUpdate?.({
      adapter,
      response,
      status: toSourceStatus(response, adapter),
      newResults: mergeOutcome.newItems,
      resultsSnapshot: [...currentResults]
    });
  });

  return currentResults;
}

export async function runSearches(
  citation: ParsedCitation,
  settings: SearchSettings,
  callbacks: SearchRunCallbacks = {}
): Promise<SearchResult[]> {
  const searchMode = settings.searchMode || 'complete';
  const adapters = getAdaptersForSearchMode(searchMode);
  let aggregatedResults: SearchResult[] = [];

  callbacks.onStart?.(adapters);

  if (searchMode === 'focused') {
    aggregatedResults = await executeAdapterGroup(
      getDirectAdaptersByIds(FOCUSED_SEARCH_METADATA_SOURCE_IDS),
      citation,
      settings,
      aggregatedResults,
      callbacks
    );

    const metadataResult = chooseBestMetadataResult(
      citation,
      aggregatedResults.filter((result) =>
        FOCUSED_SEARCH_METADATA_SOURCE_IDS.includes(result.sourceId as (typeof FOCUSED_SEARCH_METADATA_SOURCE_IDS)[number])
      )
    );
    const enrichedCitation = enrichCitationWithMetadata(citation, metadataResult);

    aggregatedResults = await executeAdapterGroup(
      getDirectAdaptersByIds(FOCUSED_SEARCH_CATALOG_SOURCE_IDS),
      enrichedCitation,
      settings,
      aggregatedResults,
      callbacks
    );

    callbacks.onFinish?.();
    return dedupeResults(aggregatedResults);
  }

  const metadataAdapters = getDirectAdaptersByIds(METADATA_SOURCE_IDS);
  const fulltextAdapters = getDirectAdaptersByIds(FULLTEXT_SOURCE_IDS);
  const complementaryAdapters = getDirectAdaptersByIds(COMPLEMENTARY_SOURCE_IDS);

  aggregatedResults = await executeAdapterGroup(
    metadataAdapters,
    citation,
    settings,
    aggregatedResults,
    callbacks
  );

  const metadataResult = chooseBestMetadataResult(
    citation,
    aggregatedResults.filter((result) => METADATA_SOURCE_SET.has(result.sourceId || ''))
  );
  const enrichedCitation = enrichCitationWithMetadata(citation, metadataResult);

  aggregatedResults = await executeAdapterGroup(
    fulltextAdapters,
    enrichedCitation,
    settings,
    aggregatedResults,
    callbacks
  );

  const shouldRunComplementary =
    shouldPreferBookCatalogs(enrichedCitation) ||
    aggregatedResults.filter((result) => result.pdfStatus === 'ok' || Boolean(result.pdfUrl || result.epubUrl)).length === 0 ||
    aggregatedResults.length < 3;

  if (shouldRunComplementary) {
    aggregatedResults = await executeAdapterGroup(
      complementaryAdapters,
      enrichedCitation,
      settings,
      aggregatedResults,
      callbacks
    );
  } else {
    complementaryAdapters.forEach((adapter) => {
      const response = buildSkippedAdapterResponse(adapter, enrichedCitation);
      callbacks.onSourceUpdate?.({
        adapter,
        response,
        status: toSourceStatus(response, adapter),
        newResults: [],
        resultsSnapshot: [...aggregatedResults]
      });
    });
  }

  callbacks.onFinish?.();

  return dedupeResults(aggregatedResults);
}

export async function runSingleAdapter(
  sourceId: string,
  citation: ParsedCitation,
  settings: SearchSettings,
  onRateLimit?: SearchRunCallbacks['onRateLimit']
): Promise<
  | {
      response: SearchAdapterResponse;
      newResults: SearchResult[];
      status: SourceStatusEntry;
    }
  | null
> {
  const adapter = getAdapterById(sourceId);
  if (!adapter || adapter.tier !== 1) {
    return null;
  }

  const response = await executeAdapter(adapter, citation, settings, onRateLimit);
  const newResults = (response.results || []).map((result) => ({
    ...result,
    sourceId: response.sourceId || adapter.sourceId
  }));

  return {
    response,
    newResults,
    status: toSourceStatus(response, adapter)
  };
}

export function getSortedResults(
  results: SearchResult[],
  prioritizeReadyPdf = true
): SearchResult[] {
  return [...results].sort((left, right) => {
    const verifiedDiff = Number(right.pdfStatus === 'ok') - Number(left.pdfStatus === 'ok');
    if (verifiedDiff) {
      return verifiedDiff;
    }

    if (prioritizeReadyPdf) {
      const pdfDiff = Number(Boolean(right.pdfUrl)) - Number(Boolean(left.pdfUrl));
      if (pdfDiff) {
        return pdfDiff;
      }

      const epubDiff = Number(Boolean(right.epubUrl)) - Number(Boolean(left.epubUrl));
      if (epubDiff) {
        return epubDiff;
      }
    }

    const confidenceDiff = (right.confidence || 0) - (left.confidence || 0);
    if (confidenceDiff) {
      return confidenceDiff;
    }

    const sourceWeightDiff = (right.sourceWeight || 0) - (left.sourceWeight || 0);
    if (sourceWeightDiff) {
      return sourceWeightDiff;
    }

    return getSourcePriority(left.sourceId) - getSourcePriority(right.sourceId);
  });
}

export function getRateLimitRemaining(rateLimits: Record<string, number>, sourceId: string): number {
  const until = rateLimits[sourceId];
  if (!until) {
    return 0;
  }

  const remaining = Math.ceil((until - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

export function buildParsedFallback(rawInput: string): ParsedCitation | null {
  const parsed = parseCitation(rawInput);
  return parsed ? (markParserSource(parsed, 'local') as ParsedCitation) : null;
}
