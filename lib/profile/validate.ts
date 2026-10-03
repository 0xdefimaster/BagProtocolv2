// Pure validation for the profile routes (app/api/profile/*). Mirrors the
// constraints in supabase/migrations/0039_user_profile.sql.

export const DISPLAY_NAME_MAX = 32;
export const AVATAR_MAX_BYTES = 1024 * 1024;

/** Trimmed name, or an error message. Letters/digits (any script), space, . _ - only. */
export function validateDisplayName(value: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'Display name must be text.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { ok: false, error: 'Display name cannot be empty.' };
  if (name.length > DISPLAY_NAME_MAX) return { ok: false, error: `Display name can be at most ${DISPLAY_NAME_MAX} characters.` };
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return { ok: false, error: 'Use letters, numbers, spaces, dots, dashes or underscores.' };
  return { ok: true, name };
}

export type AvatarImageType = { mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; ext: 'png' | 'jpg' | 'webp' | 'gif' };

/**
 * Identifies the image from its first bytes — never from the file name or
 * the browser-supplied MIME type — so an SVG/HTML file renamed to .png is
 * rejected rather than served from the public bucket.
 */
export function detectAvatarImageType(bytes: Uint8Array): AvatarImageType | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (starts([0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (starts([0x47, 0x49, 0x46, 0x38])) return { mime: 'image/gif', ext: 'gif' };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { mime: 'image/webp', ext: 'webp' };
  return null;
}
