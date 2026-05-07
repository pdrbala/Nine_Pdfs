import { DEFAULT_SETTINGS, HISTORY_KEY, SEARCH_CACHE_KEY, SETTINGS_KEY } from '$lib/constants';
import type { AmazonBook } from '$lib/amazon';
import type { ParsedCitation, SearchResult, SearchSettings, SourceStatusEntry } from '$lib/types';
import { normalizeWhitespace } from '$lib/utils';

const SEARCH_CACHE_LIMIT = 30;

export type CachedAmazonCheckStatus = 'idle' | 'ready' | 'error';

export interface CachedSearchPayload {
  rawInput: string;
  parsedCitation: ParsedCitation;
  results: SearchResult[];
  sourceStatus: Record<string, SourceStatusEntry>;
  amazonReferenceBook: AmazonBook | null;
  amazonCheckStatus: CachedAmazonCheckStatus;
  amazonCheckError: string;
  cachedAt: number;
}

interface SearchCacheEntry {
  key: string;
  payload: CachedSearchPayload;
}

export function loadHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.map((entry) => normalizeWhitespace(String(entry))).filter(Boolean).slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

export function persistHistory(history: string[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
}

export function pushHistory(history: string[], entry: string): string[] {
  const clean = normalizeWhitespace(entry);
  if (!clean) {
    return history.slice(0, 10);
  }

  return [clean, ...history.filter((item) => item !== clean)].slice(0, 10);
}

export function loadSettings(): SearchSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      coreApiKey:
        typeof parsed?.coreApiKey === 'string' ? normalizeWhitespace(parsed.coreApiKey) : '',
      prioritizeReadyPdf:
        typeof parsed?.prioritizeReadyPdf === 'boolean'
          ? parsed.prioritizeReadyPdf
          : DEFAULT_SETTINGS.prioritizeReadyPdf,
      convertEpubToPdfByDefault:
        typeof parsed?.convertEpubToPdfByDefault === 'boolean'
          ? parsed.convertEpubToPdfByDefault
          : DEFAULT_SETTINGS.convertEpubToPdfByDefault,
      useCachedSearch:
        typeof parsed?.useCachedSearch === 'boolean'
          ? parsed.useCachedSearch
          : DEFAULT_SETTINGS.useCachedSearch,
      searchMode:
        parsed?.searchMode === 'focused' || parsed?.searchMode === 'complete'
          ? parsed.searchMode
          : DEFAULT_SETTINGS.searchMode
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function persistSettings(settings: SearchSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function buildSearchCacheKey(
  rawInput: string,
  settings: Pick<SearchSettings, 'coreApiKey' | 'searchMode'>
): string {
  return JSON.stringify({
    input: normalizeWhitespace(rawInput),
    searchMode: settings.searchMode || DEFAULT_SETTINGS.searchMode,
    hasCoreApiKey: Boolean(normalizeWhitespace(settings.coreApiKey))
  });
}

function readSearchCacheEntries(): SearchCacheEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is SearchCacheEntry => {
        return (
          typeof entry?.key === 'string' &&
          typeof entry?.payload?.rawInput === 'string' &&
          typeof entry?.payload?.parsedCitation === 'object' &&
          Array.isArray(entry?.payload?.results) &&
          typeof entry?.payload?.sourceStatus === 'object'
        );
      })
      .map((entry) => ({
        key: entry.key,
        payload: {
          ...entry.payload,
          amazonReferenceBook: entry.payload.amazonReferenceBook ?? null,
          amazonCheckStatus: isCachedAmazonCheckStatus(entry.payload.amazonCheckStatus)
            ? entry.payload.amazonCheckStatus
            : entry.payload.amazonReferenceBook
              ? 'ready'
              : 'idle',
          amazonCheckError:
            typeof entry.payload.amazonCheckError === 'string' ? entry.payload.amazonCheckError : '',
          cachedAt: typeof entry.payload.cachedAt === 'number' ? entry.payload.cachedAt : 0
        }
      }))
      .slice(0, SEARCH_CACHE_LIMIT);
  } catch {
    return [];
  }
}

function isCachedAmazonCheckStatus(value: unknown): value is CachedAmazonCheckStatus {
  return value === 'idle' || value === 'ready' || value === 'error';
}

export function loadSearchCache(
  rawInput: string,
  settings: Pick<SearchSettings, 'coreApiKey' | 'searchMode'>
): CachedSearchPayload | null {
  const key = buildSearchCacheKey(rawInput, settings);
  return readSearchCacheEntries().find((entry) => entry.key === key)?.payload || null;
}

export function persistSearchCache(
  rawInput: string,
  settings: Pick<SearchSettings, 'coreApiKey' | 'searchMode'>,
  payload: Omit<CachedSearchPayload, 'cachedAt' | 'rawInput'>
): void {
  try {
    const key = buildSearchCacheKey(rawInput, settings);
    const nextEntry: SearchCacheEntry = {
      key,
      payload: {
        ...payload,
        rawInput: normalizeWhitespace(rawInput),
        cachedAt: Date.now()
      }
    };
    const entries = readSearchCacheEntries().filter((entry) => entry.key !== key);

    localStorage.setItem(
      SEARCH_CACHE_KEY,
      JSON.stringify([nextEntry, ...entries].slice(0, SEARCH_CACHE_LIMIT))
    );
  } catch {
    // Cache is an optimization; search results should still work if storage is unavailable.
  }
}
