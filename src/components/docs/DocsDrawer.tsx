/**
 * Side drawer that shows beginner documentation for whatever `[data-doc]`
 * element the pointer rests on (or keyboard focus reaches). Child processes
 * and pinned entries open as drawer tabs rather than browser tabs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveDocEntry, type DocEntry } from '../../data/learning/docEntries';
import { docHref } from '../../data/learning/learningHelp';

// Hover intent: the pointer must rest this long, so crossing other items on the way to the drawer keeps the current entry.
const HOVER_INTENT_MS = 220;

type Hovered = { key: string; note?: string };

type DocsDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** Bumped when custom gates change so their entries are rebuilt. */
  registryVersion: number;
};

const tabLabel = (key: string) => key.slice(key.indexOf(':') + 1);

const MAX_TABLE_ROWS = 64;

function DocTableView({ table }: { table: NonNullable<DocEntry['table']> }) {
  const rows = table.rows.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="docs-table-wrap">
      <table className="docs-table">
        <thead>
          <tr>
            {table.columns.map((column, index) => (
              <th className={index === table.inputCount ? 'docs-output-start' : undefined} key={`${column}-${index}`} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td className={index === table.inputCount ? 'docs-output-start' : undefined} key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > rows.length ? (
        <small>Showing the first {rows.length} of {table.rows.length} rows. The Circuit correction lab shows them all.</small>
      ) : null}
      {table.note ? <small>{table.note}</small> : null}
    </div>
  );
}

function DocEntryView({ entry, note, onOpenProcess }: { entry: DocEntry; note?: string; onOpenProcess: (name: string) => void }) {
  const isProcess = entry.kind === 'custom' || entry.kind === 'process';
  return (
    <article className="docs-entry">
      <p className="eyebrow">{entry.subtitle}</p>
      <h3>{entry.title}</h3>
      <p>{entry.summary}</p>
      {entry.rule ? <code className="docs-rule">{entry.rule}</code> : null}
      {note ? (
        <section>
          <h4>On this diagram</h4>
          <p>{note}</p>
        </section>
      ) : null}
      {entry.table ? (
        <section>
          <h4>Truth table</h4>
          <DocTableView table={entry.table} />
        </section>
      ) : isProcess ? (
        <section>
          <h4>Truth table</h4>
          <p>This process has too many inputs to list every row here. Use Infer table in the Circuit correction lab.</p>
        </section>
      ) : null}
      {entry.sections.map((section) => (
        <section key={section.heading}>
          <h4>{section.heading}</h4>
          <p>{section.body}</p>
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
          <ul className="docs-children">
            {entry.children.map((child) => (
              <li key={child}>
                <button onClick={() => onOpenProcess(child)} type="button">Open {child} in a drawer tab</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {entry.source ? (
        <details>
          <summary>Protocol source</summary>
          <pre className="docs-syntax">{entry.source.trim()}</pre>
        </details>
      ) : null}
      {entry.doc ? (
        <a className="doc-link" href={docHref(import.meta.env.BASE_URL, entry.doc)} rel="noreferrer" target="_blank">
          {entry.doc.label}
        </a>
      ) : null}
    </article>
  );
}

export function DocsDrawer({ open, onClose, registryVersion }: DocsDrawerProps) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string>('live');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return undefined;
    const pick = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null;
      window.clearTimeout(timer.current);
      if (!element || element.closest('.docs-drawer')) return;
      const source = element.closest<HTMLElement>('[data-doc]');
      if (!source?.dataset.doc) return;
      const next = { key: source.dataset.doc, note: source.dataset.docNote };
      const commit = () => {
        setHovered(next);
        setActive('live');
      };
      if (event.type === 'focusin') commit();
      else timer.current = window.setTimeout(commit, HOVER_INTENT_MS);
    };
    document.addEventListener('pointerover', pick);
    document.addEventListener('focusin', pick);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener('pointerover', pick);
      document.removeEventListener('focusin', pick);
    };
  }, [open]);

  const activeKey = active === 'live' ? hovered?.key : active;
  const entry = useMemo(
    () => (activeKey ? resolveDocEntry(activeKey) : undefined),
    // registryVersion re-resolves custom gate entries after register/remove.
    [activeKey, registryVersion],
  );

  if (!open) return null;

  const openTab = (key: string) => {
    setTabs((current) => (current.includes(key) ? current : [...current, key]));
    setActive(key);
  };
  const closeTab = (key: string) => {
    setTabs((current) => current.filter((tab) => tab !== key));
    if (active === key) setActive('live');
  };

  return (
    <aside aria-label="Documentation drawer" className="docs-drawer">
      <div className="docs-drawer-heading">
        <strong>Docs on hover</strong>
        <button aria-label="Turn off docs on hover" onClick={onClose} type="button">×</button>
      </div>
      <div className="docs-tabs" role="tablist">
        <button aria-selected={active === 'live'} className={active === 'live' ? 'active' : ''} onClick={() => setActive('live')} role="tab" type="button">
          Hovered
        </button>
        {tabs.map((key) => (
          <span className={`docs-tab ${active === key ? 'active' : ''}`} key={key}>
            <button aria-selected={active === key} onClick={() => setActive(key)} role="tab" type="button">{tabLabel(key)}</button>
            <button aria-label={`Close ${tabLabel(key)} tab`} onClick={() => closeTab(key)} type="button">×</button>
          </span>
        ))}
      </div>
      <div className="docs-drawer-body" role="tabpanel">
        {entry ? (
          <>
            {active === 'live' && !tabs.includes(entry.key) ? (
              <button className="docs-pin" onClick={() => openTab(entry.key)} type="button">Keep in a tab</button>
            ) : null}
            <DocEntryView
              entry={entry}
              note={active === 'live' ? hovered?.note : undefined}
              onOpenProcess={(name) => openTab(`process:${name}`)}
            />
          </>
        ) : activeKey ? (
          <p>No documentation is available for {tabLabel(activeKey)}. Child processes must be in the process catalog.</p>
        ) : (
          <p>Rest the pointer on a gate, a custom gate, a bundled protocol, or a builder control to read about it here.</p>
        )}
      </div>
    </aside>
  );
}
