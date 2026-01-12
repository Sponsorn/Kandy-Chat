#!/bin/bash
# Simple update script for Kandy Chat bot on Raspberry Pi

set -e  # Exit on error

echo "Updating Kandy Chat bot..."
cd /mnt/nvme/kandy-chat

echo "Pulling latest code from GitHub..."
git pull

echo "Rebuilding and restarting Docker container..."
docker compose up -d --build

echo "Latest logs:"
docker compose logs --tail=50

echo ""
echo "Update complete! Bot is running."
echo "View logs: docker compose logs -f"
