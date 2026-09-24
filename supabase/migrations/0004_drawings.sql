-- draw-guess 0004: 그림 보관(내 정보 › 그림)
-- 게임이 끝나면 로그인 사용자가 "직접 그린" 그림을 이미지(webp/png)로 저장한다. 사용자당 100장까지.
-- Supabase SQL Editor 에 붙여 넣어 실행한다. 0001~0003 이후에 실행. 여러 번 실행해도 안전(idempotent).

-- ── 그림 메타데이터 ─────────────────────────────────────────────
create table if not exists public.drawings (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  path        text not null unique check (char_length(path) between 1 and 200),  -- Storage drawings 버킷 안 경로: <owner_id>/<파일>
  word        text not null check (char_length(word) between 1 and 40),          -- 제시어
  category    text check (category is null or char_length(category) <= 40),
  round       int  check (round is null or round between 0 and 100),
  guessed     int  check (guessed is null or guessed between 0 and 100),         -- 맞힌 사람 수
  created_at  timestamptz not null default now()
);
create index if not exists drawings_owner_idx on public.drawings (owner_id, created_at desc);

-- 사용자당 100장 제한 (넘으면 클라이언트가 "오래된 그림 받고 정리" 를 안내한다)
create or replace function public.enforce_drawing_limit()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.drawings where owner_id = new.owner_id) >= 100 then
    raise exception '그림은 100장까지 보관할 수 있어요';
  end if;
  return new;
end $$;
drop trigger if exists drawings_limit on public.drawings;
create trigger drawings_limit before insert on public.drawings
  for each row execute function public.enforce_drawing_limit();

-- RLS: 본인 것만 읽고/만들고/지운다 (수정은 없음). 경로도 본인 폴더여야 한다
alter table public.drawings enable row level security;
drop policy if exists "drawings: read own" on public.drawings;
create policy "drawings: read own" on public.drawings for select using (auth.uid() = owner_id);
drop policy if exists "drawings: insert own" on public.drawings;
create policy "drawings: insert own" on public.drawings for insert
  with check (auth.uid() = owner_id and split_part(path, '/', 1) = auth.uid()::text);
drop policy if exists "drawings: delete own" on public.drawings;
create policy "drawings: delete own" on public.drawings for delete using (auth.uid() = owner_id);

-- ── Storage: 그림 이미지 버킷(비공개) ─────────────────────────────
-- 비공개 버킷: 본인만 서명 URL 로 본다. 한 장 512KB 이하, webp/png
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('drawings', 'drawings', false, 524288, array['image/webp', 'image/png'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "drawings files: read own" on storage.objects;
create policy "drawings files: read own" on storage.objects for select to authenticated
  using (bucket_id = 'drawings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "drawings files: upload own" on storage.objects;
create policy "drawings files: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'drawings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "drawings files: delete own" on storage.objects;
create policy "drawings files: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'drawings' and (storage.foldername(name))[1] = auth.uid()::text);
