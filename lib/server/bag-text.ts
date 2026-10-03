// Bounds for creator-supplied Bag text. Rendered as plain text by React (no
// HTML), so this is about sane sizes and types, not escaping.

export const BAG_TEXT_LIMITS = { name: 80, description: 1000, thesis: 4000 } as const;

/** Returns a human-readable problem, or null when every provided field is fine. Absent (undefined) fields are allowed. */
export function validateBagText(fields: { name?: unknown; description?: unknown; thesis?: unknown }): string | null {
  for (const key of ['name', 'description', 'thesis'] as const) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${key} must be text.`;
    if (key === 'name' && value.trim().length === 0) return 'name cannot be empty.';
    if (value.length > BAG_TEXT_LIMITS[key]) return `${key} can be at most ${BAG_TEXT_LIMITS[key]} characters.`;
  }
  return null;
}
