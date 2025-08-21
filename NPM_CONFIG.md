# Nginx Proxy Manager Configuration for Tennis Ranking System

## Setup Instructions

### 1. Add Proxy Host in NPM

**Domain Names:**
```
mydomain.com/tennis
```

**Scheme:** `http`
**Forward Hostname/IP:** `localhost` (or your server IP if different)
**Forward Port:** `3001`

### 2. Advanced Settings

**Custom Nginx Configuration:**
```nginx
location /tennis {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_cache_bypass $http_upgrade;
    
    # Handle API calls
    location /tennis/api {
        proxy_pass http://localhost:3001/api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 3. SSL Certificate
- Enable SSL certificate (Let's Encrypt or custom)
- Force SSL: Yes
- HTTP/2 Support: Yes

### 4. Environment Variables for Your Server

Create/update your `.env.production` file:
```env
# Domain Configuration
PUBLIC_URL=https://mydomain.com/tennis
DOMAIN=mydomain.com
SUBPATH=/tennis

# Server Configuration
PORT=3001
NODE_ENV=production

# CORS Configuration
ALLOWED_ORIGINS=https://mydomain.com,https://www.mydomain.com

# Behind Proxy
TRUST_PROXY=true
BEHIND_PROXY=true

# Database and other configs...
DB_NAME=tennis_ranking
DB_USER=tennis_user
DB_PASSWORD=your_production_password
DB_HOST=localhost
DB_PORT=5432

# Security (Generate strong secrets!)
JWT_SECRET=your_production_jwt_secret_32_chars_long
CSRF_SECRET=your_production_csrf_secret_32_chars

# Admin Credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_strong_admin_password
ADMIN_EMAIL=admin@mydomain.com
```

### 5. Start Your Application
```bash
# Build the application for production
npm run build

# Start with production environment
NODE_ENV=production npm run server
```

### 6. Quick Test
After setting up, test these URLs:
- `https://mydomain.com/tennis` - Main application
- `https://mydomain.com/tennis/api/health` - API health check

## Notes
- The server runs on port 3001 internally
- NPM handles SSL termination
- All traffic routes through the `/tennis` subpath
- CORS is configured to allow your domain
- Proxy headers are properly forwarded
