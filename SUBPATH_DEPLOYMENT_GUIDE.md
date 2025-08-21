# Tennis Ranking System - Subpath Deployment Guide

This guide explains how to deploy the Tennis Ranking System at `https://mydomain.com/tennis` using nginx proxy manager.

## 🚀 Quick Setup Steps

### 1. Application Configuration

The application has been configured to work with the subpath `/tennis`. Key changes made:

- **Vite Config**: Set `base: '/tennis/'` for asset paths
- **Server Config**: Added `SUBPATH=/tennis` environment variable
- **Static Files**: Served at the subpath location
- **API Routes**: Work with nginx proxy forwarding

### 2. Build and Deploy

```bash
# Build the application with subpath support
npm run build

# The dist/ folder will contain the built application
# with assets correctly configured for /tennis/ subpath
```

### 3. Nginx Proxy Manager Configuration

#### Option A: Using nginx proxy manager UI

1. **Create New Proxy Host**:
   - Domain Names: `mydomain.com`
   - Scheme: `http`
   - Forward Hostname/IP: `your-server-ip`
   - Forward Port: `3001`
   - Block Common Exploits: ✅
   - Websockets Support: ✅

2. **Advanced Tab - Custom Nginx Configuration**:
```nginx
# Handle the /tennis subpath
location /tennis {
    proxy_pass http://your-server-ip:3001/tennis;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    proxy_redirect off;
    
    # Handle API requests
    location /tennis/api {
        proxy_pass http://your-server-ip:3001/api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Server $host;
    }
}
```

3. **SSL Tab**:
   - Request a new SSL Certificate
   - Force SSL: ✅
   - HTTP/2 Support: ✅

#### Option B: Direct nginx configuration

If you're using nginx directly, add this to your server block:

```nginx
server {
    listen 443 ssl http2;
    server_name mydomain.com;
    
    # SSL configuration
    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;
    
    # Handle the /tennis subpath
    location /tennis {
        proxy_pass http://127.0.0.1:3001/tennis;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_redirect off;
        
        # Handle static files
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            proxy_pass http://127.0.0.1:3001;
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
    
    # Handle API requests (strip /tennis prefix for API)
    location /tennis/api {
        rewrite ^/tennis/api/(.*) /api/$1 break;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

### 4. Environment Configuration

Create a production environment file:

```bash
# Copy the production template
cp .env.production .env

# Edit the file with your actual values
nano .env
```

Update these critical values:
- `ADMIN_PASSWORD`: Strong password for admin access
- `JWT_SECRET`: 32+ character random string
- `CSRF_SECRET`: 32+ character random string
- `ALLOWED_ORIGINS`: Your actual domain(s)
- `DB_PASSWORD`: Database password

### 5. Start the Application

```bash
# Install dependencies
npm install

# Build the application
npm run build

# Start the production server
npm run server

# Or use PM2 for production
pm2 start npm --name "tennis-ranking" -- run server
```

## 🔧 Alternative Configurations

### Different Subpath

To use a different subpath (e.g., `/sports/tennis`):

1. Update `vite.config.js`:
```javascript
export default defineConfig({
  base: '/sports/tennis/',
  // ... rest of config
})
```

2. Update `.env`:
```bash
SUBPATH=/sports/tennis
```

3. Update nginx configuration accordingly

### Root Domain Deployment

To deploy at the root (https://tennis.mydomain.com):

1. Update `vite.config.js`:
```javascript
export default defineConfig({
  base: '/',
  // ... rest of config
})
```

2. Update `.env`:
```bash
SUBPATH=
```

3. Nginx config:
```nginx
location / {
    proxy_pass http://127.0.0.1:3001/;
    # ... proxy headers
}

location /api {
    proxy_pass http://127.0.0.1:3001/api;
    # ... proxy headers
}
```

## 🐛 Troubleshooting

### Assets Not Loading
- Check that `base: '/tennis/'` is set in vite.config.js
- Verify nginx is serving static files correctly
- Check browser network tab for 404 errors

### API Calls Failing
- Verify CORS settings in `.env`
- Check that API requests are being proxied correctly
- Ensure nginx is stripping/adding paths correctly

### Authentication Issues
- Check JWT_SECRET and CSRF_SECRET are set
- Verify cookies are being set with correct domain
- Check HTTPS is working properly

### CSS/JS Not Loading
- Clear browser cache
- Check Content-Type headers are correct
- Verify gzip compression is working

## 📝 Production Checklist

- [ ] Update all passwords and secrets in `.env`
- [ ] Set `NODE_ENV=production`
- [ ] Configure proper CORS origins
- [ ] Set up SSL certificate
- [ ] Configure nginx proxy
- [ ] Test all functionality
- [ ] Set up monitoring/logging
- [ ] Configure firewall rules
- [ ] Set up database backups
- [ ] Test automatic restarts (PM2)

## 🔗 URLs After Deployment

- **Application**: https://mydomain.com/tennis
- **API Health Check**: https://mydomain.com/tennis/api/health
- **Admin Login**: Use the login button in the app

The application will automatically redirect from the root path to the tennis subpath for convenience.
