#!/bin/sh
# Every test suite, one after another. TEST_PG_OFFSET (e.g. 100) moves every test database to its own ports so two
# checkouts can test at the same time; the e2e test uses LOCAL_PG_PORT (default 5439 + offset).
OFF=${TEST_PG_OFFSET:-0}
export TEST_PG_OFFSET=$OFF
fail=0
# A suite fails if it exits non-zero (a crash included) or its last line says it failed
run() { out=$("$@" 2>&1); rc=$?; last=$(printf '%s\n' "$out" | tail -1); echo "$last"; [ $rc -ne 0 ] && fail=1; case "$last" in *FAIL*|*Error*|*error*|Node.js*|*Exception*) fail=1;; esac; }
node --test test/*.test.js 2>&1 | grep -E "^ℹ (pass|fail)" ; node --test test/*.test.js >/dev/null 2>&1 || fail=1
for t in audit-regression-test core-test sheet-reconcile-test ask-test ask-battery-test llm-test listings-test promotions-test ask-audit-test email-test frontend-test; do run node scripts/$t.js; done
LOCAL_PG_PORT=$((5439 + OFF)) run node scripts/e2e-test.js
run node scripts/stress-test.js 7 worst
run node scripts/stress-test.js 7 realistic
run node scripts/ebay-test.js
[ $fail = 0 ] && echo "ALL SUITES PASSED" || { echo "SOME SUITES FAILED"; exit 1; }
