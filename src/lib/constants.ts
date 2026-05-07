import type { SearchSettings } from '$lib/types';

export const HISTORY_KEY = 'pdf_locator_history_v1';
export const SETTINGS_KEY = 'pdf_locator_settings_v1';
export const RATE_LIMIT_DEFAULT_SECONDS = 60;
export const DIRECT_RESULTS_LIMIT = 5;
export const DEFAULT_GEMINI_API_KEY = 'AIzaSyCUIo8sOUSzxlZxItoo4xODQQCKBpLo4nU';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';

export const DEFAULT_SETTINGS: SearchSettings = {
  coreApiKey: '',
  prioritizeReadyPdf: true,
  convertEpubToPdfByDefault: true,
  searchMode: 'complete'
};

export const METADATA_SOURCE_IDS = ['google_books', 'crossref', 'openalex', 'semantic_scholar'] as const;

export const FULLTEXT_SOURCE_IDS = [
  'unpaywall',
  'core',
  'pmc',
  'doaj',
  'scielo_brasil',
  'senado_federal',
  'marxists_archive',
  'zenodo',
  'hal',
  'base',
  'eric'
] as const;

export const COMPLEMENTARY_SOURCE_IDS = ['internet_archive', 'open_library', 'project_gutenberg'] as const;

export const FOCUSED_SEARCH_METADATA_SOURCE_IDS = ['google_books', 'crossref'] as const;
export const FOCUSED_SEARCH_CATALOG_SOURCE_IDS = [
  'internet_archive',
  'open_library',
  'project_gutenberg'
] as const;
export const FOCUSED_SEARCH_SOURCE_IDS = [
  ...FOCUSED_SEARCH_METADATA_SOURCE_IDS,
  ...FOCUSED_SEARCH_CATALOG_SOURCE_IDS
] as const;

export const DIRECT_SOURCE_PRIORITY = [
  'unpaywall',
  'core',
  'scielo_brasil',
  'senado_federal',
  'marxists_archive',
  'pmc',
  'doaj',
  'google_books',
  'openalex',
  'zenodo',
  'hal',
  'semantic_scholar',
  'base',
  'crossref',
  'project_gutenberg',
  'internet_archive',
  'open_library',
  'eric'
] as const;

export const DIRECT_SOURCE_PRIORITY_MAP = new Map<string, number>(
  DIRECT_SOURCE_PRIORITY.map((sourceId, index) => [sourceId, index])
);

export const SOURCE_CONFIDENCE_WEIGHTS: Record<string, number> = {
  unpaywall: 0.18,
  core: 0.18,
  pmc: 0.17,
  scielo_brasil: 0.17,
  senado_federal: 0.17,
  marxists_archive: 0.17,
  doaj: 0.16,
  openalex: 0.15,
  zenodo: 0.15,
  hal: 0.14,
  semantic_scholar: 0.13,
  google_books: 0.16,
  crossref: 0.13,
  project_gutenberg: 0.12,
  base: 0.1,
  internet_archive: 0.09,
  open_library: 0.08,
  eric: 0.08
};

export const STOPWORDS = new Set([
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
  'uns',
  'umas',
  'the',
  'and',
  'or',
  'of',
  'in',
  'on',
  'at',
  'with',
  'without',
  'sobre',
  'na',
  'no',
  'nas',
  'nos',
  'ao',
  'aos',
  'an',
  'et',
  'al',
  'la',
  'le',
  'des',
  'du',
  'del',
  'della',
  'di',
  'y',
  'el',
  'los',
  'las',
  'como',
  'entre',
  'from',
  'into',
  'book'
]);
