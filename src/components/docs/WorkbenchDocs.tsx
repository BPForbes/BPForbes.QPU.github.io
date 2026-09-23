/**
 * Documentation card inside the Interactive workbench. The compact view
 * explains the gate or process on the wires currently being examined; Learn
 * more expands the full table, notes, syntax, and child processes in place.
 */
import { Fragment, useState, type ReactNode } from 'react';
import { catalogProcessDocEntry, type DocEntry, type DocTable } from '../../data/learning/docEntries';
import {
  columnWires,
  describeRow,
  matchingRows,
  rowStartStates,
  wireHeader,
  type ColumnWires,
  type WireValue,
} from '../../data/learning/docContext';
import { docHref } from '../../data/learning/learningHelp';
import type { ParticleStartState } from '../../simulator/types';
import { GroupedList } from '../grouping/GroupedList';
import { GroupedTableRows } from '../grouping/GroupedTableRows';
import { binaryPrefixLabel, groupThreshold } from '../grouping/powerOfTwoGroups';
import { SelectorMapDiagram } from '../gate';

/** Renders ⊕ at text weight; most UI fonts draw it far larger than the letters around it. */
export const mathText = (text: string): ReactNode => {
  const parts = text.split('⊕');
  return parts.length === 1 ? text : parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <span className="op-xor">⊕</span> : null}
      {part}
    </Fragment>
  ));
};

const isWire = (qubit: number | undefined): qubit is number => qubit !== undefined;
const wireName = (qubit: number) => `q${qubit}`;
const listWires = (qubits: number[]) => qubits.map(wireName).join(' and ');

type DocTableViewProps = {
  table: DocTable;
  wires: ColumnWires;
  rows: number[];
  highlighted?: ReadonlySet<number>;
  onTryRow?: (rowIndex: number) => void;
  grouped?: boolean;
};

function DocTableView({ table, wires, rows, highlighted, onTryRow, grouped = false }: DocTableViewProps) {
  const cellClass = (index: number) => (index === table.inputCount ? 'docs-output-start' : undefined);
  const renderRow = (position: number) => {
    const rowIndex = rows[position];
    return (
      <tr className={highlighted?.has(rowIndex) ? 'docs-row-match' : undefined}>
        {table.rows[rowIndex].map((cell, index) => <td className={cellClass(index)} key={index}>{mathText(cell)}</td>)}
        {onTryRow ? (
          <td className="docs-try">
            <button onClick={() => onTryRow(rowIndex)} title="Set the start states to this row's inputs" type="button">Try</button>
          </td>
        ) : null}
      </tr>
    );
  };
  const columnCount = table.columns.length + (onTryRow ? 1 : 0);
  const inputColumns = table.columns.slice(0, table.inputCount);
  const openPositions = new Set(rows.flatMap((rowIndex, position) => (highlighted?.has(rowIndex) ? [position] : [])));
  return (
    <div className="docs-table-wrap">
      <table className="docs-table">
        <thead>
          <tr>
            {table.columns.map((column, index) => (
              <th className={cellClass(index)} key={`${column}-${index}`} scope="col">{wireHeader(column, wires[index])}</th>
            ))}
            {onTryRow ? <th scope="col"><span className="sr-only">Try</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {grouped ? (
            <GroupedTableRows
              columnCount={columnCount}
              count={rows.length}
              labelFor={(start, end) => binaryPrefixLabel(inputColumns, (position) => table.rows[rows[position]].slice(0, table.inputCount), start, end)}
              openIndexes={openPositions}
              renderRow={renderRow}
            />
          ) : rows.map((_, position) => <Fragment key={position}>{renderRow(position)}</Fragment>)}
        </tbody>
      </table>
    </div>
  );
}

/** Full notes for a child process, resolved only once its disclosure is opened. */
function ChildProcessDocs({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const entry = open ? catalogProcessDocEntry(name) : undefined;
  return (
    <details className="docs-child" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{name}</summary>
      {open ? (entry ? <FullNotes entry={entry} /> : <p>{name} is not in the process catalog, so there are no notes for it.</p>) : null}
    </details>
  );
}

function FullNotes({ entry, children }: { entry: DocEntry; children?: ReactNode }) {
  const wires = entry.table ? entry.table.roles.map((roles) => roles.split(' ').map(() => undefined)) : [];
  return (
    <div className="docs-full">
      {children ?? (entry.table ? (
        <section>
          <h4>Truth table</h4>
          <DocTableView grouped rows={entry.table.rows.map((_, index) => index)} table={entry.table} wires={wires} />
          {entry.table.note ? <small>{entry.table.note}</small> : null}
        </section>
      ) : null)}
      {entry.sections.map((section) => (
        <section key={section.heading}>
          <h4>{section.heading}</h4>
          <p>{mathText(section.body)}</p>
        </section>
      ))}
      {entry.syntax ? (
        <section>
          <h4>How to write it</h4>
          <pre className="docs-syntax">{entry.syntax.join('\n')}</pre>
        </section>
      ) : null}
      {entry.children && entry.children.length > 0 ? (
        <section>
          <h4>Child processes</h4>
          <GroupedList
            className="docs-children"
            groupLabel={(start, end) => `${entry.children![start]} … ${entry.children![end - 1]}`}
            itemKey={(child) => child}
            items={entry.children}
            renderItem={(child) => <ChildProcessDocs name={child} />}
          />
        </section>
      ) : null}
      {entry.source ? (
        <details className="docs-source">
          <summary>Protocol source</summary>
          <pre className="docs-syntax">{entry.source.trim()}</pre>
        </details>
      ) : null}
      {entry.doc ? (
        <a className="doc-link" href={docHref(import.meta.env.BASE_URL, entry.doc)} rel="noreferrer" target="_blank">{entry.doc.label}</a>
      ) : null}
    </div>
  );
}

export type WorkbenchDocsProps = {
  entry: DocEntry;
  /** Short line naming what is being explained, e.g. "Selected gate" or "Step 2 of 5". */
  eyebrow: string;
  /**
   * Wires the entry is applied to: [A, B] and [t] for built-in gates (both
   * swapped wires for SWAP), or one wire per PARAMS / RETURNVALS name.
   */
  controls: (number | undefined)[];
  targets: (number | undefined)[];
  qubitCount: number;
  valueOf: (qubit: number) => WireValue | undefined;
  /** Where the wire values come from, or why none are shown. */
  valuesNote: string;
  /** Gate symbol for the diagram; omitted for processes, which the canvas already draws. */
  symbol?: string;
  reversible?: boolean;
  onTryRow?: (assignments: Map<number, ParticleStartState>) => void;
  action?: ReactNode;
};

export function WorkbenchDocs({
  entry,
  eyebrow,
  controls,
  targets,
  qubitCount,
  valueOf,
  valuesNote,
  symbol,
  reversible,
  onTryRow,
  action,
}: WorkbenchDocsProps) {
  const table = entry.table;
  const wires = table ? columnWires(entry, table, controls, targets) : [];
  const matches = table ? matchingRows(table, wires, valueOf) : [];
  const matchSet = new Set(matches);
  const swaps = entry.key === 'gate:SWAP';
  const reads = controls.filter(isWire);
  const changes = (swaps || entry.kind !== 'gate' ? targets : targets.slice(0, 1)).filter(isWire);
  const touched = [...reads, ...targets.filter(isWire)];
  const superposed = touched.filter((qubit) => valueOf(qubit) === 'sp');
  const tryRow = onTryRow && table ? (rowIndex: number) => onTryRow(rowStartStates(table, wires, rowIndex)) : undefined;
  const target = targets[0];

  return (
    <aside aria-label={`About ${entry.title}`} className="workbench-docs">
      <div className="workbench-docs-heading">
        <p className="eyebrow">{eyebrow}</p>
        {action}
      </div>
      <div className="gate-help-heading">
        <strong>{entry.title}</strong>
        {entry.rule ? <code>{mathText(entry.rule)}</code> : null}
        {reversible === false ? <span className="docs-badge">not reversible</span> : null}
      </div>
      <p>{mathText(entry.summary)}</p>
      {symbol !== undefined && target !== undefined ? (
        <SelectorMapDiagram
          controls={reads}
          qubitCount={Math.max(qubitCount, ...touched.map((qubit) => qubit + 1))}
          swapPartner={swaps ? targets[1] : undefined}
          symbol={symbol}
          target={target}
        />
      ) : null}
      <p className="gate-help-roles">
        Reads {reads.length > 0 ? listWires(reads) : 'no other wire'}; changes {changes.length > 0 ? listWires(changes) : 'no wire'}.
      </p>
      {table ? (
        <section className="docs-now" aria-label="Rows for the current wire values">
          <h4>On these wires now</h4>
          <small>{valuesNote}</small>
          {matches.length > 0 && matches.length <= groupThreshold() ? (
            <DocTableView rows={matches} table={table} wires={wires} />
          ) : null}
          <p>
            {matches.length === 1
              ? mathText(describeRow(table, wires, matches[0]))
              : superposed.length > 0
                ? `${listWires(superposed)} ${superposed.length === 1 ? 'is' : 'are'} in superposition, so ${matches.length} rows happen at once, each with its share of the amplitude.`
                : `${matches.length} rows match. Learn more lists them all.`}
          </p>
        </section>
      ) : null}
      <details className="docs-learn-more">
        <summary>Learn more</summary>
        <FullNotes entry={entry}>
          {table ? (
            <section>
              <h4>Truth table on these wires</h4>
              <DocTableView grouped highlighted={matchSet} onTryRow={tryRow} rows={table.rows.map((_, index) => index)} table={table} wires={wires} />
              {table.note ? <small>{table.note}</small> : null}
              {tryRow ? <small>Try sets the start states to that row&apos;s inputs and rewinds the circuit.</small> : null}
            </section>
          ) : entry.kind !== 'gate' ? (
            <section>
              <h4>Truth table</h4>
              <p>This process has too many inputs to list every row here. Use Infer table in the Circuit correction lab.</p>
            </section>
          ) : null}
        </FullNotes>
      </details>
    </aside>
  );
}
