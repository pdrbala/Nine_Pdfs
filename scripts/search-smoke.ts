import { DEFAULT_SETTINGS } from '../src/lib/constants';
import {
  buildParsedFallback,
  getSortedResults,
  parseCitationWithGemini,
  runSearches
} from '../src/lib/engine';

const defaultSamples = [
  'Os Sertões Euclides da Cunha',
  'O Abolicionismo Joaquim Nabuco',
  'A América Latina males de origem Manoel Bomfim',
  'Populações Meridionais do Brasil Oliveira Vianna',
  'A Ilusão Americana Eduardo Prado',
  'Manifesto do Partido Comunista Karl Marx Friedrich Engels',
  'O Capital Livro 1 Karl Marx',
  'O Estado e a Revolução Lenin',
  'Reforma ou Revolução Rosa Luxemburgo',
  'Imperialismo fase superior do capitalismo Lenin'
];

const samples = process.argv.length > 2 ? process.argv.slice(2) : defaultSamples;

const output = [];

for (const raw of samples) {
  const fallback = buildParsedFallback(raw);
  if (!fallback) {
    output.push({ raw, parsed: null, results: [] });
    continue;
  }

  let citation = fallback;
  try {
    citation = await parseCitationWithGemini(raw, fallback);
  } catch {
    citation = fallback;
  }

  const sourceUpdates: Array<{ source: string; sourceId: string; status: string; count: number; error: string | null }> = [];
  const results = await runSearches(
    citation,
    {
      ...DEFAULT_SETTINGS,
      coreApiKey: ''
    },
    {
      onSourceUpdate: ({ adapter, response }) => {
        sourceUpdates.push({
          source: adapter.source,
          sourceId: adapter.sourceId,
          status: response.status,
          count: response.results.length,
          error: response.error
        });
      }
    }
  );

  output.push({
    raw,
    parsed: {
      title: citation.title,
      author: citation.authors.map((author) => `${author.firstName} ${author.lastName}`.trim()).join('; '),
      year: citation.year,
      type: citation.type,
      source: citation._parserSource,
      enriched: citation._searchCandidateSource || ''
    },
    sources: sourceUpdates,
    results: getSortedResults(results)
      .slice(0, 4)
      .map((result) => ({
        source: result.source,
        title: result.title,
        author: result.author,
        confidence: result.confidence,
        pdf: Boolean(result.pdfUrl),
        epub: Boolean(result.epubUrl),
        page: Boolean(result.pageUrl),
        pdfStatus: result.pdfStatus,
        url: result.pdfUrl || result.epubUrl || result.pageUrl
      }))
  });
}

console.log(JSON.stringify(output, null, 2));
