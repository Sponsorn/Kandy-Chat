# Raspberry Pi 5 Deployment Guide

This guide will help you set up the Kandy Chat bot on a Raspberry Pi 5 using Docker and GitHub Actions for automated deployment.

## Prerequisites on Raspberry Pi 5

### 1. Install Raspberry Pi OS
Install Raspberry Pi OS (64-bit) on your Pi 5. You can use Raspberry Pi Imager.

### 2. Update System
```bash
sudo apt update && sudo apt upgrade -y
```

### 3. Install Docker
```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to the docker group
sudo usermod -aG docker $USER

# Log out and back in for group changes to take effect
```

### 4. Install Docker Compose
```bash
# Docker Compose should be included with Docker now, verify:
docker compose version
```

### 5. Install Git
```bash
sudo apt install git -y
```

### 6. Clone Repository on Raspberry Pi
```bash
cd ~
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git kandy-chat
cd kandy-chat
```

### 7. Set Up Environment Variables
```bash
# Copy the example env file
cp .env.example .env

# Edit with your configuration
nano .env
```

Fill in all required Discord and Twitch credentials.

### 8. Create Data Directory
```bash
mkdir -p data
```

## GitHub Actions Setup

### 1. Generate SSH Key on Raspberry Pi
```bash
ssh-keygen -t ed25519 -C "github-actions"
# Save to default location, set a passphrase if desired
```

### 2. Add Public Key to Authorized Keys
```bash
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 3. Get Your Raspberry Pi's IP Address
```bash
hostname -I
```

### 4. Add GitHub Secrets
Go to your GitHub repository → Settings → Secrets and variables → Actions → New repository secret

Add the following secrets:

- `RPI_HOST`: Your Raspberry Pi's IP address (e.g., `192.168.1.100`)
- `RPI_USERNAME`: Your username on the Pi (e.g., `pi`)
- `RPI_SSH_KEY`: Contents of `~/.ssh/id_ed25519` (the private key)
  ```bash
  cat ~/.ssh/id_ed25519
  # Copy entire output including BEGIN and END lines
  ```

Optional (only if you want to push to Docker Hub):
- `DOCKER_USERNAME`: Your Docker Hub username
- `DOCKER_PASSWORD`: Your Docker Hub password or access token

## Initial Deployment

### Manual First Deploy on Raspberry Pi
```bash
cd ~/kandy-chat

# Build the Docker image
docker compose build

# Start the container
docker compose up -d

# View logs
docker compose logs -f
```

### Verify It's Running
```bash
docker compose ps
docker compose logs --tail=50
```

## Automated Deployment with GitHub Actions

After setting up the GitHub secrets, every push to the `master` branch will:
1. Build a Docker image for ARM64 architecture
2. Transfer it to your Raspberry Pi
3. Stop the old container
4. Start the new container
5. Show the latest logs

You can also manually trigger a deployment:
- Go to Actions → Deploy to Raspberry Pi → Run workflow

## Useful Commands

### On Raspberry Pi

```bash
# View logs
docker compose logs -f

# Restart the bot
docker compose restart

# Stop the bot
docker compose down

# Start the bot
docker compose up -d

# Rebuild and restart
docker compose up -d --build

# View container status
docker compose ps

# Execute commands inside container
docker compose exec kandy-chat sh

# View resource usage
docker stats kandy-chat-bot
```

## Port Forwarding for EventSub

If you're using EventSub, you'll need to expose port 8080 (or your configured port) to the internet:

1. Set up port forwarding on your router: `8080 → RPI_IP:8080`
2. Consider using a reverse proxy like nginx for HTTPS
3. Or use a service like ngrok for testing

## Troubleshooting

### Container won't start
```bash
docker compose logs
```

### Check if .env is correct
```bash
cat .env
```

### Rebuild image from scratch
```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Check Docker is running
```bash
sudo systemctl status docker
```

### GitHub Actions deployment fails
- Verify SSH key is correct in GitHub secrets
- Test SSH connection: `ssh -i ~/.ssh/id_ed25519 user@rpi_ip`
- Check Raspberry Pi is accessible from internet (if deploying from outside network)

## Security Recommendations

1. Use a firewall on your Pi:
   ```bash
   sudo apt install ufw
   sudo ufw allow ssh
   sudo ufw allow 8080/tcp  # Only if using EventSub
   sudo ufw enable
   ```

2. Change default SSH port
3. Use SSH key authentication only (disable password auth)
4. Keep your system updated:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

5. Don't commit your `.env` file to Git (it's already in `.gitignore`)

## Monitoring

### Set up auto-restart on boot
The `restart: unless-stopped` policy in docker-compose.yml ensures the bot restarts automatically.

### View system resources
```bash
# CPU and memory usage
htop

# Disk usage
df -h

# Docker resource usage
docker stats
```

## Updates

When you push code changes to GitHub:
1. GitHub Actions will automatically build and deploy
2. The bot will restart with the new code
3. Your data directory and .env persist across updates

Manual update:
```bash
cd ~/kandy-chat
git pull
docker compose up -d --build
```
