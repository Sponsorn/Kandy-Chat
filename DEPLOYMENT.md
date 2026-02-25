# Deployment Guide

Kandy Chat runs with Docker Compose. Two services: the main Node.js bot (`kandy-chat`) and an optional Python YouTube-to-Twitch relay (`youtube-relay`).

## Initial Setup

### 1. Clone and configure

```bash
cd /mnt/nvme
git clone https://github.com/Sponsorn/Kandy-Chat.git kandy-chat
cd kandy-chat

# Main bot config
cp .env.example .env
nano .env

# YouTube relay config (optional)
cp youtube-relay/.env.example youtube-relay/.env
nano youtube-relay/.env

# Ensure data directory exists
mkdir -p data
```

### 2. Deploy slash commands

```bash
npm install
npm run deploy-commands
rm -rf node_modules  # Docker installs its own
```

### 3. Start

```bash
docker compose up -d --build
```

To start without the youtube-relay:

```bash
docker compose up -d --build kandy-chat
```

## Updating

Use the `kandy-update` command (installed on the Pi):

```bash
kandy-update
```

This pulls the latest code, clears the stop flag, rebuilds both containers, and tails the logs.

## Services

| Service | Container | Config | Volumes |
|---------|-----------|--------|---------|
| `kandy-chat` | `kandy-chat-bot` | `.env` | `./data:/app/data` |
| `youtube-relay` | `youtube-relay` | `youtube-relay/.env` | `./data:/app/data:ro`, `./youtube-relay/.bot_message_counter:/app/.bot_message_counter` |

The youtube-relay mounts `data/` read-only to consume `emoji-mappings.json` (managed by the dashboard).

## Common Commands

```bash
# Logs
docker compose logs -f                    # all services
docker compose logs -f kandy-chat         # main bot only
docker compose logs -f youtube-relay      # relay only
docker compose logs --tail=100 --since 1h # recent

# Control
docker compose restart                    # restart all
docker compose restart kandy-chat         # restart one
docker compose stop youtube-relay         # stop relay only
docker compose down                       # stop all

# Status
docker compose ps
docker stats
```

## Troubleshooting

### Container won't start

```bash
docker compose logs                       # check error
docker compose down
docker compose build --no-cache           # full rebuild
docker compose up -d
```

### SD card full

```bash
df -h
sudo docker builder prune -f
sudo apt clean
```

### Permission issues

```bash
sudo chown -R sponsorn:sponsorn /mnt/nvme/kandy-chat
```

## Dashboard

The web dashboard runs on port 8080 (same as EventSub). Access via `https://{DASHBOARD_DOMAIN}`. Requires `DASHBOARD_ENABLED=true` in `.env`.

## Auto-Start

The `restart: unless-stopped` / `restart: on-failure` policies in docker-compose.yml ensure containers start on boot as long as Docker is running.
