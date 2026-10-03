import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { AVATAR_MAX_BYTES, detectAvatarImageType } from '@/lib/profile/validate';
import { getUserProfile, updateUserProfile } from '@/lib/server/user-profile-repo';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const UPLOAD_RATE_LIMIT = { windowSeconds: 3600, maxRequests: 10 };

/** Storage path of a previously uploaded avatar, if `url` points into our own bucket for this user. */
function ownAvatarPath(url: string | null, userId: string): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const path = decodeURIComponent(url.slice(at + marker.length));
  return path.startsWith(`${userId}/`) ? path : null;
}

// Profile photo for the signed-in user.
//
//   POST   /api/profile/avatar  multipart form field "file" (PNG/JPEG/WebP/GIF, <= 1 MB)
//   DELETE /api/profile/avatar  removes the photo from the profile
//
// Uploaded server-side with the service role into the public `avatars`
// bucket (0039_user_profile.sql) under the user's own id; the type is taken
// from the file's bytes, never from its name or the browser's MIME claim.

const BUCKET = 'avatars';

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const limit = await checkRateLimit(supabaseAdmin(), `avatar-upload:${auth.session.userId}`, UPLOAD_RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Attach an image in the "file" field.' }, { status: 400 });
  if (file.size > AVATAR_MAX_BYTES) return NextResponse.json({ error: 'Image must be 1 MB or smaller.' }, { status: 413 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectAvatarImageType(bytes);
  if (!type) return NextResponse.json({ error: 'Use a PNG, JPEG, WebP or GIF image.' }, { status: 415 });

  const admin = supabaseAdmin();
  const previous = await getUserProfile(admin, auth.session.userId).catch(() => null);
  const path = `${auth.session.userId}/${Date.now()}.${type.ext}`;
  const upload = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: type.mime, upsert: false });
  if (upload.error) {
    return NextResponse.json(
      { error: `Upload failed: ${upload.error.message}. Has supabase/migrations/0039_user_profile.sql been run?` },
      { status: 502 }
    );
  }

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path);
  try {
    const profile = await updateUserProfile(admin, auth.session.userId, { avatarUrl: data.publicUrl });
    // Replace, don't accumulate: remove the previous file (best effort).
    const oldPath = ownAvatarPath(previous?.avatarUrl ?? null, auth.session.userId);
    if (oldPath && oldPath !== path) await admin.storage.from(BUCKET).remove([oldPath]).catch(() => undefined);
    return NextResponse.json({ profile });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not save profile photo.' }, { status: 502 });
  }
}

export async function DELETE() {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  try {
    const admin = supabaseAdmin();
    const previous = await getUserProfile(admin, auth.session.userId).catch(() => null);
    const profile = await updateUserProfile(admin, auth.session.userId, { avatarUrl: null });
    const oldPath = ownAvatarPath(previous?.avatarUrl ?? null, auth.session.userId);
    if (oldPath) await admin.storage.from(BUCKET).remove([oldPath]).catch(() => undefined);
    return NextResponse.json({ profile });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not remove profile photo.' }, { status: 502 });
  }
}
