<script lang="ts">
  import { onMount } from 'svelte';
  import '../app.css';
  import { DEFAULT_SETTINGS } from '$lib/constants';
  import {
    createAmazonHtmlEndpointFetcher,
    scrapeAmazonBookFromSearch,
    type AmazonBook
  } from '$lib/amazon';
  import {
    buildAmazonReferenceQuery,
    createPendingAmazonCheck,
    scoreAmazonMatch,
    type AmazonCheckScore
  } from '$lib/amazon-check';
  import EpubConverter from '$lib/components/EpubConverter.svelte';
  import { downloadBlob, downloadEpub, submitEpubUrlConversion } from '$lib/conversion/client';
  import { DEFAULT_EPUB_TO_PDF_OPTIONS } from '$lib/conversion/types';
  import { copyText, downloadPdf } from '$lib/download';
  import {
    buildParsedFallback,
    getManualSearchEntries,
    getRateLimitRemaining,
    getSortedResults,
    parseCitationWithGemini,
    runSearches
  } from '$lib/engine';
  import { getParsedSummaryParts } from '$lib/parser';
  import {
    loadHistory,
    loadSearchCache,
    loadSettings,
    persistHistory,
    persistSearchCache,
    persistSettings,
    pushHistory
  } from '$lib/persistence';
  import type { CachedAmazonCheckStatus } from '$lib/persistence';
  import type {
    ManualSearchEntry,
    ParsedCitation,
    SearchResult,
    SearchMode,
    SearchSettings,
    SourceStatusEntry
  } from '$lib/types';
  import { formatMaterialTypeLabel, getSearchProgress, normalizeWhitespace } from '$lib/utils';

  let rawInput = '';
  let parsedCitation: ParsedCitation | null = null;
  let parseError = '';
  let isSearching = false;
  let results: SearchResult[] = [];
  let sourceStatus: Record<string, SourceStatusEntry> = {};
  let history: string[] = [];
  let settings: SearchSettings = { ...DEFAULT_SETTINGS };
  let rateLimits: Record<string, number> = {};
  let downloadingUrls: string[] = [];
  let amazonReferenceBook: AmazonBook | null = null;
  let amazonCheckStatus: CachedAmazonCheckStatus | 'loading' = 'idle';
  let amazonCheckError = '';
  let amazonCheckRunId = 0;
  let toastMessage = '';
  let toastVisible = false;
  let toastTimer: number | null = null;
  let countdownTimer: number | null = null;
  let helpDialog: HTMLDialogElement | null = null;

  const parseFailureMessage =
    'Não foi possível interpretar a referência — tente no formato SOBRENOME, Nome. Título.';

  $: parsedSummaryParts = getParsedSummaryParts(parsedCitation);
  $: manualEntries = parsedCitation ? getManualSearchEntries(parsedCitation, settings.searchMode) : [];
  $: sortedResults = getSortedResults(results, settings.prioritizeReadyPdf);
  $: progress = getSearchProgress(sourceStatus, results);
  $: verifiedCount = sortedResults.filter((result) => result.pdfStatus === 'ok').length;
  $: epubCount = sortedResults.filter((result) => result.epubUrl).length;
  $: sourceEntries = Object.entries(sourceStatus).map(([sourceId, entry]) => ({
    sourceId,
    ...entry
  }));
  $: sourceStatusVisible = isSearching && sourceEntries.length > 0;
  $: hasSearchContext = Boolean(parsedCitation || isSearching || sortedResults.length);
  $: resultsSummary = !sortedResults.length
    ? isSearching
      ? 'Consultando as fontes acadêmicas em paralelo...'
      : 'Nenhum resultado direto. Use as buscas manuais abaixo.'
    : verifiedCount
      ? `${sortedResults.length} resultado(s), com ${verifiedCount} PDF(s) verificados e ${epubCount} EPUB(s).`
      : `${sortedResults.length} resultado(s) ordenados por PDF/EPUB provável e confiança.`;
  $: searchProgressValue = isSearching ? Math.max(progress.percent, 6) : 0;

  onMount(() => {
    history = loadHistory();
    settings = loadSettings();

    return () => {
      if (toastTimer) {
        window.clearTimeout(toastTimer);
      }
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
      }
    };
  });

  function showToast(message: string): void {
    toastMessage = message;
    toastVisible = true;
    if (toastTimer) {
      window.clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
      toastVisible = false;
    }, 2200);
  }

  function ensureCountdownLoop(): void {
    if (countdownTimer !== null) {
      return;
    }

    countdownTimer = window.setInterval(() => {
      const nextRateLimits: Record<string, number> = {};

      Object.entries(rateLimits).forEach(([sourceId, until]) => {
        if (until > Date.now()) {
          nextRateLimits[sourceId] = until;
        }
      });

      rateLimits = nextRateLimits;

      if (!Object.keys(nextRateLimits).length && countdownTimer !== null) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
    }, 1000);
  }

  function resetSearchOutputs(): void {
    results = [];
    sourceStatus = {};
    rateLimits = {};
    resetAmazonCheck();
    if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function resetAmazonCheck(): void {
    amazonCheckRunId += 1;
    amazonReferenceBook = null;
    amazonCheckStatus = 'idle';
    amazonCheckError = '';
  }

  function getAmazonCheckCacheSnapshot(): {
    amazonReferenceBook: AmazonBook | null;
    amazonCheckStatus: CachedAmazonCheckStatus;
    amazonCheckError: string;
  } {
    return {
      amazonReferenceBook,
      amazonCheckStatus: amazonCheckStatus === 'loading' ? 'idle' : amazonCheckStatus,
      amazonCheckError
    };
  }

  async function runAmazonReferenceCheck(citation: ParsedCitation): Promise<{
    amazonReferenceBook: AmazonBook | null;
    amazonCheckStatus: CachedAmazonCheckStatus;
    amazonCheckError: string;
  } | null> {
    const runId = ++amazonCheckRunId;
    const amazonQuery = buildAmazonReferenceQuery(citation, rawInput);

    amazonReferenceBook = null;
    amazonCheckStatus = 'loading';
    amazonCheckError = '';

    try {
      const response = await scrapeAmazonBookFromSearch(amazonQuery || rawInput, {
        marketplace: 'com.br',
        fetcher: createAmazonHtmlEndpointFetcher(fetch),
        proxyChain: [],
        maxCandidates: 8,
        includeSponsored: false,
        timeoutMs: 12000,
        requestHeaders: {
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
        }
      });

      if (runId !== amazonCheckRunId) {
        return null;
      }

      amazonReferenceBook = response.book;
      amazonCheckStatus = response.book ? 'ready' : 'error';
      amazonCheckError = response.warnings.join(' · ') || '';
      return getAmazonCheckCacheSnapshot();
    } catch (unknownError) {
      if (runId !== amazonCheckRunId) {
        return null;
      }

      amazonReferenceBook = null;
      amazonCheckStatus = 'error';
      amazonCheckError =
        unknownError instanceof Error ? unknownError.message : 'Amazon indisponível';
      return getAmazonCheckCacheSnapshot();
    }
  }

  function updateParsedPreview(): void {
    const clean = normalizeWhitespace(rawInput);
    parseError = '';
    parsedCitation = null;
    resetSearchOutputs();

    if (!clean) {
      return;
    }

    const parsed = buildParsedFallback(clean);
    if (!parsed || !parsed.title) {
      parseError = parseFailureMessage;
      return;
    }

    parsedCitation = parsed;
  }

  async function handleSearch(): Promise<void> {
    rawInput = normalizeWhitespace(rawInput);
    updateParsedPreview();

    if (!parsedCitation) {
      return;
    }

    const cachedSearch = settings.useCachedSearch ? loadSearchCache(rawInput, settings) : null;
    if (cachedSearch) {
      const cachedRawInput = rawInput;
      const cachedSettings = { ...settings };
      parsedCitation = cachedSearch.parsedCitation;
      results = cachedSearch.results;
      sourceStatus = cachedSearch.sourceStatus;
      amazonReferenceBook = cachedSearch.amazonReferenceBook;
      amazonCheckStatus = cachedSearch.amazonCheckStatus;
      amazonCheckError = cachedSearch.amazonCheckError;
      rateLimits = {};
      isSearching = false;
      history = pushHistory(history, rawInput);
      persistHistory(history);
      if (cachedSearch.amazonCheckStatus === 'idle') {
        void runAmazonReferenceCheck(cachedSearch.parsedCitation).then((amazonCheckSnapshot) => {
          if (!amazonCheckSnapshot) {
            return;
          }

          persistSearchCache(cachedRawInput, cachedSettings, {
            parsedCitation: cachedSearch.parsedCitation,
            results: cachedSearch.results,
            sourceStatus: cachedSearch.sourceStatus,
            ...amazonCheckSnapshot
          });
        });
      }
      showToast('Busca carregada do cache.');
      return;
    }

    isSearching = true;
    results = [];
    sourceStatus = {};

    let citation = parsedCitation;

    if (settings.searchMode !== 'focused') {
      try {
        const aiParsed = await parseCitationWithGemini(rawInput, citation);
        if (aiParsed?.title) {
          citation = aiParsed;
          parsedCitation = aiParsed;
          if (aiParsed._searchEnriched && aiParsed._searchCandidateSource) {
            showToast(`Referência reforçada com catálogo: ${aiParsed._searchCandidateSource}.`);
          }
        }
      } catch {
        showToast('Gemini indisponível agora; usando parser local.');
      }
    }

    history = pushHistory(history, rawInput);
    persistHistory(history);
    const amazonCheckTask = runAmazonReferenceCheck(citation);

    const freshResults = await runSearches(citation, settings, {
      onStart(adapters) {
        isSearching = true;
        results = [];
        sourceStatus = Object.fromEntries(
          adapters.map((adapter) => [
            adapter.sourceId,
            { label: adapter.source, status: 'loading', count: 0 } satisfies SourceStatusEntry
          ])
        );
      },
      onRateLimit(sourceId, retryAfter) {
        rateLimits = { ...rateLimits, [sourceId]: Date.now() + retryAfter * 1000 };
        ensureCountdownLoop();
      },
      onSourceUpdate(update) {
        results = update.resultsSnapshot;

        sourceStatus = {
          ...sourceStatus,
          [update.adapter.sourceId]: update.status
        };
      },
      onFinish() {
        isSearching = false;
      }
    });

    results = freshResults;
    const amazonCheckSnapshot = await amazonCheckTask;
    if (!amazonCheckSnapshot) {
      return;
    }

    persistSearchCache(rawInput, settings, {
      parsedCitation: citation,
      results: freshResults,
      sourceStatus,
      ...amazonCheckSnapshot
    });
  }

  function handleClear(): void {
    rawInput = '';
    parsedCitation = null;
    parseError = '';
    resetSearchOutputs();
  }

  async function handleDownload(result: SearchResult): Promise<void> {
    if (!result.pdfUrl) {
      return;
    }

    downloadingUrls = [...new Set([...downloadingUrls, result.pdfUrl])];
    try {
      await downloadPdf(result.pdfUrl, result.title);
    } finally {
      downloadingUrls = downloadingUrls.filter((url) => url !== result.pdfUrl);
    }
  }

  async function handleEpubDownload(result: SearchResult): Promise<void> {
    if (!result.epubUrl) {
      return;
    }

    downloadingUrls = [...new Set([...downloadingUrls, result.epubUrl])];
    try {
      if (settings.convertEpubToPdfByDefault) {
        const converted = await submitEpubUrlConversion(
          result.epubUrl,
          result.title,
          DEFAULT_EPUB_TO_PDF_OPTIONS
        );
        downloadBlob(converted.blob, converted.filename);
        showToast('EPUB convertido para PDF.');
      } else {
        await downloadEpub(result.epubUrl, result.title);
      }
    } catch (unknownError) {
      const error = unknownError instanceof Error ? unknownError.message : 'Falha ao baixar EPUB.';
      showToast(error);
      window.open(result.epubUrl, '_blank', 'noopener');
    } finally {
      downloadingUrls = downloadingUrls.filter((url) => url !== result.epubUrl);
    }
  }

  async function handleCopy(value: string, kind: 'PDF' | 'EPUB' | 'página'): Promise<void> {
    const copied = await copyText(value);
    showToast(copied ? `Link de ${kind} copiado.` : `Não deu para copiar o link de ${kind}.`);
  }

  function applyHistoryEntry(entry: string): void {
    rawInput = entry;
    updateParsedPreview();
  }

  function openAllManualSearches(): void {
    const urls = [...new Set(manualEntries.map((entry) => entry.manualUrl).filter(Boolean))];
    if (!urls.length) {
      showToast('Nenhum link manual pronto ainda.');
      return;
    }

    urls.forEach((url) => {
      window.open(url, '_blank', 'noopener');
    });
  }

  function handleSettingsInput(): void {
    persistSettings(settings);
  }

  function handleSearchModeChange(searchMode: SearchMode): void {
    if (settings.searchMode === searchMode) {
      return;
    }

    settings = { ...settings, searchMode };
    persistSettings(settings);
    resetSearchOutputs();
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleSearch();
    }
  }

  function openHelp(): void {
    helpDialog?.showModal();
  }

  function closeHelp(): void {
    helpDialog?.close();
  }

  function handleHelpDialogClick(event: MouseEvent): void {
    if (!helpDialog) {
      return;
    }

    const rect = helpDialog.getBoundingClientRect();
    const clickedInside =
      rect.top <= event.clientY &&
      event.clientY <= rect.bottom &&
      rect.left <= event.clientX &&
      event.clientX <= rect.right;

    if (!clickedInside) {
      closeHelp();
    }
  }

  function getSourceChipClass(entry: SourceStatusEntry): string {
    return entry.status === 'done'
      ? 'done'
      : entry.status === 'loading'
        ? 'loading'
        : entry.status === 'empty'
          ? 'empty'
          : 'error';
  }

  function getSourceChipSymbol(entry: SourceStatusEntry): string {
    return entry.status === 'done'
      ? '●'
      : entry.status === 'loading'
        ? '⟳'
        : entry.status === 'empty'
          ? '○'
          : '✗';
  }

  function getSourceChipLabel(sourceId: string, entry: SourceStatusEntry): string {
    const remaining = getRateLimitRemaining(rateLimits, sourceId);
    return remaining ? `${entry.label} (${remaining}s)` : entry.label;
  }

  function getBadge(result: SearchResult): {
    label: string;
    className: 'success' | 'warning' | 'muted';
  } {
    if (result.pdfStatus === 'ok') {
      return { label: 'PDF verificado', className: 'success' };
    }
    if (result.pdfUrl) {
      return { label: 'PDF provável', className: 'warning' };
    }
    if (result.epubUrl) {
      return { label: 'EPUB disponível', className: 'warning' };
    }
    return { label: 'Só página', className: 'muted' };
  }

  function isDownloading(url: string | null | undefined): boolean {
    return Boolean(url && downloadingUrls.includes(url));
  }

  function getAmazonCheck(result: SearchResult): AmazonCheckScore {
    if (amazonCheckStatus === 'loading') {
      return createPendingAmazonCheck();
    }

    if (amazonCheckStatus === 'ready') {
      return scoreAmazonMatch(result, amazonReferenceBook);
    }

    return {
      status: 'unavailable',
      score: null,
      label: 'Amazon Check',
      reasons: [amazonCheckError || 'Amazon ainda não consultada']
    };
  }

  function getAmazonCheckStyle(check: AmazonCheckScore): string {
    const score = check.score ?? 0;
    const hue = Math.round(2 + (Math.max(0, Math.min(score, 100)) / 100) * 136);
    return `--amazon-check-hue:${hue}; --amazon-check-fill:${score}%;`;
  }

  function getAmazonCheckTitle(check: AmazonCheckScore): string {
    const score = check.score === null ? 'pendente' : `${check.score}/100`;
    return `${check.label}: ${score}${check.reasons.length ? ` · ${check.reasons.join(', ')}` : ''}`;
  }
</script>

<svelte:head>
  <title>Nine PDFs</title>
</svelte:head>

<main class="app-shell">
  <header class="topbar">
    <div>
      <p class="brand-kicker">Arquivo Noturno de Referências</p>
      <h1 class="brand-title">Nine PDFs</h1>
      <p class="brand-subtitle">
        Digite um título ou uma referência ABNT. O app interpreta a obra, consulta fontes abertas em paralelo e traz primeiro o que dá para baixar em PDF.
      </p>
    </div>
    <button class="help-btn" type="button" aria-label="Ajuda e instruções" on:click={openHelp}>
      ?
    </button>
  </header>

  <section class="catalog-card" aria-labelledby="catalogTitle">
    <div class="card-head">
      <div>
        <h2 id="catalogTitle" class="catalog-title">Catálogo de referência</h2>
        <div class="catalog-meta">
          <span class="catalog-dot" aria-hidden="true"></span>
          <span>Parser ABNT</span>
          <span>Busca paralela</span>
          <span>Fallback de CORS</span>
        </div>
      </div>
    </div>

    <label class="input-label" for="searchInput">Título ou referência ABNT</label>
    <input
      id="searchInput"
      class="search-input"
      type="text"
      bind:value={rawInput}
      placeholder="Ex: Vigiar e Punir — Foucault, 1975"
      spellcheck="false"
      autocomplete="off"
      on:input={updateParsedPreview}
      on:keydown={handleSearchKeydown}
    />

    <div class="mode-control" role="radiogroup" aria-label="Modo de busca">
      <label class:active={settings.searchMode === 'complete'}>
        <input
          type="radio"
          name="searchMode"
          value="complete"
          checked={settings.searchMode === 'complete'}
          on:change={() => handleSearchModeChange('complete')}
        />
        <span>Completo</span>
      </label>
      <label class:active={settings.searchMode === 'focused'}>
        <input
          type="radio"
          name="searchMode"
          value="focused"
          checked={settings.searchMode === 'focused'}
          on:change={() => handleSearchModeChange('focused')}
        />
        <span>Anna's Archive</span>
      </label>
    </div>

    <div class="action-row">
      <button
        class:is-loading={isSearching}
        class="primary-btn"
        type="button"
        disabled={isSearching || !normalizeWhitespace(rawInput)}
        style={`--search-progress: ${searchProgressValue};`}
        on:click={handleSearch}
      >
        <span class="search-btn-content">
          {#if isSearching}
            <span class="search-btn-spinner" aria-hidden="true"></span>
            <span class="search-btn-copy">
              <span class="search-btn-label">Buscando {progress.finished}/{progress.total || '?'}</span>
              <span class="search-btn-meta">{progress.remaining} restantes · {progress.found} título(s)</span>
            </span>
          {:else}
            <span class="search-btn-label">Buscar PDFs / EPUBs</span>
          {/if}
        </span>
      </button>
      <button class="ghost-btn" type="button" on:click={handleClear}>Limpar</button>
    </div>

    <label class="check-row search-cache-row" for="useCachedSearch">
      <input
        id="useCachedSearch"
        class="check-input"
        type="checkbox"
        bind:checked={settings.useCachedSearch}
        on:change={handleSettingsInput}
      />
      <span>Usar busca cacheada</span>
    </label>

    {#if parseError}
      <div class="error-strip" aria-live="polite">{parseError}</div>
    {/if}

    <details class="parse-debug">
      <summary>Referência interpretada</summary>
      <div class="parsed-strip" aria-live="polite">
        {#if parsedSummaryParts.length}
          <strong>Parsed:</strong> {parsedSummaryParts.join(' · ')}
        {:else}
          <strong>Parsed:</strong> cole uma referência para gerar a leitura preliminar.
        {/if}
      </div>
    </details>

    <div class="history-block">
      <p class="history-title">Recentes</p>
      <div class="history-row">
        {#if history.length}
          {#each history as entry}
            <button class="tag-btn" type="button" on:click={() => applyHistoryEntry(entry)}>
              <span class="tag-text">{entry}</span>
            </button>
          {/each}
        {:else}
          <span class="subnote">As 10 últimas buscas aparecem aqui.</span>
        {/if}
      </div>
    </div>

    <details class="settings-panel">
      <summary>Configurações</summary>
      <div class="settings-content">
        <p>
          O parser por IA usa Gemini Flash-Lite para organizar sobrenome, título, ano,
          DOI, ISBN e demais metadados antes da busca. Se a IA falhar, o parser local
          entra como fallback automaticamente.
        </p>

        <label class="check-row" for="prioritizeReadyPdf">
          <input
            id="prioritizeReadyPdf"
            class="check-input"
            type="checkbox"
            bind:checked={settings.prioritizeReadyPdf}
            on:change={handleSettingsInput}
          />
          <span>Priorizar fontes com PDF direto e download rápido</span>
        </label>

        <label class="check-row" for="convertEpubToPdfByDefault">
          <input
            id="convertEpubToPdfByDefault"
            class="check-input"
            type="checkbox"
            bind:checked={settings.convertEpubToPdfByDefault}
            on:change={handleSettingsInput}
          />
          <span>Converter EPUB para PDF automaticamente ao baixar</span>
        </label>

        <label class="input-label" for="coreApiKey">CORE API Key</label>
        <div class="settings-row">
          <input
            id="coreApiKey"
            class="settings-input"
            type="password"
            bind:value={settings.coreApiKey}
            autocomplete="off"
            placeholder="Cole sua chave aqui"
            on:input={handleSettingsInput}
          />
        </div>

        <p class="subnote">
          Gemini usa o modelo <span class="mono">gemini-2.5-flash-lite</span> embutido
          neste app. A configuração da CORE continua opcional e fica salva apenas no
          navegador local.
        </p>
      </div>
    </details>

    <EpubConverter />
  </section>

  {#if sourceStatusVisible}
    <div class="source-status" aria-live="polite">
      {#each sourceEntries as entry}
        <span class={`source-chip ${getSourceChipClass(entry)}`}>
          {getSourceChipSymbol(entry)} {getSourceChipLabel(entry.sourceId, entry)}
        </span>
      {/each}
    </div>
  {/if}

  {#if hasSearchContext}
    <section class="results-section" aria-labelledby="resultsTitle">
      <div class="results-head">
        <h2 id="resultsTitle">Resultados</h2>
        <p>{resultsSummary}</p>
      </div>

      <div class="results-list">
        {#if sortedResults.length}
          {#each sortedResults as result, index}
            {@const badge = getBadge(result)}
            {@const amazonCheck = getAmazonCheck(result)}
            <article class="result-item" style={`--delay:${index}`}>
              <div
                class={`amazon-check ${amazonCheck.status}`}
                style={getAmazonCheckStyle(amazonCheck)}
                title={getAmazonCheckTitle(amazonCheck)}
                aria-label={getAmazonCheckTitle(amazonCheck)}
              >
                <span class="amazon-check-label">{amazonCheck.label}</span>
                <span class="amazon-check-score">
                  {amazonCheck.score === null ? '--' : amazonCheck.score}
                </span>
              </div>

              <div class="result-body">
                {#if result.coverUrl}
                  <a
                    class="result-cover"
                    href={result.pageUrl || result.pdfUrl || result.epubUrl || result.coverUrl}
                    target="_blank"
                    rel="noopener"
                  >
                    <img
                      src={result.coverUrl}
                      alt={`Capa de ${result.title || 'resultado'}`}
                      loading="lazy"
                      referrerpolicy="no-referrer"
                      on:error={(event) => {
                        const img = event.currentTarget as HTMLImageElement;
                        img.parentElement?.classList.add('is-broken');
                      }}
                    />
                  </a>
                {/if}

                <div class="result-main">
                  <div class="result-eyebrow">
                    <span class={`result-chip ${badge.className}`}>{badge.label}</span>
                    <span class="result-chip muted">{result.source}</span>
                    {#if result.materialType && result.materialType !== 'unknown'}
                      <span class="result-chip muted">
                        {formatMaterialTypeLabel(result.materialType)}
                      </span>
                    {/if}
                  </div>

                  <h3 class="result-title">{result.title || 'Sem título'}</h3>

                  {#if result.author || result.year}
                    <p class="result-meta">
                      {#if result.author}{result.author}{/if}
                      {#if result.author && result.year} · {/if}
                      {#if result.year}<span class="mono">{String(result.year)}</span>{/if}
                    </p>
                  {/if}

                  <div class="confidence-bar">
                    <div
                      class="confidence-fill"
                      style={`width:${Math.round((result.confidence || 0) * 100)}%`}
                    ></div>
                  </div>

                  {#if result.pdfStatusReason}
                    <p class="subnote">{result.pdfStatusReason}</p>
                  {/if}
                </div>
              </div>

              <div class="action-stack">
                {#if result.pdfUrl}
                  <button
                    class="download-btn"
                    type="button"
                    disabled={isDownloading(result.pdfUrl)}
                    on:click={() => handleDownload(result)}
                  >
                    {isDownloading(result.pdfUrl) ? '↓ Baixando...' : '↓ Baixar PDF'}
                  </button>
                {/if}

                {#if result.epubUrl}
                  <button
                    class="download-btn"
                    type="button"
                    disabled={isDownloading(result.epubUrl)}
                    on:click={() => handleEpubDownload(result)}
                  >
                    {#if isDownloading(result.epubUrl)}
                      ↓ Processando...
                    {:else if settings.convertEpubToPdfByDefault}
                      ↓ EPUB -> PDF
                    {:else}
                      ↓ Baixar EPUB
                    {/if}
                  </button>
                {/if}

                {#if result.pageUrl}
                  <a class="action-link" href={result.pageUrl} target="_blank" rel="noopener">
                    Abrir página
                  </a>
                {/if}

                {#if result.pdfUrl}
                  <button
                    class="copy-btn"
                    type="button"
                    on:click={() => handleCopy(result.pdfUrl as string, 'PDF')}
                  >
                    Copiar PDF
                  </button>
                {/if}

                {#if result.epubUrl}
                  <button
                    class="copy-btn"
                    type="button"
                    on:click={() => handleCopy(result.epubUrl as string, 'EPUB')}
                  >
                    Copiar EPUB
                  </button>
                {/if}

                {#if result.pageUrl}
                  <button
                    class="copy-btn"
                    type="button"
                    on:click={() => handleCopy(result.pageUrl as string, 'página')}
                  >
                    Copiar página
                  </button>
                {/if}
              </div>
            </article>
          {/each}
        {:else}
          <div class="empty-state">
            {#if isSearching}
              Os resultados entram nesta lista assim que cada fonte responde.
            {:else}
              Nenhum PDF, EPUB ou página da obra foi confirmado nesta rodada.
            {/if}
          </div>
        {/if}
      </div>
    </section>
  {/if}

  {#if manualEntries.length}
    <details class="manual-section">
      <summary>Não encontrou? Abrir buscas manuais</summary>
      <div class="manual-grid">
        <div class="action-row" style="margin-top:0; margin-bottom:12px;">
          <button class="ghost-btn" type="button" on:click={openAllManualSearches}>
            Abrir todos
          </button>
        </div>

        {#each manualEntries as entry, index}
          <section class="manual-card is-highlighted" style={`--delay:${index}`}>
            <div class="manual-head">
              <div>
                <h3 class="manual-name">{entry.source}</h3>
                <p class="manual-caption">{entry.caption}</p>
              </div>
              <span class="card-status success">Pronto</span>
            </div>

            <p class="manual-message">
              Abrir em nova aba com a consulta preenchida automaticamente.
            </p>

            <div class="manual-actions">
              <a class="action-link primary" href={entry.manualUrl} target="_blank" rel="noopener">
                Buscar
              </a>
              <button
                class="copy-btn"
                type="button"
                on:click={() => handleCopy(entry.manualUrl, 'página')}
              >
                Copiar URL
              </button>
            </div>
          </section>
        {/each}
      </div>
    </details>
  {/if}
</main>

<div class="toast" class:is-visible={toastVisible} role="status" aria-live="polite">
  {toastMessage}
</div>

<dialog bind:this={helpDialog} class="help-dialog" on:click={handleHelpDialogClick}>
  <header>
    <h3>Como funciona</h3>
  </header>
  <div class="help-body">
    <p>
      Este app foi pensado para rodar no navegador com uma interface limpa, enquanto a
      busca consulta fontes abertas em paralelo e usa fallback para CORS quando preciso.
    </p>
    <ul>
      <li>Cole a referência completa em ABNT ou apenas o título da obra.</li>
      <li>O parser tenta extrair autor, título, subtítulo, ano, editora, cidade, DOI e ISBN.</li>
      <li>O Gemini entra para enriquecer casos ambíguos ou consultas só com título.</li>
      <li>Os resultados sobem ordenados por PDF verificado, PDF provável e página da obra.</li>
      <li>Os chips acima da lista mostram quais fontes ainda estão sendo consultadas.</li>
    </ul>
    <p class="muted">
      Algumas APIs públicas podem mudar formato, exigir chave ou bloquear tráfego. Quando
      isso acontece, o app continua útil pelos links manuais.
    </p>
  </div>
  <footer>
    <button class="ghost-btn" type="button" on:click={closeHelp}>Fechar</button>
  </footer>
</dialog>
