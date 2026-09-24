-- draw-guess 계정 기반 P0/P1: 프로필 + 사용자 단어 세트
-- Supabase SQL Editor 에 그대로 붙여 넣어 실행한다. (auth.users 는 Supabase Auth 가 관리)

-- ── 프로필 ─────────────────────────────────────────────────────
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 12),
  avatar_url  text,
  avatar_emoji text,
  avatar_color text check (avatar_color is null or avatar_color ~ '^#[0-9a-fA-F]{6}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 가입 시 프로필 자동 생성 (닉네임은 소셜 프로필 이름 → 없으면 '플레이어')
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  nick text;
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
  insert into public.profiles (user_id, nickname, avatar_url)
  values (new.id, nick, new.raw_user_meta_data ->> 'avatar_url')
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 사용자 단어 세트 ────────────────────────────────────────────
create table if not exists public.word_sets (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 30),
  words       text[] not null default '{}' check (cardinality(words) <= 500),
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists word_sets_owner_idx on public.word_sets (owner_id, updated_at desc);

-- 사용자당 세트 20개 제한
create or replace function public.enforce_word_set_limit()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.word_sets where owner_id = new.owner_id) >= 20 then
    raise exception '단어 세트는 20개까지 만들 수 있어요';
  end if;
  return new;
end $$;
drop trigger if exists word_sets_limit on public.word_sets;
create trigger word_sets_limit before insert on public.word_sets
  for each row execute function public.enforce_word_set_limit();

-- updated_at 자동 갱신
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists word_sets_touch on public.word_sets;
create trigger word_sets_touch before update on public.word_sets for each row execute function public.touch_updated_at();

-- ── RLS: 본인 것만 읽고 쓴다 (공개 세트는 로그인 사용자 누구나 읽기) ──
alter table public.profiles enable row level security;
alter table public.word_sets enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles for select using (auth.uid() = user_id);
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles for insert with check (auth.uid() = user_id);

drop policy if exists "word_sets: read own or public" on public.word_sets;
create policy "word_sets: read own or public" on public.word_sets for select using (auth.uid() = owner_id or is_public);
drop policy if exists "word_sets: insert own" on public.word_sets;
create policy "word_sets: insert own" on public.word_sets for insert with check (auth.uid() = owner_id);
drop policy if exists "word_sets: update own" on public.word_sets;
create policy "word_sets: update own" on public.word_sets for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "word_sets: delete own" on public.word_sets;
create policy "word_sets: delete own" on public.word_sets for delete using (auth.uid() = owner_id);

-- 이미 가입된 사용자가 있다면 프로필을 채운다 (idempotent)
insert into public.profiles (user_id, nickname, avatar_url)
select id, left(coalesce(raw_user_meta_data ->> 'name', raw_user_meta_data ->> 'full_name', '플레이어'), 12), raw_user_meta_data ->> 'avatar_url'
from auth.users
on conflict (user_id) do nothing;
