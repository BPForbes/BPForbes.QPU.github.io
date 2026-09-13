// Correction Lab: catalog + uploads, editable truth tables, circuit test/correct, and NL chat share one workflow state.
import { ChangeEvent, FormEvent, memo, useCallback, useMemo, useState } from 'react';
import {
  buildProcessCatalogSummaries,
  enforceProtectedTruthTable,
  getCatalogEntries,
  getCatalogEntry,
  getCatalogLibrarySources,
  getCatalogTruthTable,
  getCatalogVersion,
  isCatalogTruthTableProtected,
  isProtectedQpuioProcess,
  persistCatalogArtifacts,
  registerCatalogProcess,
  registerCatalogTruthTable,
  resolveCatalogEntry,
  warnProtectedTruthTable,
  type ProcessCatalogOrigin,
} from '../data/catalog';
import {
  companionQpucirFileName,
  companionQpuioFileName,
  downloadQpucirSource,
  downloadQpucirTxtSource,
  downloadQpuioContents,
  isLooseQpucirUpload,
  isQpuioFileName,
  isQpucirFileName,
  parseQpucirPayload,
  parseQpuioPayload,
  processStemFromQpuioFileName,
  qpuioFileNameForProcess,
  qpuioTxtFileNameForProcess,
  QPU_FILE_UPLOAD_ACCEPT,
  serializeQpuioText,
  validateUploadFileName,
} from '../data/formats';
import {
  formatClarificationRetry,
  parseCorrectionIntent,
  resolveClarificationResponse,
} from '../simulator/correction';
import type { ModelCorrectionIntent, PendingClarification } from '../simulator/llm/intentTypes';
import {
  BROWSER_MODEL_OPTIONS,
  loadLlmSettings,
  saveLlmSettings,
  type LlmSettings,
} from '../simulator/llm/config';
import { getCachedBrowserModelId } from '../simulator/llm/config';
import { hasWebGpu } from '../simulator/physics';
import { createBlankProtocol, extractMainProcessName, syncProtocolToTruthTable } from '../simulator/compiler';
import {
  CorrectionGuidance,
  createEmptyTruthTable,
  createTruthTableFromColumns,
  describeTruthTableDimensions,
  formatTruthTableRowSummary,
  formatTestFailureSummary,
  isTruthCellValue,
  probeModuleOutputs,
  resizeTruthTable,
  runModuleTest,
  serializeTruthTableJson,
  singleBitFullAdderTruthTable,
  testCircuitAgainstTruthTable,
  type TruthCellValue,
  type TruthTable,
  type TruthTableTestResult,
} from '../simulator/moduleTestApi';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

const DEFAULT_INPUTS = ['A', 'B'];
const DEFAULT_OUTPUTS = ['Y'];
const cellOptions: TruthCellValue[] = ['0p', '1p', 'sp'];
const MAX_INPUT_COUNT = 6;
const MAX_OUTPUT_COUNT = 4;

const generateId = () => {
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const welcomeMessage = `Welcome to the Circuit Correction Lab. Pick a cataloged process or upload a .qpucir module (or -qpucir.txt on devices that hide custom extensions), shape the truth table, then chat to test and correct circuits.
Commands like "test the circuit" or "fix automatically" use the fast built-in parser. For free-form questions, enable AI below — the browser model downloads once and is cached for later visits.
Try: "open SingleBitFullAdder", "test the circuit", or "fix the circuit automatically".`;

const createInitialTruthTable = () => createTruthTableFromColumns(DEFAULT_INPUTS, DEFAULT_OUTPUTS);

const nextColumnNames = (prefix: string, count: number, existing: string[] = []) => (
  Array.from({ length: count }, (_, index) => existing[index] ?? `${prefix}${index}`)
);

// Memoized row editor so large truth tables do not re-render the full grid on every cell change.
type TruthTableRowProps = {
  rowIndex: number;
  row: TruthCellValue[];
  failed: boolean;
  passed: boolean;
  readOnly: boolean;
  onCellChange: (rowIndex: number, columnIndex: number, value: TruthCellValue) => void;
};

const TruthTableRow = memo(({
  rowIndex,
  row,
  failed,
  passed,
  readOnly,
  onCellChange,
}: TruthTableRowProps) => (
  <tr className={failed ? 'truth-row-fail' : passed ? 'truth-row-pass' : undefined}>
    <td>{rowIndex}</td>
    {row.map((cell, columnIndex) => (
      <td key={`${rowIndex}-${columnIndex}`}>
        <select
          disabled={readOnly}
          onChange={(event) => {
            const value = event.target.value;
            if (isTruthCellValue(value)) onCellChange(rowIndex, columnIndex, value);
          }}
          value={cell}
        >
          {cellOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </td>
    ))}
  </tr>
));

TruthTableRow.displayName = 'TruthTableRow';

export const ModuleLab = () => {
  // Workspace state: protocol text, truth table, last test, catalog selection, and chat/LLM preferences.
  const [source, setSource] = useState(() => createBlankProtocol(DEFAULT_INPUTS, DEFAULT_OUTPUTS));
  const [truthTable, setTruthTable] = useState<TruthTable>(() => createInitialTruthTable());
  const [lastTestResult, setLastTestResult] = useState<TruthTableTestResult | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState('');
  const [status, setStatus] = useState('Adjust the truth-table dimensions or choose a cataloged process to begin.');
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'welcome', role: 'assistant', text: welcomeMessage },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [useLlm, setUseLlm] = useState(false);
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(() => loadLlmSettings());
  const [modelReady, setModelReady] = useState(() => (
    getCachedBrowserModelId() === loadLlmSettings().browserModel
  ));
  const [modelLoading, setModelLoading] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [pendingGuidance, setPendingGuidance] = useState<CorrectionGuidance>({});
  const [pendingClarification, setPendingClarification] = useState<PendingClarification | null>(null);
  const [catalogRefresh, setCatalogRefresh] = useState(() => getCatalogVersion());

  const catalogEntries = useMemo(() => getCatalogEntries(), [catalogRefresh]);
  const librarySources = useMemo(() => getCatalogLibrarySources(), [catalogRefresh]);
  const processCatalog = useMemo(() => buildProcessCatalogSummaries(), [catalogRefresh]);
  const activeProcessName = extractMainProcessName(source);
  const truthTableProtected = isCatalogTruthTableProtected(activeProcessName ?? '');

  const dimensions = useMemo(() => {
    if (!truthTable) return null;
    try {
      return describeTruthTableDimensions(source, truthTable);
    } catch {
      return {
        rowCount: truthTable.rows.length,
        columnCount: truthTable.inputColumns.length + truthTable.outputColumns.length,
        inputCount: truthTable.inputColumns.length,
        outputCount: truthTable.outputColumns.length,
        listedRowCount: truthTable.rows.length,
      };
    }
  }, [truthTable, source]);

  const failedRowIndexes = useMemo(
    () => new Set(lastTestResult?.failedRows.map((row) => row.rowIndex) ?? []),
    [lastTestResult],
  );

  const displayStatus = lastTestResult ? formatTestFailureSummary(lastTestResult) : status;

  const refreshCatalog = useCallback(() => {
    setCatalogRefresh(getCatalogVersion());
  }, []);

  const pushMessage = useCallback((role: ChatMessage['role'], text: string) => {
    setMessages((current) => [...current, { id: generateId(), role, text }]);
  }, []);

  const buildNlContext = useCallback((
    table: TruthTable | null = truthTable,
    clarification: PendingClarification | null = pendingClarification,
  ) => ({
    source,
    truthTable: table,
    inputColumns: table?.inputColumns ?? [],
    outputColumns: table?.outputColumns ?? [],
    activeProcessName,
    processCatalog,
    lastTestResult,
    libraryProcessNames: Object.keys(librarySources),
    pendingClarification: clarification,
  }), [source, truthTable, activeProcessName, processCatalog, lastTestResult, librarySources, pendingClarification]);

  // All table writes pass through protected-process enforcement so bundled .qpuio metadata cannot be edited away.
  const commitTruthTable = useCallback((
    processName: string | null | undefined,
    attempted: TruthTable,
    reason?: string,
  ) => {
    const enforced = enforceProtectedTruthTable(processName, attempted);
    if (!enforced) {
      setTruthTable(attempted);
      return attempted;
    }
    setTruthTable(enforced.truthTable);
    if (enforced.reverted) {
      warnProtectedTruthTable(processName ?? 'this process', reason ?? 'Manual truth-table edits are not allowed for bundled site metadata.');
      setStatus(`Protected truth table restored for ${processName}.`);
    }
    return enforced.truthTable;
  }, []);

  const applySource = useCallback((
    nextSource: string,
    label: string,
    options?: { resetTable?: boolean; truthTable?: TruthTable | null },
  ) => {
    const resetTable = options?.resetTable ?? true;
    const processName = extractMainProcessName(nextSource);
    setSource(nextSource);
    setLastTestResult(null);
    if (resetTable) {
      if (options?.truthTable) {
        commitTruthTable(processName, options.truthTable);
      } else {
        try {
          commitTruthTable(processName, createEmptyTruthTable(nextSource));
        } catch {
          setTruthTable(createInitialTruthTable());
        }
      }
    }
    setStatus(label);
  }, [commitTruthTable]);

  const loadCatalogProcess = useCallback((name: string, options?: { silent?: boolean }) => {
    const entry = resolveCatalogEntry(name) ?? getCatalogEntry(name);
    if (!entry) {
      setStatus(`Process "${name}" is not in the catalog.`);
      return null;
    }
    setSelectedCatalogId(entry.id);
    const catalogTable = entry.truthTable ?? getCatalogTruthTable(entry.name);
    applySource(entry.source, `Loaded catalog process ${entry.name}.`, {
      truthTable: catalogTable ?? undefined,
    });
    if (!options?.silent) {
      const tableNote = catalogTable
        ? ` Loaded bundled truth table (${catalogTable.rows.length} rows).`
        : ' Say "infer truth table" or "test the circuit" to continue.';
      pushMessage('assistant', `Loaded ${entry.name} from the process catalog.${tableNote}`);
    }
    return entry;
  }, [applySource, pushMessage]);

  const updateCell = useCallback((rowIndex: number, columnIndex: number, value: TruthCellValue) => {
    if (!truthTable) return;
    if (truthTableProtected) {
      warnProtectedTruthTable(activeProcessName ?? 'this process', 'Cell edits are disabled for protected bundled truth tables.');
      commitTruthTable(activeProcessName, truthTable, 'Cell edits are disabled for protected bundled truth tables.');
      return;
    }
    const nextRows = truthTable.rows.map((row, index) => (
      index === rowIndex ? row.map((cell, cellIndex) => (cellIndex === columnIndex ? value : cell)) : row
    ));
    commitTruthTable(activeProcessName, { ...truthTable, rows: nextRows });
    setLastTestResult(null);
  }, [truthTable, truthTableProtected, activeProcessName, commitTruthTable]);

  const updateInputCount = (count: number) => {
    if (!truthTable) return;
    if (truthTableProtected) {
      warnProtectedTruthTable(activeProcessName ?? 'this process', 'Truth-table dimensions cannot be changed for protected bundled processes.');
      return;
    }
    const inputColumns = nextColumnNames('A', count, truthTable.inputColumns);
    const nextTable = resizeTruthTable(truthTable, inputColumns, truthTable.outputColumns);
    setTruthTable(nextTable);
    setSource((current) => syncProtocolToTruthTable(current, inputColumns, nextTable.outputColumns));
    setLastTestResult(null);
  };

  const updateOutputCount = (count: number) => {
    if (!truthTable) return;
    if (truthTableProtected) {
      warnProtectedTruthTable(activeProcessName ?? 'this process', 'Truth-table dimensions cannot be changed for protected bundled processes.');
      return;
    }
    const outputColumns = nextColumnNames('Y', count, truthTable.outputColumns);
    const nextTable = resizeTruthTable(truthTable, truthTable.inputColumns, outputColumns);
    setTruthTable(nextTable);
    setSource((current) => syncProtocolToTruthTable(current, nextTable.inputColumns, outputColumns));
    setLastTestResult(null);
  };

  // Upload pairing: .qpucir drives protocol registration; companion .qpuio loads or updates the truth table.
  const ingestUploadedFiles = async (input: FileList | File[]) => {
    const fileList = Array.from(input);
    fileList.forEach((file) => validateUploadFileName(file.name));
    const qpucirFiles = fileList.filter((file) => isQpucirFileName(file.name)
      || (isLooseQpucirUpload(file.name) && !isQpuioFileName(file.name) && !file.name.endsWith('.json')));
    const qpuioFiles = fileList.filter((file) => isQpuioFileName(file.name));
    const qpuioByCompanion = new Map(
      qpuioFiles.map((file) => [companionQpucirFileName(file.name), file]),
    );

    if (qpucirFiles.length === 0 && qpuioFiles.length === 1) {
      const file = qpuioFiles[0];
      const contents = await file.text();
      const fileStemEntry = resolveCatalogEntry(processStemFromQpuioFileName(file.name));
      const parsed = parseQpuioPayload(contents, fileStemEntry?.source);
      if (fileStemEntry && fileStemEntry.name !== parsed.processName) {
        throw new Error(
          `QPUIO process '${parsed.processName}' does not match catalog entry '${fileStemEntry.name}' for ${file.name}.`,
        );
      }
      const registration = registerCatalogTruthTable({
        processName: parsed.processName,
        truthTable: parsed.truthTable,
        truthTableFileName: file.name,
        protocolSource: fileStemEntry?.source ?? getCatalogEntry(parsed.processName)?.source,
      });
      refreshCatalog();
      if (registration.reverted) {
        warnProtectedTruthTable(parsed.processName, `Uploaded ${file.name} cannot replace protected site metadata.`);
      }
      const entry = registration.entry;
      const resolvedTable = entry.truthTable ?? parsed.truthTable;
      setSelectedCatalogId(entry.id);
      applySource(entry.source, `Loaded truth table from ${file.name}.`, { truthTable: resolvedTable });
      pushMessage('assistant', registration.reverted
        ? `Ignored edits from ${file.name}; ${parsed.processName} uses the protected bundled truth table.`
        : `Loaded ${file.name} for ${parsed.processName}. Pair with a matching .qpucir file if the protocol is not already in the catalog.`);
      return;
    }

    if (qpucirFiles.length === 0) {
      throw new Error('Upload at least one .qpucir or -qpucir.txt file, or a standalone .qpuio/-qpuio.txt paired with a cataloged process.');
    }

    const primary = qpucirFiles[0];
    const contents = await primary.text();
    const parsed = parseQpucirPayload(contents);
    const companion = qpuioByCompanion.get(primary.name)
      ?? qpuioFiles.find((file) => file.name === companionQpuioFileName(primary.name));
    let bundledTable: TruthTable | undefined;
    let truthTableFileName: string | undefined;
    if (companion) {
      const qpuioContents = await companion.text();
      const qpuioParsed = parseQpuioPayload(qpuioContents, parsed.source);
      if (qpuioParsed.processName !== parsed.name) {
        throw new Error(
          `QPUIO process '${qpuioParsed.processName}' does not match .qpucir process '${parsed.name}'.`,
        );
      }
      bundledTable = qpuioParsed.truthTable;
      truthTableFileName = companion.name;
    }

    if (companion && isProtectedQpuioProcess(parsed.name)) {
      warnProtectedTruthTable(parsed.name, `Uploaded ${companion.name} cannot replace protected site metadata.`);
    }

    const registration = registerCatalogProcess({
      name: parsed.name,
      source: parsed.source,
      origin: 'uploaded',
      fileName: primary.name,
      truthTable: bundledTable,
      truthTableFileName,
      description: `Uploaded from ${primary.name}${companion ? ` + ${companion.name}` : ''}`,
    });
    refreshCatalog();
    setSelectedCatalogId('');
    applySource(parsed.source, `Loaded ${primary.name}.`, { truthTable: registration.truthTable });
    const tableNote = registration.truthTable
      ? ` Truth table loaded${companion && isProtectedQpuioProcess(parsed.name) ? ' (protected default restored)' : ` from ${truthTableFileName}`}.`
      : ' Say "infer truth table" or upload a companion .qpuio to continue.';
    pushMessage('assistant', `Loaded ${primary.name} into the catalog.${tableNote}`);
  };

  const uploadQpucir = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    try {
      await ingestUploadedFiles(files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Upload error: ${message}`);
      pushMessage('assistant', `Upload failed: ${message}`);
    } finally {
      event.target.value = '';
    }
  };

  const uploadQpuio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await ingestUploadedFiles([file]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Upload error: ${message}`);
      pushMessage('assistant', `Upload failed: ${message}`);
    } finally {
      event.target.value = '';
    }
  };

  const persistActiveArtifacts = useCallback((
    workflowSource: string,
    table: TruthTable,
    options?: {
      updateQpuio?: boolean;
      updateQpucir?: boolean;
      origin?: ProcessCatalogOrigin;
      description?: string;
    },
  ) => {
    const processName = extractMainProcessName(workflowSource);
    if (!processName) return null;
    const result = persistCatalogArtifacts({
      processName,
      source: workflowSource,
      truthTable: table,
      updateQpuio: options?.updateQpuio,
      updateQpucir: options?.updateQpucir,
      origin: options?.origin,
      description: options?.description,
    });
    if (!result.skipped) {
      refreshCatalog();
    }
    return result;
  }, [refreshCatalog]);

  const inferTable = useCallback((inferSource = source) => {
    const processName = extractMainProcessName(inferSource);
    if (isProtectedQpuioProcess(processName)) {
      const protectedTable = getCatalogTruthTable(processName ?? '') ?? createEmptyTruthTable(inferSource);
      commitTruthTable(processName, protectedTable, 'Infer is disabled for protected bundled truth tables.');
      setLastTestResult(null);
      setStatus(`Using protected truth table for ${processName}.`);
      return protectedTable;
    }
    const table = createEmptyTruthTable(inferSource);
    commitTruthTable(processName, table);
    setLastTestResult(null);
    const inferredDimensions = describeTruthTableDimensions(inferSource, table);
    setStatus(`Inferred ${formatTruthTableRowSummary(inferredDimensions)} × ${inferredDimensions.columnCount} columns.`);
    return table;
  }, [source, commitTruthTable]);

  const runTestOnly = useCallback((table: TruthTable, testSource = source) => {
    const testResult = testCircuitAgainstTruthTable(testSource, table, librarySources);
    setLastTestResult(testResult);
    let summary = formatTestFailureSummary(testResult);
    setStatus(summary);
    return { testResult, summary, persist: null };
  }, [source, librarySources]);

  const runCorrection = useCallback((
    table: TruthTable,
    guidance: CorrectionGuidance,
    autonomous: boolean,
    testSource = source,
  ) => {
    const response = runModuleTest({
      source: testSource,
      truthTable: table,
      librarySources,
      guidance,
      autonomous,
      correct: true,
      propagateToChildren: true,
      processName: extractMainProcessName(testSource) ?? activeProcessName ?? undefined,
      getTruthTable: getCatalogTruthTable,
    });

    const nextLibrary = response.librarySources ?? librarySources;
    response.childCorrections?.forEach((child) => {
      if (!child.corrected) return;
      registerCatalogProcess({
        name: child.processName,
        source: child.source,
        origin: 'corrected',
        truthTable: getCatalogTruthTable(child.processName),
        description: `Child process corrected for compatibility (${autonomous ? 'autonomous' : 'guided'})`,
      });
    });

    const finalSource = response.correctedSource ?? testSource;
    const processName = extractMainProcessName(testSource) ?? activeProcessName ?? undefined;
    if (response.correctedSource) {
      setSource(response.correctedSource);
    }
    commitTruthTable(processName, table);

    const persist = response.correctedSource
      ? persistActiveArtifacts(finalSource, table, {
        updateQpuio: false,
        updateQpucir: true,
        origin: 'corrected',
        description: `Corrected in Circuit Correction Lab (${autonomous ? 'autonomous' : 'guided'})`,
      })
      : null;

    if (response.childCorrections?.some((child) => child.corrected)) {
      refreshCatalog();
    }

    setLastTestResult(response.testResult);
    let summary = formatTestFailureSummary(response.testResult);
    const correctedChildren = response.childCorrections?.filter((child) => child.corrected) ?? [];
    if (correctedChildren.length > 0) {
      summary += ` Also corrected child process(es): ${correctedChildren.map((child) => child.processName).join(', ')}.`;
    }
    if (persist && !persist.skipped) {
      summary += ` ${persist.message}`;
    }
    setStatus(summary);
    return { response, summary, persist };
  }, [source, librarySources, activeProcessName, refreshCatalog, persistActiveArtifacts, commitTruthTable]);

  // Every parsed intent flows through this gate so protected truth tables are enforced before any correction is applied.
  const applyParsedIntent = async (intent: ModelCorrectionIntent) => {
    if (intent.clarification) {
      setPendingClarification(intent.clarification);
      pushMessage('assistant', intent.reply);
      return;
    }

    setPendingClarification(null);

    let currentSource = source;
    let table = truthTable;
    let guidance: CorrectionGuidance = {
      ...pendingGuidance,
      ...intent.guidance,
      preferredGates: intent.guidance?.preferredGates ?? pendingGuidance.preferredGates,
      gates: intent.guidance?.gates ?? pendingGuidance.gates,
    };

    if (intent.guidance?.preferredGates?.length) {
      setPendingGuidance((current) => ({ ...current, preferredGates: intent.guidance?.preferredGates }));
    }

    const hasFollowUpIntent = Boolean(
      intent.loadFullAdderTable
      || intent.inferTable
      || intent.truthTable
      || intent.probeOutputs
      || intent.runTest
      || intent.updateQpuio
      || intent.updateQpucir,
    );

    if (intent.loadCatalogProcess) {
      const entry = loadCatalogProcess(intent.loadCatalogProcess, { silent: hasFollowUpIntent });
      if (!entry) {
        pushMessage('assistant', `${intent.reply}\n\nI could not find "${intent.loadCatalogProcess}" in the catalog.`);
        return;
      }
      currentSource = entry.source;
      table = getCatalogTruthTable(entry.name) ?? (() => {
        try {
          return createEmptyTruthTable(entry.source);
        } catch {
          return createInitialTruthTable();
        }
      })();
      if (!hasFollowUpIntent) {
        return;
      }
    }

    const isCircuitCorrection = Boolean(
      intent.runTest && (intent.autonomous || (intent.guidance?.gates?.length ?? 0) > 0),
    );

    if (intent.loadFullAdderTable) {
      table = commitTruthTable('SingleBitFullAdder', singleBitFullAdderTruthTable());
      setLastTestResult(null);
    }

    if (intent.inferTable && !isCircuitCorrection) {
      table = inferTable(currentSource);
    }

    if (intent.truthTable && !isCircuitCorrection) {
      const processName = extractMainProcessName(currentSource) ?? activeProcessName;
      const enforced = enforceProtectedTruthTable(processName, intent.truthTable);
      if (enforced?.reverted) {
        warnProtectedTruthTable(processName ?? 'this process', 'Assistant-requested truth-table edits are blocked for protected bundled metadata.');
        pushMessage('assistant', `${intent.reply}\n\nThat truth-table edit is blocked because ${processName} is protected site metadata.`);
        table = enforced.truthTable;
      } else {
        table = intent.truthTable;
        setTruthTable(table);
      }
      setLastTestResult(null);
    }

    if (intent.probeOutputs && !isCircuitCorrection) {
      if (!table) {
        pushMessage('assistant', 'Infer or load a truth table before probing outputs.');
        return;
      }
      const processName = extractMainProcessName(currentSource) ?? activeProcessName;
      if (isProtectedQpuioProcess(processName)) {
        warnProtectedTruthTable(processName ?? 'this process', 'Probe outputs cannot overwrite protected bundled truth tables.');
        table = getCatalogTruthTable(processName ?? '') ?? table;
        setTruthTable(table);
      } else {
        table = probeModuleOutputs(currentSource, table, librarySources);
        setTruthTable(table);
      }
      setLastTestResult(null);
    }

    if (intent.updateQpuio || intent.updateQpucir) {
      if (!table) {
        pushMessage('assistant', 'Infer or load a truth table before saving catalog metadata.');
        return;
      }
      const persist = persistCatalogArtifacts({
        processName: extractMainProcessName(currentSource) ?? activeProcessName ?? 'UntitledCircuit',
        source: currentSource,
        truthTable: table,
        updateQpuio: intent.updateQpuio,
        updateQpucir: intent.updateQpucir,
      });
      if (!persist.skipped) {
        refreshCatalog();
      }
      if (!intent.runTest) {
        pushMessage('assistant', `${intent.reply}\n\n${persist.message}`);
        return;
      }
    }

    if (intent.runTest) {
      if (!table) {
        table = inferTable(currentSource);
      }
      try {
        if (intent.autonomous || intent.guidance?.gates?.length) {
          const { summary } = runCorrection(table, guidance, intent.autonomous ?? false, currentSource);
          pushMessage('assistant', `${intent.reply}\n\n${summary}`);
          if (intent.autonomous) setPendingGuidance({});
        } else {
          const { summary } = runTestOnly(table, currentSource);
          pushMessage('assistant', `${intent.reply}\n\n${summary}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushMessage('assistant', `${intent.reply}\n\nCould not complete that action: ${message}`);
      }
      return;
    }

    pushMessage('assistant', intent.reply);
  };

  // Clarification replies are resolved before invoking the parser again, avoiding a loop of ambiguous model prompts.
  const handleIntent = async (text: string) => {
    if (pendingClarification) {
      if (/^cancel$/i.test(text.trim())) {
        setPendingClarification(null);
        pushMessage('assistant', 'Cancelled. What would you like to do next?');
        return;
      }

      const selected = resolveClarificationResponse(text, pendingClarification);
      if (selected) {
        setPendingClarification(null);
        await handleIntent(selected.command);
        return;
      }

      const context = buildNlContext(truthTable, pendingClarification);
      if (useLlm) {
        const intent = await parseCorrectionIntent(text, context, {
          useLlm: true,
          llmSettings,
          onProgress: (progress) => setStatus(progress),
        });
        if (intent.clarification) {
          await applyParsedIntent(intent);
          return;
        }
        if (!intent.loadCatalogProcess && !intent.runTest && !intent.inferTable
          && !intent.probeOutputs && !intent.loadFullAdderTable && !intent.truthTable
          && !intent.updateQpuio && !intent.updateQpucir
          && !intent.guidance?.gates?.length) {
          pushMessage('assistant', formatClarificationRetry(pendingClarification));
          return;
        }
        setPendingClarification(null);
        await applyParsedIntent(intent);
        return;
      }

      pushMessage('assistant', formatClarificationRetry(pendingClarification));
      return;
    }

    const intent = await parseCorrectionIntent(text, buildNlContext(), {
      useLlm,
      llmSettings,
      onProgress: (progress) => setStatus(progress),
    });
    await applyParsedIntent(intent);
  };

  const submitChat = async (event: FormEvent) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    pushMessage('user', text);
    setChatInput('');
    setChatBusy(true);
    try {
      await handleIntent(text);
    } catch (err) {
      console.error('handleIntent failed', err);
      pushMessage('assistant', 'Sorry, something went wrong while processing your message.');
    } finally {
      setChatBusy(false);
    }
  };

  const runManualTest = (autonomous: boolean) => {
    if (!truthTable) {
      setStatus('Infer or load a truth table first.');
      return;
    }
    try {
      if (autonomous) {
        const { summary } = runCorrection(truthTable, pendingGuidance, true);
        pushMessage('assistant', `Autonomous correction finished.\n\n${summary}`);
        setPendingGuidance({});
      } else {
        const { summary } = runTestOnly(truthTable);
        pushMessage('assistant', `Test finished.\n\n${summary}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Test error: ${message}`);
    }
  };

  const downloadTruthTable = () => {
    if (!truthTable) return;
    const blob = new Blob([serializeTruthTableJson(truthTable)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'truth-table.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  const downloadQpuioTable = (asTxt = false) => {
    if (!truthTable || !activeProcessName) return;
    const fileName = asTxt
      ? qpuioTxtFileNameForProcess(activeProcessName)
      : qpuioFileNameForProcess(activeProcessName);
    downloadQpuioContents(fileName, serializeQpuioText(activeProcessName, truthTable));
    setStatus(`Downloaded ${fileName}.`);
  };

  const downloadCircuit = (asTxt = false) => {
    try {
      const fallbackName = activeProcessName ?? 'CorrectedCircuit';
      if (asTxt) {
        downloadQpucirTxtSource(source, fallbackName);
      } else {
        downloadQpucirSource(source, librarySources, fallbackName);
      }
      setStatus(`Downloaded corrected circuit as ${asTxt ? 'tagged .txt' : '.qpucir'}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Download error: ${message}`);
    }
  };

  const allColumns = truthTable ? [...truthTable.inputColumns, ...truthTable.outputColumns] : [];
  const allRowsPass = Boolean(lastTestResult?.passed);
  const webGpuAvailable = hasWebGpu();

  const updateLlmSettings = (patch: Partial<LlmSettings>) => {
    setLlmSettings((current) => {
      const next = { ...current, ...patch };
      saveLlmSettings(next);
      return next;
    });
    if (patch.browserModel) {
      setModelReady(getCachedBrowserModelId() === patch.browserModel);
    }
  };

  // Browser model downloads are explicit: the regex parser stays available while WebLLM assets are cached or cleared.
  const loadBrowserModel = async () => {
    if (!webGpuAvailable) {
      setStatus('WebGPU is not available in this browser. Use Ollama mode or a WebGPU-capable browser.');
      return;
    }
    setModelLoading(true);
    try {
      const { preloadBrowserModel } = await import('../simulator/llm/webLlmNaturalLanguageCorrector');
      const ok = await preloadBrowserModel(llmSettings.browserModel, (progress) => setStatus(progress));
      setModelReady(ok);
      setStatus(ok
        ? `Browser model cached. Future AI messages will not re-download it.`
        : 'Could not load the browser model.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Model load error: ${message}`);
      setModelReady(false);
    } finally {
      setModelLoading(false);
    }
  };

  const handleClearBrowserModel = async () => {
    setCacheClearing(true);
    try {
      const { clearBrowserModel } = await import('../simulator/llm/webLlmNaturalLanguageCorrector');
      await clearBrowserModel(llmSettings.browserModel, (progress) => setStatus(progress));
      setModelReady(false);
      setStatus(`Cleared browser cache for ${llmSettings.browserModel}. Download again before using AI mode.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelReady(false);
      setStatus(`Cache clear error: ${message}`);
    } finally {
      setCacheClearing(false);
    }
  };

  // Left column: protocol/table workspace. Right column: regex-first chat with optional browser/Ollama parser.
  return (
    <div className="module-lab-shell">
      <header className="module-lab-hero panel">
        <div>
          <p className="eyebrow">Circuit correction lab</p>
          <h1>Test modules and fix circuits with natural language.</h1>
          <p>Choose a cataloged process or upload a .qpucir file (optionally with a companion .qpuio truth table). Tagged -qpucir.txt and -qpuio.txt names are also accepted when a device file picker cannot see custom extensions.</p>
        </div>
      </header>

      <div className="module-lab-layout">
        <section className="module-lab-workspace panel" aria-labelledby="module-lab-workspace-title">
          <div className="section-heading">
            <p className="eyebrow">Module workspace</p>
            <h2 id="module-lab-workspace-title">Protocol and truth table</h2>
          </div>

          <div className="module-tester-grid">
            <label className="upload-card">
              <strong>Upload protocol</strong>
              <span>.qpucir (preferred) or -qpucir.txt; select a matching .qpuio or -qpuio.txt in the same dialog to load its truth table.</span>
              <input accept={QPU_FILE_UPLOAD_ACCEPT} multiple onChange={uploadQpucir} type="file" />
            </label>

            <label className="upload-card">
              <strong>Upload truth table</strong>
              <span>.qpuio (preferred) or -qpuio.txt metadata for a cataloged or paired process.</span>
              <input accept=".qpuio,.txt,text/plain" onChange={uploadQpuio} type="file" />
            </label>

            <label className="upload-card">
              <strong>Catalog process</strong>
              <span>Recently compiled, uploaded, and bundled processes.</span>
              <select
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedCatalogId(value);
                  if (value) {
                    const entry = catalogEntries.find((candidate) => candidate.id === value);
                    if (entry) loadCatalogProcess(entry.name);
                  }
                }}
                value={selectedCatalogId}
              >
                <option value="">Select a cataloged process…</option>
                {catalogEntries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} ({entry.origin})
                  </option>
                ))}
              </select>
            </label>

            <div className="module-tester-actions">
              <button onClick={() => { inferTable(); pushMessage('assistant', 'Inferred truth-table dimensions from PARAMS and RETURNVALS.'); }} type="button">Infer truth table</button>
              <button onClick={() => { commitTruthTable('SingleBitFullAdder', singleBitFullAdderTruthTable()); setLastTestResult(null); pushMessage('assistant', 'Loaded canonical full-adder truth table.'); }} type="button">Full-adder table</button>
              <button
                disabled={!truthTable}
                onClick={() => {
                  if (!truthTable) return;
                  if (truthTableProtected) {
                    warnProtectedTruthTable(activeProcessName ?? 'this process', 'Probe outputs cannot overwrite protected bundled truth tables.');
                    return;
                  }
                  setTruthTable(probeModuleOutputs(source, truthTable, librarySources));
                  setLastTestResult(null);
                  setStatus('Probed outputs from the current circuit. Run test to validate the table.');
                }}
                type="button"
              >
                Probe outputs
              </button>
              <button disabled={!truthTable} onClick={downloadTruthTable} type="button">Download JSON</button>
              <button disabled={!truthTable || !activeProcessName} onClick={() => downloadQpuioTable(false)} type="button">Download .qpuio</button>
              <button disabled={!truthTable || !activeProcessName} onClick={() => downloadQpuioTable(true)} type="button">Download -qpuio.txt</button>
              <button disabled={!source.trim()} onClick={() => downloadCircuit(false)} type="button">Download .qpucir</button>
              <button disabled={!source.trim()} onClick={() => downloadCircuit(true)} type="button">Download -qpucir.txt</button>
            </div>
          </div>

          <div className="truth-table-dimensions">
            <label>
              Input columns
              <input
                disabled={truthTableProtected}
                max={MAX_INPUT_COUNT}
                min={0}
                onChange={(event) => updateInputCount(Number(event.target.value))}
                type="number"
                value={truthTable?.inputColumns.length ?? 0}
              />
            </label>
            <label>
              Output columns
              <input
                disabled={truthTableProtected}
                max={MAX_OUTPUT_COUNT}
                min={1}
                onChange={(event) => updateOutputCount(Number(event.target.value))}
                type="number"
                value={truthTable?.outputColumns.length ?? 0}
              />
            </label>
          </div>

          {dimensions && (
            <p className="canvas-tip">
              Table size: {formatTruthTableRowSummary(dimensions)} × {dimensions.columnCount} columns.
              {dimensions.isPartial ? ' Only listed rows are tested and corrected.' : ''}
              {activeProcessName ? ` Active process: ${activeProcessName}.` : ''}
              {truthTableProtected ? ' Protected bundled truth table (edits are reverted).' : ''}
            </p>
          )}

          <textarea
            aria-label="Module protocol source"
            className="module-source-editor"
            onChange={(event) => {
              setSource(event.target.value);
              setLastTestResult(null);
            }}
            spellCheck={false}
            value={source}
          />

          {truthTable && (
            <div className="truth-table-editor-wrap">
              <table className="truth-table-editor">
                <thead>
                  <tr>
                    <th>#</th>
                    {allColumns.map((column, index) => (
                      <th key={column} className={index < truthTable.inputColumns.length ? 'input-col' : 'output-col'}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {truthTable.rows.map((row, rowIndex) => (
                    <TruthTableRow
                      failed={failedRowIndexes.has(rowIndex)}
                      key={rowIndex}
                      onCellChange={updateCell}
                      passed={allRowsPass}
                      readOnly={truthTableProtected}
                      row={row}
                      rowIndex={rowIndex}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="module-tester-actions">
            <button disabled={!truthTable} onClick={() => runManualTest(false)} type="button">Test circuit</button>
            <button disabled={!truthTable} onClick={() => runManualTest(true)} type="button">Test automatically</button>
          </div>

          <p className="file-status">{displayStatus}</p>
        </section>

        <section className="module-lab-chat panel" aria-labelledby="module-lab-chat-title">
          <div className="section-heading">
            <p className="eyebrow">Correction chat</p>
            <h2 id="module-lab-chat-title">Natural language assistant</h2>
          </div>

          <details className="llm-settings">
            <summary>AI model settings</summary>
            <fieldset className="llm-mode-fieldset">
              <legend>Parser backend</legend>
              <label>
                <input
                  checked={llmSettings.mode === 'browser'}
                  name="llm-mode"
                  onChange={() => updateLlmSettings({ mode: 'browser' })}
                  type="radio"
                />
                Browser model (downloads once, cached locally)
              </label>
              <label>
                <input
                  checked={llmSettings.mode === 'ollama'}
                  name="llm-mode"
                  onChange={() => updateLlmSettings({ mode: 'ollama' })}
                  type="radio"
                />
                Ollama (external server)
              </label>
            </fieldset>

            {llmSettings.mode === 'browser' ? (
              <>
                <p className="canvas-tip">
                  {webGpuAvailable
                    ? 'The model downloads on first use and stays cached in your browser. Queries after that reuse it — nothing is re-uploaded per message.'
                    : 'WebGPU is unavailable here. Switch to Ollama or use Chrome/Edge with GPU acceleration.'}
                </p>
                <label>
                  Browser model
                  <select
                    onChange={(event) => updateLlmSettings({ browserModel: event.target.value })}
                    value={llmSettings.browserModel}
                  >
                    {BROWSER_MODEL_OPTIONS.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </label>
                <div className="module-tester-actions">
                  <button disabled={!webGpuAvailable || modelLoading || cacheClearing} onClick={loadBrowserModel} type="button">
                    {modelLoading ? 'Downloading model…' : modelReady ? 'Model cached' : 'Download & cache model'}
                  </button>
                  <button disabled={modelLoading || cacheClearing} onClick={handleClearBrowserModel} type="button">
                    {cacheClearing ? 'Clearing cache…' : 'Clear Cache for Model'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="canvas-tip">Run Ollama locally, e.g. <code>ollama pull llama3.2:1b</code>.</p>
                <label>
                  API URL
                  <input
                    onChange={(event) => updateLlmSettings({ ollamaUrl: event.target.value })}
                    placeholder="http://localhost:11434/api/generate"
                    spellCheck={false}
                    type="url"
                    value={llmSettings.ollamaUrl}
                  />
                </label>
                <label>
                  Model name
                  <input
                    onChange={(event) => updateLlmSettings({ ollamaModel: event.target.value })}
                    placeholder="llama3.2:1b"
                    spellCheck={false}
                    type="text"
                    value={llmSettings.ollamaModel}
                  />
                </label>
              </>
            )}
          </details>

          <label className="chat-mode-toggle">
            <input
              checked={useLlm}
              onChange={(event) => {
                setUseLlm(event.target.checked);
                if (event.target.checked && llmSettings.mode === 'browser' && webGpuAvailable && !modelReady) {
                  void loadBrowserModel();
                }
              }}
              type="checkbox"
            />
            <span>Use AI for unrecognized messages (regex handles common commands instantly)</span>
          </label>

          <div className="chat-log" aria-live="polite">
            {messages.map((message) => (
              <article className={`chat-bubble ${message.role}`} key={message.id}>
                <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
                <p>{message.text}</p>
              </article>
            ))}
          </div>

          <form className="chat-composer" onSubmit={submitChat}>
            <label className="sr-only" htmlFor="correction-chat-input">Describe a correction</label>
            <textarea
              id="correction-chat-input"
              onChange={(event) => setChatInput(event.target.value)}
              placeholder='e.g. "Open IMPLIES", "test the circuit", or "fix the circuit automatically"'
              rows={3}
              value={chatInput}
            />
            <button disabled={chatBusy} type="submit">{chatBusy ? 'Parsing…' : 'Send correction'}</button>
          </form>
        </section>
      </div>
    </div>
  );
};
