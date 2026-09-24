-- draw-guess 0002: 프로필 사진(소셜 사진 기본값 + 직접 업로드) 지원
-- Supabase SQL Editor 에 붙여 넣어 실행한다. 0001 이후에 실행. 여러 번 실행해도 안전(idempotent).

-- ── 프로필: 아바타 표시 방식 ─────────────────────────────────────
-- avatar_mode: 'photo' = avatar_url 사진 사용 / 'emoji' = avatar_emoji + avatar_color 사용
alter table public.profiles add column if not exists avatar_mode text not null default 'photo';
alter table public.profiles drop constraint if exists profiles_avatar_mode_check;
alter table public.profiles add constraint profiles_avatar_mode_check check (avatar_mode in ('photo', 'emoji'));
-- 소셜 로그인에서 받은 원래 사진(업로드로 바꿔도 되돌릴 수 있게 보관)
alter table public.profiles add column if not exists social_avatar_url text;
update public.profiles set social_avatar_url = avatar_url where social_avatar_url is null and avatar_url is not null;
-- 사진이 없는 기존 프로필은 이모지 모드로
update public.profiles set avatar_mode = 'emoji' where avatar_url is null;

-- 가입 트리거도 소셜 사진을 함께 기록하도록 갱신
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  nick text;
  pic text;
begin
  nick := coalesce(
    new.raw_user_meta_data ->> 'nickname',
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'preferred_username',
    '플레이어'
  );
  nick := left(nick, 12);
  if char_length(nick) = 0 then nick := '플레이어'; end if;
  pic := coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture');
  insert into public.profiles (user_id, nickname, avatar_url, social_avatar_url, avatar_mode)
  values (new.id, nick, pic, pic, case when pic is null then 'emoji' else 'photo' end)
  on conflict (user_id) do nothing;
  return new;
end $$;

-- ── Storage: 업로드한 프로필 사진 버킷 ────────────────────────────
-- 공개 버킷(누구나 읽기) — 방 안의 다른 사람도 사진을 봐야 하므로. 쓰기는 본인 폴더(<user_id>/...)만.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 읽기: 공개 버킷이라 공개 URL 은 정책 없이 열린다. SELECT 는 upsert·삭제에 필요한 "본인 폴더만" 허용(전체 목록 노출 방지)
drop policy if exists "avatars: public read" on storage.objects;
drop policy if exists "avatars: read own" on storage.objects;
create policy "avatars: read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: upload own" on storage.objects;
create policy "avatars: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: update own" on storage.objects;
create policy "avatars: update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: delete own" on storage.objects;
create policy "avatars: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
