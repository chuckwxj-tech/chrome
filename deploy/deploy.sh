#!/bin/bash
# Cloud Vault Browser Capture — One-click deploy to cloud server
# Usage: ./deploy.sh [host] [user]

set -euo pipefail

HOST="${1:-your-server.com}"
USER="${2:-root}"
REMOTE_DIR="/opt/cloud-vault-browser-capture"

echo "=== Cloud Vault Capture Deploy ==="
echo "Host: $USER@$HOST"
echo ""

# 1. Copy files to server
echo "[1/5] Copying backend files..."
ssh "$USER@$HOST" "mkdir -p $REMOTE_DIR/backend"
rsync -avz --exclude '.venv' --exclude '__pycache__' --exclude '.env' --exclude 'data' \
  backend/ "$USER@$HOST:$REMOTE_DIR/backend/"

# 2. Set up virtual environment
echo "[2/5] Setting up Python environment..."
ssh "$USER@$HOST" "cd $REMOTE_DIR/backend && \
  python3 -m venv .venv && \
  .venv/bin/pip install -r requirements.txt"

# 3. Ensure storage directories exist with correct permissions
echo "[3/5] Creating storage directories..."
ssh "$USER@$HOST" "mkdir -p /srv/cloud-vault/inbox/browser-capture && \
  chown -R www-data:www-data /srv/cloud-vault 2>/dev/null || \
  chmod -R 755 /srv/cloud-vault"

# 3b. Ensure DB data directory is writable by www-data
echo "[3b/5] Setting up database directory..."
ssh "$USER@$HOST" "mkdir -p $REMOTE_DIR/backend/data && \
  chown www-data:www-data $REMOTE_DIR/backend/data 2>/dev/null || \
  chmod 755 $REMOTE_DIR/backend/data"

# 4. Copy and enable systemd service
echo "[4/5] Configuring systemd service..."
scp deploy/cloud-vault-capture.service "$USER@$HOST:/etc/systemd/system/"
ssh "$USER@$HOST" "systemctl daemon-reload && \
  systemctl enable cloud-vault-capture && \
  chown -R www-data:www-data $REMOTE_DIR/backend/data 2>/dev/null || true && \
  chown www-data:www-data $REMOTE_DIR/backend/data/captures.db 2>/dev/null || true && \
  systemctl restart cloud-vault-capture"

# 5. Verify
echo "[5/5] Verifying..."
sleep 2
ssh "$USER@$HOST" "systemctl status cloud-vault-capture --no-pager"
echo ""
echo "=== Deploy complete ==="
echo "Check: curl http://$HOST:8000/health"
