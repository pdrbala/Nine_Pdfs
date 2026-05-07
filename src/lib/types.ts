export type CitationType = 'book' | 'thesis' | 'article' | 'unknown';

export type MaterialType =
  | 'book'
  | 'article'
  | 'thesis'
  | 'preprint'
  | 'report'
  | 'chapter'
  | 'unknown';

export type PdfStatus = 'ok' | 'unknown' | 'broken' | 'none';
export type SearchSourceKind = 'metadata' | 'fulltext' | 'catalog';
export type SearchMode = 'complete' | 'focused';

export type AdapterResponseStatus =
  | 'success'
  | 'error'
  | 'cors_blocked'
  | 'no_results'
  | 'loading';

export type ParserSource = 'local' | 'gemini' | 'catalog' | 'gemini_catalog';

export interface CitationAuthor {
  lastName: string;
  firstName: string;
}

export interface ParsedCitation {
  authors: CitationAuthor[];
  title: string;
  subtitle: string | null;
  year: string | null;
  publisher: string | null;
  city: string | null;
  edition: string | null;
  type: CitationType;
  isbn: string | null;
  doi: string | null;
  rawQuery: string;
  raw: string;
  _parserSource?: ParserSource;
  _searchEnriched?: boolean;
  _searchCandidateCount?: number;
  _searchCandidateSource?: string;
  _searchCandidateScore?: number;
}

export interface SparseCandidate {
  source: string;
  title: string;
  subtitle: string | null;
  authors: CitationAuthor[];
  year: string | null;
  publisher: string | null;
  city: string | null;
  edition: string | null;
  type: CitationType;
  isbn: string | null;
  doi: string | null;
  pageUrl: string | null;
  score: number;
}

export interface SearchResult {
  paperId?: string | null;
  title: string;
  author: string;
  authors?: string[];
  year: string | number | null;
  publishedDate?: string | null;
  abstract?: string | null;
  journal?: string | null;
  url?: string | null;
  pdfUrl: string | null;
  epubUrl?: string | null;
  pageUrl: string | null;
  coverUrl?: string | null;
  materialType: MaterialType;
  pdfStatus: PdfStatus;
  pdfStatusReason: string;
  source: string;
  sourceId?: string;
  sourceKind?: SearchSourceKind;
  sourceWeight?: number;
  confidence: number;
  doi?: string | null;
  categories?: string[];
  extra?: Record<string, unknown> | null;
}

export interface SearchAdapterResponse {
  source: string;
  sourceId: string;
  tier: 1 | 2 | 3;
  status: AdapterResponseStatus;
  manualUrl: string;
  results: SearchResult[];
  error: string | null;
  caption?: string;
}

export interface SearchSettings {
  coreApiKey: string;
  prioritizeReadyPdf: boolean;
  convertEpubToPdfByDefault: boolean;
  searchMode: SearchMode;
}

export interface ManualSearchEntry {
  source: string;
  sourceId: string;
  tier: 2 | 3;
  caption: string;
  manualUrl: string;
}

export interface SearchAdapter {
  source: string;
  sourceId: string;
  tier: 1 | 2 | 3;
  caption?: string;
  manualUrl: (citation: ParsedCitation) => string;
  search: (
    citation: ParsedCitation,
    settings: SearchSettings
  ) => Promise<SearchAdapterResponse>;
}

export interface SourceStatusEntry {
  label: string;
  status: 'loading' | 'done' | 'empty' | 'error';
  count: number;
  error?: string | null;
}

export interface SearchProgress {
  total: number;
  finished: number;
  found: number;
  percent: number;
  remaining: number;
}

export interface FetchError extends Error {
  kind: 'rate_limit' | 'http' | 'cors' | 'network';
  status?: number;
  retryAfter?: number;
}

export interface SearchRunUpdate {
  adapter: SearchAdapter;
  response: SearchAdapterResponse;
  status: SourceStatusEntry;
  newResults: SearchResult[];
  resultsSnapshot: SearchResult[];
}

export interface SearchRunCallbacks {
  onStart?: (adapters: SearchAdapter[]) => void;
  onSourceUpdate?: (update: SearchRunUpdate) => void;
  onRateLimit?: (sourceId: string, retryAfter: number) => void;
  onFinish?: () => void;
}
