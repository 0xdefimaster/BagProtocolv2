import { describe, expect, it } from 'vitest';
import { detectAvatarImageType, validateDisplayName } from '../validate';

describe('validateDisplayName', () => {
  it('trims and collapses spaces', () => {
    expect(validateDisplayName('  Alper   Kaya ')).toEqual({ ok: true, name: 'Alper Kaya' });
  });

  it('accepts non-latin letters', () => {
    expect(validateDisplayName('Çağrı_ş')).toEqual({ ok: true, name: 'Çağrı_ş' });
  });

  it('rejects empty, too long and markup', () => {
    expect(validateDisplayName('   ').ok).toBe(false);
    expect(validateDisplayName('a'.repeat(33)).ok).toBe(false);
    expect(validateDisplayName('<script>').ok).toBe(false);
    expect(validateDisplayName(42).ok).toBe(false);
  });
});

describe('detectAvatarImageType', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);

  it('recognises PNG, JPEG, GIF and WebP by their bytes', () => {
    expect(detectAvatarImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.ext).toBe('png');
    expect(detectAvatarImageType(bytes(0xff, 0xd8, 0xff, 0xe0))?.ext).toBe('jpg');
    expect(detectAvatarImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))?.ext).toBe('gif');
    expect(detectAvatarImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))?.ext).toBe('webp');
  });

  it('rejects SVG/HTML even if named .png', () => {
    expect(detectAvatarImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectAvatarImageType(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
  });
});
