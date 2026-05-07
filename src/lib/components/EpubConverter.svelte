<script lang="ts">
  import { downloadBlob, submitEpubConversion } from '$lib/conversion/client';
  import { DEFAULT_EPUB_TO_PDF_OPTIONS } from '$lib/conversion/types';
  import type { EpubToPdfOptions } from '$lib/conversion/types';

  let epubFile: File | null = null;
  let options: EpubToPdfOptions = { ...DEFAULT_EPUB_TO_PDF_OPTIONS };
  let isConverting = false;
  let errorMessage = '';
  let statusMessage = '';

  function handleFileChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    epubFile = input.files?.[0] || null;
    errorMessage = '';
    statusMessage = epubFile ? `${epubFile.name} pronto para converter.` : '';
  }

  async function handleConversion(): Promise<void> {
    if (!epubFile || isConverting) {
      return;
    }

    isConverting = true;
    errorMessage = '';
    statusMessage = 'Convertendo EPUB...';

    try {
      const result = await submitEpubConversion(epubFile, options);
      downloadBlob(result.blob, result.filename);

      statusMessage = result.warnings.length
        ? `PDF gerado com aviso: ${result.warnings.join(' | ')}`
        : `PDF gerado${result.chapterCount ? ` com ${result.chapterCount} capítulo(s)` : ''}.`;
    } catch (unknownError) {
      errorMessage = unknownError instanceof Error ? unknownError.message : 'Falha ao converter EPUB.';
      statusMessage = '';
    } finally {
      isConverting = false;
    }
  }
</script>

<details class="converter-panel">
  <summary>Conversor EPUB -> PDF</summary>
  <div class="converter-content">
    <label class="file-drop" for="epubFileInput">
      <input
        id="epubFileInput"
        class="file-input"
        type="file"
        accept=".epub,application/epub+zip"
        on:change={handleFileChange}
      />
      <span class="file-drop-title">
        {epubFile ? epubFile.name : 'Selecionar EPUB'}
      </span>
      <span class="file-drop-meta">
        {epubFile ? `${Math.max(epubFile.size / 1024 / 1024, 0.01).toFixed(2)} MB` : 'Arquivo local'}
      </span>
    </label>

    <div class="converter-controls">
      <label class="control-field" for="epubPageSize">
        <span>Tamanho</span>
        <select id="epubPageSize" class="settings-input compact" bind:value={options.pageSize}>
          <option value="A4">A4</option>
          <option value="Letter">Letter</option>
        </select>
      </label>

      <label class="control-field" for="epubMargin">
        <span>Margem</span>
        <input
          id="epubMargin"
          class="settings-input compact"
          type="number"
          min="24"
          max="96"
          step="6"
          bind:value={options.margin}
        />
      </label>
    </div>

    <div class="converter-checks">
      <label class="check-row compact" for="epubIncludeCover">
        <input
          id="epubIncludeCover"
          class="check-input"
          type="checkbox"
          bind:checked={options.includeCover}
        />
        <span>Incluir capa quando disponível</span>
      </label>

      <label class="check-row compact" for="epubIncludeToc">
        <input
          id="epubIncludeToc"
          class="check-input"
          type="checkbox"
          bind:checked={options.includeToc}
        />
        <span>Incluir sumário gerado</span>
      </label>
    </div>

    <div class="action-row">
      <button
        class="primary-btn"
        type="button"
        disabled={!epubFile || isConverting}
        on:click={handleConversion}
      >
        {isConverting ? 'Convertendo...' : 'Converter EPUB'}
      </button>
    </div>

    {#if errorMessage}
      <div class="error-strip" aria-live="polite">{errorMessage}</div>
    {:else if statusMessage}
      <div class="summary-strip" aria-live="polite">{statusMessage}</div>
    {/if}
  </div>
</details>

