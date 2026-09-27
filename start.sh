#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

PORT=8000

if command -v python3 >/dev/null 2>&1; then
  PYCMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYCMD="python"
else
  echo "Python was not found. Install Python 3 and try again."
  exit 1
fi

echo "Starting NinDeals on port $PORT..."
$PYCMD -m http.server "$PORT" --bind 0.0.0.0 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

sleep 1

URL="http://localhost:$PORT/"
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "Open this URL manually: $URL"
fi

IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "NinDeals is running."
echo "  On this machine:  $URL"
if [ -n "$IP" ]; then
  echo "  On your network:  http://$IP:$PORT/"
fi
echo ""
echo "Press Ctrl+C to stop the server."

wait $SERVER_PID
