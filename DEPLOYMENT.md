# Raspberry Pi 5 Deployment Guide

This guide will help you set up the Kandy Chat bot on a Raspberry Pi 5 using Docker with local deployment.

## Prerequisites on Raspberry Pi 5

### 1. Install Docker

Docker should already be installed on your Pi. Verify with:

```bash
docker --version
docker compose version
```

### 2. Install Git

```bash
sudo apt install git -y
```

## Initial Setup on Raspberry Pi

### 1. Clone Repository

```bash
cd /mnt/nvme
git clone https://github.com/Sponsorn/Kandy-Chat.git kandy-chat
cd kandy-chat
```

### 2. Set Up Environment Variables

```bash
# Copy the example env file
cp .env.example .env

# Edit with your configuration
nano .env
```

Fill in all required Discord and Twitch credentials:

- `DISCORD_TOKEN`: your bot token
- `DISCORD_CHANNEL_ID`: target channel id
- `DISCORD_CLIENT_ID`: application client id
- `DISCORD_GUILD_ID`: guild id for slash commands
- `ADMIN_ROLE_ID`: admin role(s) for commands
- `MOD_ROLE_ID`: mod role(s) for commands
- `TWITCH_USERNAME`: Twitch bot username
- `TWITCH_OAUTH`: IRC oauth token
- `TWITCH_CHANNEL`: channel to read

### 3. Create Data Directory

```bash
mkdir -p data
```

### 4. Deploy Slash Commands

Before starting the bot for the first time, deploy the slash commands:

```bash
# Install dependencies temporarily for deployment
npm install
npm run deploy-commands

# Clean up (Docker will install its own copy)
rm -rf node_modules
```

## Deploying the Bot

### Initial Deployment

```bash
cd /mnt/nvme/kandy-chat

# Build and start the container
docker compose up -d --build

# View logs
docker compose logs -f
```

### Updating the Bot

When you push changes to GitHub, update your Pi with:

```bash
cd /mnt/nvme/kandy-chat

# Pull latest code
git pull

# Rebuild and restart
docker compose up -d --build

# View logs
docker compose logs -f
```

## Useful Commands

### Container Management

```bash
# View logs (follow mode)
docker compose logs -f

# View recent logs
docker compose logs --tail=50

# Restart the bot
docker compose restart

# Stop the bot
docker compose down

# Start the bot
docker compose up -d

# View container status
docker compose ps

# Execute commands inside container
docker compose exec kandy-chat sh
```

### Resource Monitoring

```bash
# View resource usage
docker stats kandy-chat-bot

# System resources
htop

# Disk usage
df -h
```

### Clean Up

```bash
# Remove old images
docker image prune -f

# Remove all unused Docker resources
docker system prune -a
```

## Port Forwarding for EventSub

If you're using EventSub, you'll need to expose port 8080 (or your configured port) to the internet:

1. Set up port forwarding on your router: `8080 → RPI_IP:8080`
2. Consider using a reverse proxy like nginx for HTTPS
3. Or use a service like ngrok for testing:
   ```bash
   ngrok http 8080
   ```

## Troubleshooting

### Container won't start

```bash
# View detailed logs
docker compose logs

# Check environment variables
cat .env

# Rebuild from scratch
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Permission issues

```bash
# Ensure you own the directory
sudo chown -R sponsorn:sponsorn /mnt/nvme/kandy-chat
```

### Check Docker is running

```bash
sudo systemctl status docker
```

### Out of disk space

```bash
# Check disk usage
df -h

# Clean up Docker
docker system prune -a
```

## Security Recommendations

1. **Firewall**: Use UFW to restrict access

   ```bash
   sudo apt install ufw
   sudo ufw allow ssh
   sudo ufw allow 8080/tcp  # Only if using EventSub
   sudo ufw enable
   ```

2. **Keep system updated**:

   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

3. **Never commit `.env` to Git** - it's already in `.gitignore`

4. **SSH security**:
   - Change default SSH port
   - Use SSH key authentication only
   - Disable password authentication

## Auto-Start on Boot

The `restart: unless-stopped` policy in [docker-compose.yml](docker-compose.yml) ensures the bot automatically starts when your Pi boots.

To manually control this:

```bash
# Disable auto-restart
docker compose down

# Enable auto-restart
docker compose up -d
```

## Monitoring

### View System Resources

```bash
# CPU and memory
htop

# Docker resource usage
docker stats kandy-chat-bot

# Disk usage
df -h /mnt/nvme
```

### View Bot Logs

```bash
# Live logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100

# Logs from last hour
docker compose logs --since 1h
```

## Quick Reference

```bash
# Update and restart bot
cd /mnt/nvme/kandy-chat && git pull && docker compose up -d --build

# View logs
docker compose logs -f

# Restart bot
docker compose restart

# Stop bot
docker compose down

# Clean up old images
docker image prune -f
```

## Simple Update Script

You can create a simple script to update the bot. Create `/mnt/nvme/kandy-chat/update.sh`:

```bash
#!/bin/bash
cd /mnt/nvme/kandy-chat
git pull
docker compose up -d --build
docker compose logs --tail=50
```

Make it executable:

```bash
chmod +x /mnt/nvme/kandy-chat/update.sh
```

Then update with:

```bash
/mnt/nvme/kandy-chat/update.sh
```
