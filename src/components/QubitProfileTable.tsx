import type { QubitPhysicsProfile } from '../simulator/physics';

// Per-qubit physical profiles for the inspector's physical run. A blank cell inherits the shared value,
// so a uniform device needs no per-qubit input. Form units: GHz, MHz, ns, mK; profiles use GHz, ns, K.

export type ProfileField = 'f01' | 'offsetMHz' | 't1' | 't2' | 'temperatureMK' | 'anharmonicityMHz';
export type ProfileValues = Record<ProfileField, string>;
export type ProfileOverrides = Record<number, Partial<ProfileValues>>;

const COLUMNS: { field: ProfileField; label: string }[] = [
  { field: 'f01', label: 'f₀₁ (GHz)' },
  { field: 'offsetMHz', label: 'Offset (MHz)' },
  { field: 't1', label: 'T1 (ns)' },
  { field: 't2', label: 'T2 (ns)' },
  { field: 'temperatureMK', label: 'Temp. (mK)' },
  { field: 'anharmonicityMHz', label: 'α/2π (MHz)' },
];

const optional = (value: string, scale = 1) => (value.trim() ? Number(value) * scale : undefined);

/** Profile from form values; each wire's non-blank overrides replace the shared values. */
export const buildProfile = (shared: ProfileValues, override: Partial<ProfileValues> = {}): QubitPhysicsProfile => {
  const value = (field: ProfileField) => (override[field]?.trim() ? override[field] as string : shared[field]);
  const offset = optional(value('offsetMHz'), 1 / 1000);
  const t1 = optional(value('t1'));
  const t2 = optional(value('t2'));
  const temperature = optional(value('temperatureMK'), 1 / 1000);
  const anharmonicity = optional(value('anharmonicityMHz'), 1 / 1000);
  return {
    transitionFrequency: Number(value('f01')),
    ...(offset ? { frequencyOffset: offset } : {}),
    ...(t1 !== undefined ? { t1 } : {}),
    ...(t2 !== undefined ? { t2 } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(anharmonicity !== undefined ? { anharmonicity } : {}),
  };
};

export const hasOverride = (override: Partial<ProfileValues> | undefined) =>
  Object.values(override ?? {}).some((value) => value?.trim());

type QubitProfileTableProps = {
  wires: { wire: number; label: string }[];
  shared: ProfileValues;
  overrides: ProfileOverrides;
  onChange: (wire: number, field: ProfileField, value: string) => void;
};

export function QubitProfileTable({ wires, shared, overrides, onChange }: QubitProfileTableProps) {
  return (
    <div className="physics-table-wrap">
      <table className="physics-table physics-profile-table">
        <thead>
          <tr>
            <th scope="col">Qubit</th>
            {COLUMNS.map(({ field, label }) => <th key={field} scope="col">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {wires.map(({ wire, label }) => (
            <tr key={wire}>
              <th scope="row">{label}</th>
              {COLUMNS.map(({ field, label: column }) => (
                <td key={field}>
                  <input
                    aria-label={`${label} ${column}`}
                    onChange={(event) => onChange(wire, field, event.target.value)}
                    placeholder={shared[field].trim() || '—'}
                    type="number"
                    value={overrides[wire]?.[field] ?? ''}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
