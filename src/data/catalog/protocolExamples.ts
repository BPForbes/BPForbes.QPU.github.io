/**
 * Bundled `.qpucir` process sources loaded into the catalog at startup.
 *
 * The browser imports these raw files through Vite so the examples used by the
 * UI, simulator, and downloads remain identical to the checked-in fixtures.
 */
import fourBitFullAdderQpucir from '../processes/four-bit-full-adder.qpucir?raw';
import fourBitFullAdderQpuio from '../processes/four-bit-full-adder.qpuio?raw';
import phaseDemoQpucir from '../processes/phase-demo.qpucir?raw';
import phaseDemoQpuio from '../processes/phase-demo.qpuio?raw';
import recursiveHQpucir from '../processes/recursive-h.qpucir?raw';
import recursiveHParentQpucir from '../processes/recursive-h-parent.qpucir?raw';
import recursiveReversibleEchoQpucir from '../processes/recursive-reversible-echo.qpucir?raw';
import recursiveReversibleEchoHarnessQpucir from '../processes/recursive-reversible-echo-harness.qpucir?raw';
import singleBitFullAdderQpuio from '../processes/single-bit-full-adder.qpuio?raw';
import singleBitFullAdderQpucir from '../processes/single-bit-full-adder.qpucir?raw';
import twoBitFullAdderQpucir from '../processes/two-bit-full-adder.qpucir?raw';
import twoBitFullAdderQpuio from '../processes/two-bit-full-adder.qpuio?raw';
import { parseQpuioPayload } from '../formats/qpuioFile';
import type { CircuitGate } from '../../simulator/types';
import { extractMainProcessName } from '../../simulator/compiler/qpuFormat';
import type { TruthTable } from '../../simulator/compiler/truthTable';

export type QpucirPayload = {
  format: 'qpucir';
  version: 1;
  name: string;
  source: string;
  compiled?: {
    qubitCount: number;
    gates: CircuitGate[];
    tokenMap: Record<string, number>;
  };
  exportedAt?: string;
};

export type ConfiguredQpucirProcess = {
  format: 'qpucir';
  version: 1;
  name: string;
  source: string;
  fileName: string;
  contents: string;
  truthTable?: TruthTable;
  truthTableFileName?: string;
  compiled?: QpucirPayload['compiled'];
  exportedAt?: string;
};

const parseConfiguredProcess = (
  fileName: string,
  contents: string,
  truthTableBundle?: { fileName: string; contents: string },
): ConfiguredQpucirProcess => {
  let payload: QpucirPayload;

  try {
    payload = JSON.parse(contents) as QpucirPayload;
  } catch {
    const name = extractMainProcessName(contents) ?? fileName.replace(/\.qpucir$/i, '');
    const truthTable = truthTableBundle
      ? parseQpuioPayload(truthTableBundle.contents, contents).truthTable
      : undefined;
    return {
      format: 'qpucir',
      version: 1,
      name,
      source: contents,
      fileName,
      contents,
      truthTable,
      truthTableFileName: truthTableBundle?.fileName,
    };
  }

  if (payload.format !== 'qpucir' || payload.version !== 1 || typeof payload.name !== 'string' || typeof payload.source !== 'string') {
    throw new Error(`${fileName} is not a valid .qpucir process file.`);
  }

  const truthTable = truthTableBundle
    ? parseQpuioPayload(truthTableBundle.contents, payload.source).truthTable
    : undefined;

  return {
    ...payload,
    fileName,
    contents: payload.source,
    truthTable,
    truthTableFileName: truthTableBundle?.fileName,
  };
};

const bundledQpuio = (fileName: string, contents: string) => ({ fileName, contents });

export const configuredProcesses = [
  parseConfiguredProcess('four-bit-full-adder.qpucir', fourBitFullAdderQpucir, bundledQpuio('four-bit-full-adder.qpuio', fourBitFullAdderQpuio)),
  parseConfiguredProcess('two-bit-full-adder.qpucir', twoBitFullAdderQpucir, bundledQpuio('two-bit-full-adder.qpuio', twoBitFullAdderQpuio)),
  parseConfiguredProcess('single-bit-full-adder.qpucir', singleBitFullAdderQpucir, bundledQpuio('single-bit-full-adder.qpuio', singleBitFullAdderQpuio)),
  parseConfiguredProcess('phase-demo.qpucir', phaseDemoQpucir, bundledQpuio('phase-demo.qpuio', phaseDemoQpuio)),
  parseConfiguredProcess('recursive-h.qpucir', recursiveHQpucir),
  parseConfiguredProcess('recursive-h-parent.qpucir', recursiveHParentQpucir),
  parseConfiguredProcess('recursive-reversible-echo.qpucir', recursiveReversibleEchoQpucir),
  parseConfiguredProcess('recursive-reversible-echo-harness.qpucir', recursiveReversibleEchoHarnessQpucir),
];

export const protocolLibrary = Object.fromEntries(
  configuredProcesses.map((process) => [process.name, process.source]),
) as Record<string, string>;

export const protocolExamples = configuredProcesses;
