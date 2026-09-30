#!/bin/sh
# 프로덕션 /admin/stats JSON을 stdout으로 출력한다. 키는 출력하지 않는다.
# 사용: sh scripts/fetch-stats.sh [일수=14] [키 파일=secret/admin-key.txt]  (메인 체크아웃에서 실행)
DAYS="${1:-14}"
KEYFILE="${2:-secret/admin-key.txt}"
[ -f "$KEYFILE" ] || { echo "키 파일 없음: $KEYFILE" >&2; exit 1; }
KEY=$(tr -d '\r\n ' < "$KEYFILE")
curl -sf -G "https://draw-guess-i927.onrender.com/admin/stats" \
  --data-urlencode "key=$KEY" --data "days=$DAYS" --max-time 90
