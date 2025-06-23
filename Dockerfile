# Use the official Node.js runtime as the base image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Build the application
RUN npm run build

# Create data directory with proper permissions
RUN mkdir -p /app/data && chown -R node:node /app/data

# Expose the port the app runs on
EXPOSE 3001

# Create a non-root user to run the application
USER node

# Command to run the application
CMD ["npm", "run", "server"]
