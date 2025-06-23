# Use the official Node.js runtime as the base image (LTS version for security)
FROM node:18-alpine

# Install security updates and dumb-init
RUN apk update && apk upgrade && apk add --no-cache dumb-init

# Set the working directory in the container
WORKDIR /app

# Create non-root user with specific UID/GID
RUN addgroup -g 1001 -S nodejs && \
    adduser -S tennisapp -u 1001 -G nodejs

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies and clean up
RUN npm ci --only=production && \
    npm cache clean --force

# Copy the rest of the application code with proper ownership
COPY --chown=tennisapp:nodejs . .

# Build the application
RUN npm run build

# Create data directory with proper permissions
RUN mkdir -p /app/data && \
    chown -R tennisapp:nodejs /app/data && \
    chmod 755 /app/data

# Remove unnecessary files for security
RUN rm -rf .git .gitignore *.md && \
    chown -R tennisapp:nodejs /app && \
    chmod -R 755 /app

# Switch to non-root user
USER tennisapp

# Expose the port the app runs on
EXPOSE 3001

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Command to run the application
CMD ["npm", "run", "server"]
