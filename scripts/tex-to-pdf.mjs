import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const qpuDocuments = [
  'QPU_Circuit_Docs',
  'QPU_Getting_Started',
  'QPU_Theory_Guide',
  'QPU_Language_Reference',
  'QPU_Examples_and_Troubleshooting',
];

const diagnosticLines = (output) => output
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => (
    /^! /.test(line)
    || /\.tex:\d+:/.test(line)
    || /(?:LaTeX|Package .+) Warning:/.test(line)
    || /Overfull \\[hv]box/.test(line)
  ));

const runPdfLatex = (texPath, outputDirectory, root) => {
  const result = spawnSync(
    'pdflatex',
    [
      '-interaction=nonstopmode',
      '-file-line-error',
      '-halt-on-error',
      `-output-directory=${outputDirectory}`,
      texPath,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_SOURCE_DATE: '1',
        SOURCE_DATE_EPOCH: '0',
      },
    },
  );

  if (result.error?.code === 'ENOENT') {
    throw new Error('pdflatex was not found. Install a TeX Live distribution before building QPU documentation.');
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const diagnostics = diagnosticLines(output);
  if (result.status !== 0) {
    const detail = diagnostics.length > 0
      ? diagnostics.join('\n')
      : output.trim().split('\n').slice(-12).join('\n');
    throw new Error(`TeX translation failed for ${basename(texPath)}:\n${detail}`);
  }
  return diagnostics.filter((line) => /Warning:|Overfull \\[hv]box/.test(line));
};

export const translateTexToPdf = ({
  documentName,
  check = false,
  root = repositoryRoot,
} = {}) => {
  if (!qpuDocuments.includes(documentName)) {
    throw new Error(`Unknown QPU document '${documentName}'. Choose: ${qpuDocuments.join(', ')}`);
  }

  const texPath = join(root, 'docs', `${documentName}.tex`);
  const publicPdf = join(root, 'public', `${documentName}.pdf`);
  if (!existsSync(texPath)) throw new Error(`Missing TeX entry point: ${texPath}`);

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'qpu-tex-'));
  try {
    const warnings = [
      ...runPdfLatex(texPath, temporaryDirectory, root),
      ...runPdfLatex(texPath, temporaryDirectory, root),
    ];
    const generatedPdf = join(temporaryDirectory, `${documentName}.pdf`);
    if (!existsSync(generatedPdf)) {
      throw new Error(`TeX translation completed without producing ${documentName}.pdf`);
    }

    if (check) {
      if (!existsSync(publicPdf)) throw new Error(`Missing generated PDF: ${publicPdf}`);
      const matches = readFileSync(generatedPdf).equals(readFileSync(publicPdf));
      if (!matches) {
        throw new Error(`${documentName}.pdf is stale. Run npm run docs:build and commit the result.`);
      }
    } else {
      copyFileSync(generatedPdf, publicPdf);
    }

    return {
      documentName,
      pdfPath: publicPdf,
      warnings: [...new Set(warnings)],
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

const parseArguments = (arguments_) => {
  const check = arguments_.includes('--check');
  const requested = arguments_.filter((argument) => argument !== '--check');
  const documentNames = requested.length > 0
    ? requested.map((argument) => argument.replace(/\.tex$|\.pdf$/g, ''))
    : qpuDocuments;
  return { check, documentNames };
};

const main = () => {
  const { check, documentNames } = parseArguments(process.argv.slice(2));
  let warningCount = 0;

  documentNames.forEach((documentName) => {
    const result = translateTexToPdf({ documentName, check });
    warningCount += result.warnings.length;
    console.log(`${check ? 'Checked' : 'Built'} ${basename(result.pdfPath)}`);
    result.warnings.forEach((warning) => console.warn(`  warning: ${warning}`));
  });

  if (warningCount > 0) {
    console.warn(`TeX translation completed with ${warningCount} warning(s).`);
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
