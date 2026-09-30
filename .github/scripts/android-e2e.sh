#!/usr/bin/env bash
# Android emulator smoke test (run inside reactivecircus/android-emulator-runner):
# real server on the host -> pairing deep link -> Maestro drives the release APK ->
# the task created in the app must exist on the server.
#   usage: android-e2e.sh <apk>
set -euo pipefail
APK=$1
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOME_DIR=${RUNNER_TEMP:-/tmp}/todo-devs-e2e
OUT=${E2E_OUT:-$ROOT/e2e-artifacts}
PORT=7420
CLI="node $ROOT/bin/todo-devs.js --home $HOME_DIR"
mkdir -p "$OUT"

node "$ROOT/bin/todo-devs.js" serve --home "$HOME_DIR" --host 0.0.0.0 --port $PORT > "$OUT/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null || { echo "server did not start"; cat "$OUT/server.log"; exit 1; }

# 10.0.2.2 is the host machine as seen from the Android emulator.
LINK=$($CLI pair --host 10.0.2.2 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);if(!i.enabled)throw new Error(i.reason);process.stdout.write(i.links[0].deepLink)})')
echo "pairing link: $LINK"

if [ -n "${SKIP_DEVICE:-}" ]; then echo "SKIP_DEVICE set: not running the emulator part"; exit 0; fi

adb install -r "$APK"
export PATH="$PATH:$HOME/.maestro/bin"
set +e
maestro test --env LINK="$LINK" --test-output-dir "$OUT/maestro" "$ROOT/apps/mobile/e2e/smoke.yaml"
RC=$?
set -e
adb logcat -d > "$OUT/logcat.txt" 2>/dev/null || true
[ $RC -eq 0 ] || { echo "maestro failed ($RC)"; tail -40 "$OUT/server.log"; exit $RC; }

# The app talked to the real server: the task it created is there.
$CLI tasks --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);if(!t.some(x=>x.title==="From Maestro"))throw new Error("task from the app not found on the server: "+s);console.log("server has the task created in the app ✓")})'
