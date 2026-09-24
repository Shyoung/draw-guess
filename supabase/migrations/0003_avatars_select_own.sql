-- draw-guess 0003: avatars 버킷의 넓은 SELECT 정책을 "본인 폴더만"으로 좁힌다
-- 이유: 공개 버킷은 공개 URL(/storage/v1/object/public/avatars/...)로 누구나 사진을 볼 수 있어 SELECT 정책이 필요 없다.
--       다만 업로드 덮어쓰기(upsert)와 삭제는 본인 파일에 대한 SELECT 권한이 필요하므로, 전체 목록 조회만 막고 본인 폴더는 허용한다.
drop policy if exists "avatars: public read" on storage.objects;
drop policy if exists "avatars: read own" on storage.objects;
create policy "avatars: read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
