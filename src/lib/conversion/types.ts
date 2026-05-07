export type EpubToPdfPageSize = 'A4' | 'Letter';

export interface EpubToPdfOptions {
  pageSize: EpubToPdfPageSize;
  margin: number;
  includeCover: boolean;
  includeToc: boolean;
}

export interface EpubMetadata {
  title: string;
  authors: string[];
  language: string | null;
  publisher: string | null;
  date: string | null;
}

export interface EpubChapter {
  id: string;
  href: string;
  title: string;
  text: string;
}

export interface EpubToPdfResult {
  filename: string;
  metadata: EpubMetadata;
  chapterCount: number;
  warnings: string[];
  pdf: Uint8Array;
}

export const DEFAULT_EPUB_TO_PDF_OPTIONS: EpubToPdfOptions = {
  pageSize: 'A4',
  margin: 54,
  includeCover: true,
  includeToc: true
};

