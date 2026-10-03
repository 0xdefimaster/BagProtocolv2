'use client';

import { useState } from 'react';
import { X as XIcon } from 'lucide-react';

interface ConnectXModalProps {
  onConfirm: (handle: string) => void;
  onClose: () => void;
}

export function ConnectXModal({ onConfirm, onClose }: ConnectXModalProps) {
  const [handle, setHandle] = useState('');

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      onClick={(e) => {
        stop(e);
        onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={stop}
        style={{
          background: 'var(--surface, #0D0D0D)',
          border: '1px solid var(--line, rgba(217,185,139,0.16))',
          borderRadius: 16,
          padding: 24,
          width: '100%',
          maxWidth: 360,
          color: 'var(--ink, #F6F3EC)',
          fontFamily: 'var(--font-inter), sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <XIcon size={16} /> Connect X
          </h3>
          <button
            onClick={(e) => {
              stop(e);
              onClose();
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-soft, #B4AEA2)' }}
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft, #B4AEA2)', marginBottom: 18, lineHeight: 1.6 }}>
          Link your X handle to your creator profile so followers can find you.
          This demo doesn&apos;t run real OAuth (that needs a backend + X API
          keys) — it just stores the handle you enter locally.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid var(--line-soft, rgba(255,255,255,0.08))',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 20,
          }}
        >
          <span style={{ color: 'var(--gold, #D9B98B)', fontWeight: 600 }}>@</span>
          <input
            type="text"
            placeholder="yourhandle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoFocus
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--ink, #F6F3EC)',
              fontSize: 15,
              width: '100%',
            }}
          />
        </div>

        <button
          disabled={handle.trim() === ''}
          onClick={(e) => {
            stop(e);
            onConfirm(handle);
          }}
          style={{
            width: '100%',
            padding: '12px',
            borderRadius: 10,
            border: 'none',
            fontWeight: 600,
            fontSize: 14,
            cursor: handle.trim() ? 'pointer' : 'not-allowed',
            opacity: handle.trim() ? 1 : 0.5,
            background: 'linear-gradient(155deg, var(--gold-lt, #F0DFC0), var(--gold, #D9B98B) 55%, var(--gold-dk, #9C7B49))',
            color: '#0A0805',
          }}
        >
          Connect Account
        </button>
      </div>
    </div>
  );
}
