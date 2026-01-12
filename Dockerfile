# Use Node.js LTS on Alpine for smaller image size
FROM node:20-alpine

# Install ffmpeg for freeze monitor feature
RUN apk add --no-cache ffmpeg

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Set NODE_ENV to production
ENV NODE_ENV=production

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Start the bot
CMD ["npm", "start"]
