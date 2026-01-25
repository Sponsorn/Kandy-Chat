#!/bin/bash
# Manual start script for Kandy Chat bot on Raspberry Pi
# Removes stop flag and starts the container

set -e  # Exit on error

cd /mnt/nvme/kandy-chat

echo "Removing stop flag if present..."
rm -f data/.stopped

echo "Starting Docker container..."
docker compose up -d

echo ""
echo "Bot started! Showing logs..."
docker compose logs -f --tail=35
