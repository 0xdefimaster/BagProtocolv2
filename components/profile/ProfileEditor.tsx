'use client';

import { useRef, useState } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import { useWallet } from '@/lib/wallet-context';
import { CreatorAvatar } from '@/components/creator/CreatorAvatar';
import { DISPLAY_NAME_MAX } from '@/lib/profile/validate';

/**
 * Display name + profile photo for the signed-in wallet. Both are saved
 * server-side (app/api/profile*) and shown on every Bag this wallet creates.
 */
export function ProfileEditor() {
  const { authUser, updateAuthUser } = useWallet();
  const [name, setName] = useState(authUser?.displayName ?? '');
  const [saving, setSaving] = useState<'name' | 'photo' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!authUser) {
    return <p style={{ fontSize: 13, color: 'var(--mute)' }}>Connect your wallet and sign in to set a name and profile photo.</p>;
  }

  async function send(url: string, init: RequestInit, okText?: string) {
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      updateAuthUser({ displayName: data.profile.displayName, avatarUrl: data.profile.avatarUrl });
      if (okText) setMessage({ kind: 'ok', text: okText });
      return data.profile as { displayName: string | null };
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' });
      return null;
    } finally {
      setSaving(null);
    }
  }

  async function saveName() {
    setSaving('name');
    const profile = await send(
      '/api/profile',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name.trim() === '' ? null : name }) },
      'Name saved.'
    );
    if (profile) setName(profile.displayName ?? '');
  }

  async function uploadPhoto(file: File) {
    setSaving('photo');
    const form = new FormData();
    form.append('file', file);
    await send('/api/profile/avatar', { method: 'POST', body: form }, 'Photo updated.');
    if (fileRef.current) fileRef.current.value = '';
  }

  async function removePhoto() {
    setSaving('photo');
    await send('/api/profile/avatar', { method: 'DELETE' });
  }

  return (
    <div className="profile-editor">
      <div className="profile-editor-photo">
        <div className="profile-avatar">
          <CreatorAvatar avatarUrl={authUser.avatarUrl} size={72} />
        </div>
        <div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="follow-btn" disabled={saving !== null} onClick={() => fileRef.current?.click()}>
              {saving === 'photo' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              {authUser.avatarUrl ? 'Change photo' : 'Upload photo'}
            </button>
            {authUser.avatarUrl && (
              <button type="button" className="follow-btn" disabled={saving !== null} onClick={removePhoto}>
                <X size={13} /> Remove
              </button>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 6 }}>PNG, JPEG, WebP or GIF, up to 1 MB.</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadPhoto(file);
            }}
          />
        </div>
      </div>

      <div className="field" style={{ marginBottom: 0, marginTop: 18 }}>
        <label htmlFor="profile-display-name">Display name</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="profile-display-name"
            type="text"
            value={name}
            maxLength={DISPLAY_NAME_MAX}
            placeholder="Shown on your Bags instead of your wallet address"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="btn btn-primary" disabled={saving !== null || name === (authUser.displayName ?? '')} onClick={saveName}>
            {saving === 'name' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {message && (
        <p role="status" style={{ fontSize: 12.5, marginTop: 10, color: message.kind === 'ok' ? 'var(--emerald)' : '#E27D60' }}>
          {message.text}
        </p>
      )}
    </div>
  );
}
