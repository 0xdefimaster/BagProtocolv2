-- 0039_user_profile.sql
--
-- Creator profile: a display name (column already existed, now bounded) and a
-- profile photo. Photos are uploaded through POST /api/profile/avatar (server
-- side, service role, content checked by magic bytes) into the public
-- `avatars` Storage bucket; users.avatar_url holds that public https URL.

alter table users add column if not exists avatar_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_avatar_url_https') then
    alter table users
      add constraint users_avatar_url_https
      check (avatar_url is null or (avatar_url like 'https://%' and length(avatar_url) <= 2048));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_display_name_length') then
    alter table users
      add constraint users_display_name_length
      check (display_name is null or char_length(display_name) between 1 and 32);
  end if;
end $$;

-- Public read (the image is shown on public Bag pages); no client write
-- policy — only the server (service role) uploads.
-- Supabase only: plain Postgres (integration tests) has no storage schema.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 1048576, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    on conflict (id) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
