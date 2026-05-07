import { buildParsedFallback, parseCitationWithGemini } from '../src/lib/engine';

const samples = [
  'Os Sertões Euclides da Cunha',
  'O Abolicionismo Joaquim Nabuco',
  'A Ilusão Americana Eduardo Prado',
  'O Capital Livro 1 Karl Marx',
  'O Estado e a Revolução Lenin'
];

for (const raw of samples) {
  const fallback = buildParsedFallback(raw);
  if (!fallback) {
    console.log(JSON.stringify({ raw, parsed: null }));
    continue;
  }

  const parsed = await parseCitationWithGemini(raw, fallback);
  console.log(
    JSON.stringify(
      {
        raw,
        fallback: {
          title: fallback.title,
          authors: fallback.authors,
          type: fallback.type
        },
        title: parsed.title,
        authors: parsed.authors,
        type: parsed.type,
        parserSource: parsed._parserSource,
        candidateSource: parsed._searchCandidateSource,
        candidateScore: parsed._searchCandidateScore
      },
      null,
      2
    )
  );
}
