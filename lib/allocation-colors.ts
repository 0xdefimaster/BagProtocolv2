// Allocation colours, in composition order: the donut and its legend use the same ones.
const ALLOCATION_COLORS = ['#D9B98B', '#00D084', '#7FA7E8', '#C98A5C', '#B49BE0', '#E8A0BF', '#6FD3C6', '#F2A65A'];
export function allocationColor(i: number): string {
  return ALLOCATION_COLORS[i % ALLOCATION_COLORS.length];
}
/** conic-gradient for the allocation donut; weights are percentages. */
export function allocationGradient(composition: { weight: number }[]): string {
  if (composition.length === 0) return 'var(--surface-2)';
  let at = 0;
  const stops = composition.map((pos, i) => {
    const from = at;
    at += pos.weight;
    return `${allocationColor(i)} ${from}% ${at}%`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}
