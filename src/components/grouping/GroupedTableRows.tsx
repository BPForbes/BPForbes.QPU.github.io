import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_VISIBLE_BITS, groupByPowerOfTwo, type GroupNode } from './powerOfTwoGroups';

type GroupedTableRowsProps = {
  count: number;
  columnCount: number;
  renderRow: (index: number) => ReactNode;
  labelFor: (start: number, end: number) => string;
  /** Rows whose groups start expanded, such as highlighted or failing rows. */
  openIndexes?: ReadonlySet<number>;
  k?: number;
};

const range = (start: number, end: number) => Array.from({ length: end - start }, (_, offset) => start + offset);

/** `<tbody>` content that applies power-of-two grouping with collapsible group header rows. */
export function GroupedTableRows({ count, columnCount, renderRow, labelFor, openIndexes, k = DEFAULT_VISIBLE_BITS }: GroupedTableRowsProps) {
  const groups = useMemo(() => groupByPowerOfTwo(count, k), [count, k]);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());

  const rows = (start: number, end: number) => range(start, end).map((index) => <Fragment key={index}>{renderRow(index)}</Fragment>);
  if (!groups) return <>{rows(0, count)}</>;

  const containsOpen = (node: GroupNode) => range(node.start, node.end).some((index) => openIndexes?.has(index));

  const renderNodes = (nodes: GroupNode[]): ReactNode[] => nodes.flatMap((node) => {
    const id = `${node.start}-${node.end}`;
    const open = overrides.get(id) ?? containsOpen(node);
    const header = (
      <tr className="group-row" key={`group-${id}`}>
        <th colSpan={columnCount} scope="rowgroup">
          <button
            aria-expanded={open}
            onClick={() => setOverrides((current) => new Map(current).set(id, !open))}
            style={{ paddingLeft: `${0.5 + node.depth}rem` }}
            type="button"
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {labelFor(node.start, node.end)}
            <small>{node.end - node.start} rows</small>
          </button>
        </th>
      </tr>
    );
    if (!open) return [header];
    return [header, ...(node.children ? renderNodes(node.children) : rows(node.start, node.end))];
  });

  return <>{renderNodes(groups)}</>;
}
