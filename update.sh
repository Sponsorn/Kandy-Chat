#!/bin/bash
# Simple update script for Kandy Chat bot on Raspberry Pi

set -e  # Exit on error

echo "Updating Kandy Chat bot..."
cd /mnt/nvme/kandy-chat

echo "Pulling latest code from GitHub..."
git pull

echo "Removing stop flag if present..."
sudo rm -f data/.stopped

echo "Rebuilding and restarting Docker container..."
docker compose up -d --build

echo ""
echo "Update complete! Showing logs..."
docker compose logs -f --tail=35
