#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/usr/local/ops-engine-agent"
SERVICE_USER="${SERVICE_USER:-ishan}"
SERVICE_GROUP="${SERVICE_GROUP:-ishan}"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install_agent.sh"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/agent/agent.py" "$INSTALL_DIR/agent.py"
cp "$REPO_DIR/agent/requirements.txt" "$INSTALL_DIR/requirements.txt"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  cp "$REPO_DIR/agent/.env.example" "$INSTALL_DIR/.env"
  echo "Created $INSTALL_DIR/.env. Edit it before enabling the timer."
fi

python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt"

cp "$REPO_DIR/agent/systemd/ops-engine-agent.service" /etc/systemd/system/ops-engine-agent.service
cp "$REPO_DIR/agent/systemd/ops-engine-agent.timer" /etc/systemd/system/ops-engine-agent.timer

# Replace default user/group in service if needed.
sed -i "s/^User=.*/User=${SERVICE_USER}/" /etc/systemd/system/ops-engine-agent.service
sed -i "s/^Group=.*/Group=${SERVICE_GROUP}/" /etc/systemd/system/ops-engine-agent.service

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env"
chmod +x "$INSTALL_DIR/agent.py"

systemctl daemon-reload

echo "Installed Ops Engine agent to $INSTALL_DIR"
echo "Next: sudo nano $INSTALL_DIR/.env"
echo "Then test: sudo systemctl start ops-engine-agent.service && sudo journalctl -u ops-engine-agent -n 50 --no-pager"
echo "Then enable: sudo systemctl enable --now ops-engine-agent.timer"
