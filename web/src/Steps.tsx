import type { StepState } from './progress';

interface Props {
  items: ReadonlyArray<{ label: string; state: StepState }>;
  /** True while Tiny is working on the current step right now. */
  active: boolean;
}

/** The numbered step list. Steps done are muted, the current one is marked, and pulses while Tiny is working on it. */
export function StepList({ items, active }: Props) {
  return (
    <ol className="steps">
      {items.map((item) => (
        <li key={item.label} className={item.state} aria-current={item.state === 'current' ? 'step' : undefined}>
          <span className={item.state === 'current' && active ? 'working' : undefined}>{item.label}</span>
          {item.state === 'done' && <span className="visually-hidden"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}
