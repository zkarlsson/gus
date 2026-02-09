#!/bin/bash
# One-time Droplet provisioning for OpenClaw on DigitalOcean
# Run as root on a fresh Ubuntu 24.04 Droplet
set -euo pipefail

echo "=== OpenClaw Droplet Setup ==="

# Install Node.js 22 (NodeSource)
echo "Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Install Caddy
echo "Installing Caddy..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Install ufw
echo "Configuring firewall..."
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Create openclaw system user
echo "Creating openclaw user..."
if ! id openclaw &>/dev/null; then
    useradd --system --create-home --shell /bin/bash openclaw
fi

# Install openclaw globally
echo "Installing openclaw@2026.2.3..."
npm install -g openclaw@2026.2.3

# Copy service and config files
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing systemd service..."
cp "$SCRIPT_DIR/openclaw.service" /etc/systemd/system/openclaw.service

echo "Installing setup-config.sh..."
cp "$SCRIPT_DIR/setup-config.sh" /home/openclaw/setup-config.sh
chmod +x /home/openclaw/setup-config.sh
chown openclaw:openclaw /home/openclaw/setup-config.sh

echo "Installing Caddyfile..."
cp "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile

# Create config and workspace directories
mkdir -p /home/openclaw/.openclaw
mkdir -p /home/openclaw/clawd/skills
chown -R openclaw:openclaw /home/openclaw/.openclaw
chown -R openclaw:openclaw /home/openclaw/clawd

# Copy env.example
cp "$SCRIPT_DIR/env.example" /home/openclaw/.openclaw/env.example
chown openclaw:openclaw /home/openclaw/.openclaw/env.example

# Copy skills if present
if [ -d "$SCRIPT_DIR/skills" ] && [ "$(ls -A "$SCRIPT_DIR/skills" 2>/dev/null)" ]; then
    cp -a "$SCRIPT_DIR/skills/." /home/openclaw/clawd/skills/
    chown -R openclaw:openclaw /home/openclaw/clawd/skills
    echo "Skills installed to /home/openclaw/clawd/skills/"
fi

# Reload systemd
systemctl daemon-reload

# Enable services (but don't start yet — env file needs to be populated)
systemctl enable openclaw.service
systemctl enable caddy

# Start Caddy (it can run before openclaw is ready)
systemctl restart caddy

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy env.example to env and populate with your secrets:"
echo "     cp /home/openclaw/.openclaw/env.example /home/openclaw/.openclaw/env"
echo "     nano /home/openclaw/.openclaw/env"
echo ""
echo "  2. Start OpenClaw:"
echo "     systemctl start openclaw"
echo ""
echo "  3. Check status:"
echo "     systemctl status openclaw"
echo "     journalctl -u openclaw -f"
echo ""
echo "  4. Update DNS: point gus.giantsofoakland.com to this Droplet's IP"
