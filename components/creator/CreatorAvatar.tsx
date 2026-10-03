import { useState } from 'react';

/** Uploaded profile photo when there is one (and it loads); the emoji fallback otherwise. */
export function CreatorAvatar({ avatarUrl, fallback = '👤', size = 44 }: { avatarUrl?: string | null; fallback?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Supabase Storage public URL; host differs per project
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flex: '0 0 auto' }}
      />
    );
  }
  return (
    <span aria-hidden="true" style={{ fontSize: Math.round(size * 0.68), lineHeight: 1, flex: '0 0 auto' }}>
      {fallback}
    </span>
  );
}
