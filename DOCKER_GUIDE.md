# 🐳 Tennis Ranking System - Docker Guide

## 🎯 Why Docker?

Docker makes deployment **super easy** by:
- ✅ **No Node.js installation needed** - Everything runs in a container
- ✅ **Consistent environment** - Works the same everywhere
- ✅ **Easy sharing** - Share the container with anyone
- ✅ **Automatic updates** - Simple container rebuilds
- ✅ **Isolated system** - Won't interfere with other software

## 🚀 Quick Start (Docker Method)

### Step 1: Install Docker
**Windows/Mac:**
1. Download Docker Desktop from [docker.com](https://docker.com/get-started)
2. Install and restart your computer
3. Make sure Docker Desktop is running

**Linux:**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install docker.io docker-compose
sudo usermod -aG docker $USER
# Log out and log back in
```

### Step 2: Setup Tennis System
**Windows:**
1. Double-click `docker-setup.bat`
2. Wait for container to build and start
3. Open http://localhost:3001

**Mac/Linux:**
1. Run `./docker-setup.sh` in terminal
2. Wait for container to build and start
3. Open http://localhost:3001

## 🛠️ Docker Commands

### Basic Operations:
```bash
# Start the system
docker-compose up -d

# Stop the system
docker-compose down

# Restart the system
docker-compose restart

# View logs
docker-compose logs -f

# Update the system (after code changes)
docker-compose up --build -d

# Check status
docker-compose ps
```

### Advanced Operations:
```bash
# Access container shell
docker-compose exec tennis-ranking sh

# View container details
docker inspect tennis-ranking-system

# Clean up (removes container and image)
docker-compose down --rmi all

# Backup data folder
tar -czf tennis-backup.tar.gz data/
```

## 📁 File Structure

```
tennis-ranking-system/
├── Dockerfile                    ← Container configuration
├── docker-compose.yml           ← Multi-container setup
├── docker-setup.sh              ← Linux/Mac setup script
├── docker-setup.bat             ← Windows setup script
├── .dockerignore                 ← Files to exclude from container
├── data/                         ← Excel data files (shared with container)
│   └── tennis-data_*.xlsx        ← Your tournament data
└── ... (other project files)
```

## 🌐 Network Sharing

### Share with Your Tennis Group:

1. **Find your IP address:**
   ```bash
   # Windows
   ipconfig
   
   # Mac/Linux
   ifconfig
   ```

2. **Share the URL:**
   - Give your group: `http://YOUR-IP:3001`
   - Everyone on the same network can access it

3. **Firewall Settings:**
   - Windows: Allow port 3001 through Windows Firewall
   - Mac: System Preferences > Security > Firewall > Options
   - Linux: `sudo ufw allow 3001`

## 🔧 Configuration Options

### Environment Variables:
Create a `.env` file to customize settings:
```env
PORT=3001
NODE_ENV=production
```

### Port Changes:
To use a different port, edit `docker-compose.yml`:
```yaml
ports:
  - "8080:3001"  # Change 8080 to your preferred port
```

### Memory Limits:
Add memory limits to `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      memory: 512M
    reservations:
      memory: 256M
```

## 🚨 Troubleshooting

### Common Issues:

**1. "Docker is not installed"**
- Install Docker Desktop from docker.com
- Restart computer after installation
- Make sure Docker Desktop is running

**2. "Port 3001 already in use"**
- Change port in `docker-compose.yml`
- Or stop the conflicting service

**3. "Permission denied"**
- Linux: Add user to docker group: `sudo usermod -aG docker $USER`
- Windows: Run as Administrator

**4. "Container won't start"**
- Check logs: `docker-compose logs`
- Try rebuilding: `docker-compose up --build`
- Check disk space: `docker system df`

**5. "Data not persisting"**
- Ensure `./data` folder exists
- Check volume mapping in `docker-compose.yml`

**6. "Can't access from other devices"**
- Check firewall settings
- Ensure all devices on same network
- Verify IP address is correct

### Debugging Commands:
```bash
# Check container logs
docker-compose logs tennis-ranking

# Check container health
docker-compose ps

# Access container shell
docker-compose exec tennis-ranking sh

# Check system resources
docker system df
docker system prune  # Clean up unused containers/images
```

## 🔄 Updates and Maintenance

### Updating the System:
1. Stop the current container: `docker-compose down`
2. Get updated files from your developer
3. Rebuild: `docker-compose up --build -d`

### Backup Strategy:
```bash
# Backup data folder
tar -czf tennis-backup-$(date +%Y%m%d).tar.gz data/

# Backup entire project
tar -czf tennis-full-backup-$(date +%Y%m%d).tar.gz .
```

### Monitoring:
```bash
# Check container stats
docker stats tennis-ranking-system

# Monitor logs in real-time
docker-compose logs -f --tail=50
```

## 🌟 Advantages of Docker Deployment

### For You (Developer):
- ✅ Consistent deployment across all environments
- ✅ Easy to distribute to customers
- ✅ No dependency conflicts
- ✅ Simple updates and rollbacks

### For Customer:
- ✅ No Node.js installation required
- ✅ One-command setup
- ✅ Isolated from other software
- ✅ Easy to share with tennis group
- ✅ Professional deployment

### For Tennis Group:
- ✅ Reliable system that "just works"
- ✅ Same experience for everyone
- ✅ Easy network sharing
- ✅ Automatic data persistence

## 📞 Support

### Self-Help:
1. Check container logs: `docker-compose logs`
2. Verify Docker is running: `docker ps`
3. Test network connectivity: `ping localhost`
4. Check disk space: `df -h` (Linux/Mac) or `dir` (Windows)

### Getting Help:
- Include output from `docker-compose logs`
- Mention your operating system
- Share any error messages
- Check if Docker Desktop is running

---

*Docker deployment makes your tennis ranking system enterprise-ready! 🏆*
