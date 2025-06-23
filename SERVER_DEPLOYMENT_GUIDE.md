# 🚀 Server Deployment Guide - Tennis Ranking System

Deploy your tennis ranking system on any server (local network or cloud).

## 📋 Prerequisites

- A server with Linux/Ubuntu (recommended) or Windows
- Internet connection for initial setup
- Basic command line knowledge

## 🎯 Deployment Options

### Option 1: Docker Deployment (Recommended)
**Easiest and most secure method**

### Option 2: Direct Node.js Deployment
**For custom configurations**

---

## 🐳 Docker Deployment (Recommended)

### Step 1: Install Docker

#### Ubuntu/Debian Server:
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group (optional, for non-root usage)
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo apt install docker-compose-plugin -y
```

#### CentOS/RHEL Server:
```bash
# Install Docker
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl start docker
sudo systemctl enable docker
```

### Step 2: Upload Project Files
```bash
# Option A: Direct upload
scp -r /path/to/ranking-system user@your-server:/home/user/tennis-ranking

# Option B: Git clone (if using version control)
git clone your-repository-url tennis-ranking
cd tennis-ranking
```

### Step 3: Deploy with Docker
```bash
cd tennis-ranking

# Make setup script executable
chmod +x docker-setup.sh

# Run setup (creates and starts containers)
./docker-setup.sh

# Or manually:
docker-compose up -d
```

### Step 4: Access Your System
- **Local Network**: `http://your-server-ip:3001`
- **Example**: `http://192.168.1.100:3001`

### Step 5: Configure Firewall (if needed)
```bash
# Ubuntu/Debian
sudo ufw allow 3001/tcp
sudo ufw reload

# CentOS/RHEL
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --reload
```

---

## 🔧 Direct Node.js Deployment

### Step 1: Install Node.js

#### Ubuntu/Debian:
```bash
# Install Node.js 18+ (recommended)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

#### CentOS/RHEL:
```bash
# Install Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

### Step 2: Upload and Setup Project
```bash
# Upload project files
scp -r /path/to/ranking-system user@your-server:/home/user/tennis-ranking

# SSH to server
ssh user@your-server
cd tennis-ranking

# Install dependencies
npm install

# Build the project
npm run build
```

### Step 3: Create Systemd Service (Linux)
```bash
# Create service file
sudo nano /etc/systemd/system/tennis-ranking.service
```

Add this content:
```ini
[Unit]
Description=Tennis Ranking System
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/tennis-ranking
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service (auto-start on boot)
sudo systemctl enable tennis-ranking

# Start service
sudo systemctl start tennis-ranking

# Check status
sudo systemctl status tennis-ranking
```

### Step 4: Configure Firewall
```bash
# Ubuntu/Debian
sudo ufw allow 3001/tcp

# CentOS/RHEL
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --reload
```

---

## 🌐 Cloud Deployment

### AWS EC2 Deployment

#### Step 1: Launch EC2 Instance
1. Launch Ubuntu 20.04+ instance
2. Configure security group to allow port 3001
3. Connect via SSH

#### Step 2: Setup
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Follow Docker deployment steps above
# Your system will be available at: http://your-ec2-public-ip:3001
```

### Google Cloud Platform

#### Step 1: Create VM Instance
```bash
# Create VM
gcloud compute instances create tennis-ranking \
    --zone=us-central1-a \
    --machine-type=e2-micro \
    --image-family=ubuntu-2004-lts \
    --image-project=ubuntu-os-cloud \
    --tags=tennis-ranking

# Configure firewall
gcloud compute firewall-rules create allow-tennis-ranking \
    --allow tcp:3001 \
    --source-ranges 0.0.0.0/0 \
    --target-tags tennis-ranking
```

#### Step 2: Deploy
```bash
# SSH to instance
gcloud compute ssh tennis-ranking --zone=us-central1-a

# Follow deployment steps above
```

### DigitalOcean Droplet

#### Step 1: Create Droplet
1. Create Ubuntu 20.04+ droplet
2. Add SSH key
3. Configure firewall to allow port 3001

#### Step 2: Deploy
```bash
# SSH to droplet
ssh root@your-droplet-ip

# Follow deployment steps above
```

---

## 🔒 Security Configuration

### SSL/HTTPS Setup (Optional but Recommended)

#### Option 1: Nginx Reverse Proxy with Let's Encrypt
```bash
# Install Nginx
sudo apt install nginx

# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Configure Nginx
sudo nano /etc/nginx/sites-available/tennis-ranking
```

Add this configuration:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
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

Enable and configure SSL:
```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/tennis-ranking /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com
```

### Environment Variables (Production)
```bash
# Create environment file
nano .env
```

Add:
```env
NODE_ENV=production
PORT=3001
CORS_ORIGIN=https://your-domain.com
RATE_LIMIT_WINDOW=15
RATE_LIMIT_MAX=100
```

---

## 📊 Monitoring and Maintenance

### Check System Status
```bash
# Docker deployment
docker-compose ps
docker-compose logs -f

# Node.js deployment
sudo systemctl status tennis-ranking
sudo journalctl -u tennis-ranking -f
```

### Backup Data
```bash
# Backup data folder
tar -czf tennis-ranking-backup-$(date +%Y%m%d).tar.gz data/

# Copy to safe location
scp tennis-ranking-backup-*.tar.gz user@backup-server:/backups/
```

### Update System
```bash
# Docker deployment
docker-compose pull
docker-compose up -d

# Node.js deployment
git pull origin main  # if using git
npm install
npm run build
sudo systemctl restart tennis-ranking
```

---

## 🎯 Network Sharing

### Share with Tennis Group
1. **Find your server IP**: `ip addr show` or `ifconfig`
2. **Share URL with group**: `http://your-server-ip:3001`
3. **Everyone uses same URL** - data syncs automatically!

### Custom Domain (Optional)
1. Purchase domain name
2. Point DNS A record to your server IP
3. Setup SSL certificate (see SSL section above)
4. Share: `https://your-domain.com`

---

## 🚨 Troubleshooting

### Port Already in Use
```bash
# Find process using port 3001
sudo lsof -i :3001

# Kill process if needed
sudo kill -9 PID
```

### Permission Issues
```bash
# Fix data folder permissions
sudo chown -R $USER:$USER data/
chmod 755 data/
```

### Service Won't Start
```bash
# Check logs
sudo journalctl -u tennis-ranking -n 50

# Check Node.js installation
node --version
npm --version
```

### Can't Access from Other Devices
1. Check firewall settings
2. Verify server IP address
3. Ensure service is running on 0.0.0.0, not 127.0.0.1

---

## ✅ Deployment Checklist

- [ ] Server prepared (Docker or Node.js installed)
- [ ] Project files uploaded
- [ ] Dependencies installed
- [ ] Service running and accessible
- [ ] Firewall configured (port 3001 open)
- [ ] Data folder writable
- [ ] SSL configured (if using domain)
- [ ] Backup system in place
- [ ] URL shared with tennis group

---

## 🆘 Need Help?

1. **Check logs** for error messages
2. **Verify all prerequisites** are met
3. **Test locally first** before deploying to server
4. **Check network connectivity** and firewall rules

**Your tennis ranking system should now be running at:**
`http://your-server-ip:3001`

**Everyone in your tennis group can access this URL to:**
- Record matches
- View rankings
- Track money owed
- Export/import data

**Data is automatically shared and synchronized!** 🎾
