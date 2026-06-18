#!/usr/bin/env bash
# Tier-2 worker smoke test against `wrangler dev` (local, simulated KV).
# Exercises the full route sequence + auth/ordering rejections.
set -uo pipefail
BASE="${BASE:-http://localhost:8787}"
SECRET="dev-only-session-secret-not-for-production"
EXP=99999999999999
ID="0xabc${RANDOM}${RANDOM}"   # unique per run (wrangler dev persists KV state)
PASS=0; FAIL=0

# code+body for a request; args: METHOD PATH [DATA] [AUTH]
req() {
  local m="$1" p="$2" data="${3:-}" auth="${4:-}"
  local args=(-s -w $'\n%{http_code}' -X "$m" "$BASE$p")
  [ -n "$auth" ] && args+=(-H "authorization: Bearer $auth")
  [ -n "$data" ] && args+=(-H "content-type: application/json" -d "$data")
  curl "${args[@]}"
}
check() { # desc expected_code actual_code [substring] [body]
  if [ "$2" = "$3" ] && { [ -z "${4:-}" ] || grep -q "$4" <<<"${5:-}"; }; then
    echo "  ✓ $1"; PASS=$((PASS+1))
  else
    echo "  ✗ $1 — expected $2 got $3 ${4:+/want '$4'} body=${5:-}"; FAIL=$((FAIL+1))
  fi
}

SELLER_TOK=$(cd "$(dirname "$0")/../.." && cargo run -q --example mint_token -- SELLER_PKH "$SECRET" "$EXP")
BUYER_TOK=$(cd "$(dirname "$0")/../.." && cargo run -q --example mint_token -- BUYER_PKH "$SECRET" "$EXP")

echo "== auth & error paths =="
R=$(req GET "/auth/challenge?pkh=SELLER_PKH"); B=$(sed '$d'<<<"$R"); C=$(tail -1<<<"$R")
check "challenge issued" 200 "$C" "challengeMac" "$B"
R=$(req GET "/auth/challenge"); C=$(tail -1<<<"$R"); check "challenge without pkh -> 400" 400 "$C"
R=$(req POST "/swap" '{"swap":{}}'); C=$(tail -1<<<"$R"); check "create without auth -> 401" 401 "$C"
R=$(req GET "/swap/$ID"); C=$(tail -1<<<"$R"); check "missing swap -> 404" 404 "$C"
R=$(req GET "/list?prefix=idx:nock:SELLER_PKH:"); C=$(tail -1<<<"$R"); check "list without auth -> 401" 401 "$C"

echo "== happy path (offline-minted tokens) =="
SWAP='{"swap":{"hEvm":"'$ID'","hNock":"HN","sellerPkh":"SELLER_PKH","usdcTimelock":"1","nockGift":"100","nockRefundHeight":"1","sellerEth":"0xseller","usdcAmount":"1"}}'
R=$(req POST "/swap" "$SWAP" "$SELLER_TOK"); B=$(sed '$d'<<<"$R"); C=$(tail -1<<<"$R")
check "seller creates swap" 200 "$C" '"version":1' "$B"
R=$(req GET "/swap/$ID"); B=$(sed '$d'<<<"$R"); C=$(tail -1<<<"$R")
check "read back swap" 200 "$C" '"sellerPkh":"SELLER_PKH"' "$B"
R=$(req POST "/swap/$ID/claim" '{"buyerEth":"0xbuyer"}' "$BUYER_TOK"); B=$(sed '$d'<<<"$R"); C=$(tail -1<<<"$R")
check "buyer claims" 200 "$C" '"version":2' "$B"
R=$(req POST "/swap/$ID/advance" '{"fields":{"usdcLockTxHash":"0xul"}}' "$BUYER_TOK"); C=$(tail -1<<<"$R"); B=$(sed '$d'<<<"$R")
check "buyer cannot lock USDC before NOCK lock -> 409" 409 "$C" 'before .*lockFirstName' "$B"
R=$(req POST "/swap/$ID/advance" '{"fields":{"lockFirstName":"LFN","nockLockTxId":"0xnl"}}' "$SELLER_TOK"); C=$(tail -1<<<"$R"); B=$(sed '$d'<<<"$R")
check "seller advances (lockFirstName)" 200 "$C" '"version":3' "$B"
R=$(req POST "/swap/$ID/advance" '{"fields":{"lockFirstName":"EVIL"}}' "$BUYER_TOK"); C=$(tail -1<<<"$R")
check "buyer cannot write seller field -> 403" 403 "$C"
R=$(req GET "/list?prefix=idx:nock:OTHER:" "" "$SELLER_TOK"); C=$(tail -1<<<"$R")
check "list someone else's swaps -> 403" 403 "$C"
R=$(req GET "/list?prefix=idx:nock:SELLER_PKH:" "" "$SELLER_TOK"); B=$(sed '$d'<<<"$R"); C=$(tail -1<<<"$R")
check "list own swaps returns the id" 200 "$C" "$ID" "$B"

echo "== CORS =="
H=$(curl -s -D - -o /dev/null -X OPTIONS "$BASE/swap")
grep -qi "access-control-allow-origin: \*" <<<"$H" && { echo "  ✓ OPTIONS preflight CORS"; PASS=$((PASS+1)); } || { echo "  ✗ OPTIONS preflight CORS"; FAIL=$((FAIL+1)); }

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
