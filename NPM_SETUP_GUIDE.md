# 🎾 Tennis Ranking System - Nginx Proxy Manager Setup Guide

This guide will help you deploy the Tennis Ranking System behind Nginx Proxy Manager (NPM) at a custom domain and path.

## 🔧 Environment Configuration

### Step 1: Configure Environment Variables

Copy the production environment template and modify for your setup:

```bash
cp .env.production .env
```

Edit `.env` with your domain configuration:

```bash
# Domain Configuration for Nginx Proxy Manager
PUBLIC_DOMAIN=mydomain.com
BASE_PATH=/tennis

# CORS Settings - Update with your actual domain
ALLOWED_ORIGINS=https://mydomain.com,https://www.mydomain.com

# Nginx Proxy Manager Configuration
TRUST_PROXY=true
BEHIND_PROXY=true

# Change all passwords and secrets!
ADMIN_PASSWORD=your_very_secure_password
JWT_SECRET=your_32_character_jwt_secret_here
CSRF_SECRET=your_32_character_csrf_secret_here
```

### Step 2: Example Configurations

#### Option A: Subpath Deployment (mydomain.com/tennis)
```bash
PUBLIC_DOMAIN=mydomain.com
BASE_PATH=/tennis
ALLOWED_ORIGINS=https://mydomain.com,https://www.mydomain.com
```

#### Option B: Subdomain Deployment (tennis.mydomain.com)
```bash
PUBLIC_DOMAIN=tennis.mydomain.com
BASE_PATH=/
ALLOWED_ORIGINS=https://tennis.mydomain.com
```

#### Option C: Main Domain (mydomain.com)
```bash
PUBLIC_DOMAIN=mydomain.com
BASE_PATH=/
ALLOWED_ORIGINS=https://mydomain.com,https://www.mydomain.com
```

## 🚀 Application Setup

### Step 3: Build and Start the Application

```bash
# Install dependencies
npm install

# Build for production with your environment
npm run build

# Start the server
npm run start
```

The application will:
- Automatically configure CORS for your domain
- Serve static files at the correct base path
- Trust proxy headers from NPM
- Run on port 3001 (configurable via PORT env var)

## 🌐 Nginx Proxy Manager Configuration

### Step 4: Create Proxy Host in NPM

1. **Access your NPM admin panel**
2. **Go to "Proxy Hosts" and click "Add Proxy Host"**

### Step 5: Configure Proxy Host Settings

#### Details Tab:
- **Domain Names**: `mydomain.com` (or your domain)
- **Scheme**: `http`
- **Forward Hostname/IP**: `your_server_ip` or `localhost`
- **Forward Port**: `3001`
- **Block Common Exploits**: ✅ Enabled
- **Websockets Support**: ✅ Enabled (recommended)

#### Advanced Tab:
Add this configuration for subpath deployment:

```nginx
# For subpath deployment (/tennis)
location /tennis/ {
    proxy_pass http://your_server_ip:3001/tennis/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    
    # Handle API requests
    location /tennis/api/ {
        proxy_pass http://your_server_ip:3001/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### For Subdomain or Main Domain:
If using subdomain (tennis.mydomain.com) or main domain, use simpler config:

```nginx
location / {
    proxy_pass http://your_server_ip:3001/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
}
```

#### SSL Tab:
- **SSL Certificate**: Request a new SSL certificate or use existing
- **Force SSL**: ✅ Enabled
- **HTTP/2 Support**: ✅ Enabled
- **HSTS Enabled**: ✅ Enabled

### Step 6: Save and Test

1. **Save the proxy host configuration**
2. **Wait for SSL certificate generation** (if using Let's Encrypt)
3. **Test access**: Visit `https://mydomain.com/tennis`

## 🔍 Troubleshooting

### Common Issues and Solutions

#### Issue: 404 Not Found
- Check that BASE_PATH in .env matches your NPM location path
- Verify the application is running on the correct port
- Check NPM proxy configuration

#### Issue: CORS Errors
- Ensure ALLOWED_ORIGINS includes your domain with https://
- Check that PUBLIC_DOMAIN matches your actual domain
- Verify NPM is passing correct headers

#### Issue: Assets Not Loading
- Check that Vite base path matches your deployment path
- Verify static file serving configuration
- Check browser developer tools for path issues

#### Issue: API Calls Failing
- Ensure API proxy path is correctly configured in NPM
- Check that backend server is accessible
- Verify TRUST_PROXY is set to true

### Debug Commands

Check application status:
```bash
# Check if app is running
curl -I http://localhost:3001/

# Check with subpath
curl -I http://localhost:3001/tennis/

# Check API endpoint
curl http://localhost:3001/api/auth/status
```

Check logs:
```bash
# View application logs
npm run start

# Check NPM logs in NPM admin panel
```

## 🔒 Security Checklist

- [ ] Changed default admin password
- [ ] Generated new JWT and CSRF secrets
- [ ] Configured CORS for your domain only
- [ ] Enabled SSL/HTTPS
- [ ] Set TRUST_PROXY=true
- [ ] Blocked common exploits in NPM
- [ ] Configured rate limiting

## 📝 Production Deployment Script

Create a deployment script `deploy.sh`:

```bash
#!/bin/bash
echo "🎾 Deploying Tennis Ranking System..."

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Build application
echo "📦 Building application..."
npm run build

# Start application with PM2 (optional)
echo "🚀 Starting application..."
pm2 restart tennis-ranking || pm2 start npm --name "tennis-ranking" -- run start

echo "✅ Deployment complete!"
echo "🌐 Application should be available at: https://${PUBLIC_DOMAIN}${BASE_PATH}"
```

Make it executable:
```bash
chmod +x deploy.sh
./deploy.sh
```

## 🎯 Quick Setup Summary

1. **Copy and edit `.env.production` to `.env`**
2. **Set your domain: `PUBLIC_DOMAIN=mydomain.com`**
3. **Set your path: `BASE_PATH=/tennis`**
4. **Build: `npm run build`**
5. **Start: `npm run start`**
6. **Configure NPM proxy host pointing to your server:3001**
7. **Add subpath location config if needed**
8. **Enable SSL and test**

Your Tennis Ranking System should now be accessible at `https://mydomain.com/tennis`!
