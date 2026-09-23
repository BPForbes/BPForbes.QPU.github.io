/**
 * Power-of-two grouping for long collections (tables, lists, logs).
 *
 * At most 2^K entries are visible at any one level. Up to 2^K items show
 * directly; beyond that, items go into collapsible groups of at most 2^K, and
 * groups are grouped again whenever there would be more than 2^K of them.
 * With K = 3: 1–8 direct, 9–64 one level, 65–512 two levels, 513–4096 three.
 */
export const DEFAULT_VISIBLE_BITS = 3;

export const groupThreshold = (k = DEFAULT_VISIBLE_BITS) => 2 ** k;

/** D = ceil(log2 N): bits needed to index N items. */
export const binaryDepth = (count: number) => (count <= 1 ? 0 : Math.ceil(Math.log2(count)));

/** L = max(0, ceil(log_{2^K} N) − 1), computed with integers to avoid float rounding at exact powers. */
export const groupingLevels = (count: number, k = DEFAULT_VISIBLE_BITS) => {
  const threshold = groupThreshold(k);
  let levels = 0;
  for (let span = threshold; span < count; span *= threshold) levels += 1;
  return levels;
};

export type GroupNode = {
  start: number;
  /** Exclusive. */
  end: number;
  depth: number;
  /** Undefined when the group's items are shown directly. */
  children?: GroupNode[];
};

const buildGroups = (start: number, end: number, depth: number, threshold: number): GroupNode[] => {
  const size = end - start;
  let span = 1;
  while (span * threshold < size) span *= threshold;
  const nodes: GroupNode[] = [];
  for (let groupStart = start; groupStart < end; groupStart += span) {
    const groupEnd = Math.min(end, groupStart + span);
    nodes.push({
      start: groupStart,
      end: groupEnd,
      depth,
      children: groupEnd - groupStart > threshold ? buildGroups(groupStart, groupEnd, depth + 1, threshold) : undefined,
    });
  }
  return nodes;
};

/** Top-level groups for `count` items, or undefined when every item fits at one level. */
export const groupByPowerOfTwo = (count: number, k = DEFAULT_VISIBLE_BITS): GroupNode[] | undefined => {
  const threshold = groupThreshold(k);
  return count <= threshold ? undefined : buildGroups(0, count, 0, threshold);
};

/**
 * For a complete, MSB-first truth table a group of 2^m rows shares its leading
 * input bits, so it can be named by them ("A0 A1 = 01") instead of row numbers.
 */
export const binaryPrefixLabel = (
  inputColumns: string[],
  inputsAt: (index: number) => string[],
  start: number,
  end: number,
) => {
  const size = end - start;
  const freeBits = Math.log2(size);
  const fixed = inputColumns.length - freeBits;
  const aligned = Number.isInteger(freeBits) && start % size === 0;
  const bits = inputsAt(start).slice(0, fixed);
  const shared = () => {
    for (let index = start + 1; index < end; index += 1) {
      if (inputsAt(index).slice(0, fixed).join() !== bits.join()) return false;
    }
    return true;
  };
  // Edited tables can be out of order, so every row must share the prefix before it names the group.
  if (!aligned || fixed <= 0 || !bits.every((bit) => bit === '0' || bit === '1') || !shared()) {
    return `Rows ${start + 1}–${end}`;
  }
  return `${inputColumns.slice(0, fixed).join(' ')} = ${bits.join('')}`;
};
