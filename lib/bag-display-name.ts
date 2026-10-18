// "Name" for a Bag still on its first strategy, "Name v2", "Name v3", … once its creator has published new
// versions (Edit strategy). The stored name never changes; only this label does.
export function bagDisplayName(bag: { name: string; version?: number }): string {
  return typeof bag.version === 'number' && bag.version > 1 ? `${bag.name} v${bag.version}` : bag.name;
}
