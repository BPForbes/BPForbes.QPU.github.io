import type { ReactNode } from 'react';
import { DEFAULT_VISIBLE_BITS, groupByPowerOfTwo, type GroupNode } from './powerOfTwoGroups';

type GroupedListProps<T> = {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  itemKey: (item: T) => string;
  groupLabel?: (start: number, end: number) => string;
  className?: string;
  k?: number;
};

/** List that applies power-of-two grouping with nested, collapsed `<details>`. */
export function GroupedList<T>({ items, renderItem, itemKey, groupLabel, className, k = DEFAULT_VISIBLE_BITS }: GroupedListProps<T>) {
  const leaves = (start: number, end: number) => items.slice(start, end).map((item, offset) => (
    <li key={itemKey(item)}>{renderItem(item, start + offset)}</li>
  ));
  const label = groupLabel ?? ((start: number, end: number) => `Items ${start + 1}–${end}`);
  const renderNodes = (nodes: GroupNode[]) => nodes.map((node) => (
    <li key={`${node.start}-${node.end}`}>
      <details className="grouped-list-group">
        <summary>{label(node.start, node.end)} <small>{node.end - node.start}</small></summary>
        <ul className={className}>{node.children ? renderNodes(node.children) : leaves(node.start, node.end)}</ul>
      </details>
    </li>
  ));
  const groups = groupByPowerOfTwo(items.length, k);
  return <ul className={className}>{groups ? renderNodes(groups) : leaves(0, items.length)}</ul>;
}
