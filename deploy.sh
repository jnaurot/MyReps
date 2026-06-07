#!/usr/bin/env bash
set -euo pipefail

SERVER_USER="${SERVER_USER:-root}"
SERVER_HOST="${SERVER_HOST:-194.195.92.140}"
SERVER="$SERVER_USER@$SERVER_HOST"

REMOTE_BACKEND_BASE="${REMOTE_BACKEND_BASE:-/var/www/politician}"
REMOTE_FRONTEND_BASE="${REMOTE_FRONTEND_BASE:-/var/www/politician.bawlmorean.com}"
LOCAL_BASE="${LOCAL_BASE:-$HOME/Projects/MyReps}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v24.15.0/bin}"

cd "$LOCAL_BASE"

echo "=== Typechecking frontend ==="
pnpm --filter @workspace/rep run typecheck

echo "=== Building frontend ==="
pnpm --filter @workspace/rep run build

echo "=== Syncing backend/source to server ==="
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  "$LOCAL_BASE/" "$SERVER:$REMOTE_BACKEND_BASE/"

echo "=== Deploying frontend to nginx root ==="
ssh "$SERVER" "mkdir -p '$REMOTE_FRONTEND_BASE'"
rsync -avz --delete \
  "$LOCAL_BASE/artifacts/rep/dist/public/" \
  "$SERVER:$REMOTE_FRONTEND_BASE/"

echo "=== Building backend on server ==="
ssh "$SERVER" "cd '$REMOTE_BACKEND_BASE' && '$NODE_BIN/pnpm' install --ignore-scripts && '$NODE_BIN/pnpm' --filter @workspace/api-server run build"

echo "=== Restarting backend ==="
ssh "$SERVER" "'$NODE_BIN/pm2' restart politician-api && '$NODE_BIN/pm2' logs politician-api --lines 10 --nostream"

echo "=== Done! ==="
echo "Frontend: https://politician.bawlmorean.com"
echo "Backend source: $REMOTE_BACKEND_BASE"
echo "Frontend root: $REMOTE_FRONTEND_BASE"
