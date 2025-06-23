# 🎾 Tennis Ranking System - Deployment Guide

## 📋 Overview
This guide will help you deploy and run the Tennis Ranking System on your own server or hosting platform. The system is a web-based application built with modern web technologies that can be deployed easily.

## 🛠️ System Requirements

### Minimum Requirements:
- **Node.js**: Version 18.0 or higher
- **NPM**: Version 8.0 or higher (comes with Node.js)
- **Operating System**: Windows 10/11, macOS 10.15+, or Linux (Ubuntu 18.04+)
- **RAM**: 2GB minimum, 4GB recommended
- **Storage**: 100MB free space
- **Internet**: Required for initial setup and package downloads

### Browser Compatibility:
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## 📥 Installation Guide

### Step 1: Download the Project
1. Download the project files to your server/computer
2. Extract the files to a folder (e.g., `tennis-ranking-system`)

### Step 2: Install Node.js
If you don't have Node.js installed:

**Windows:**
1. Go to [nodejs.org](https://nodejs.org)
2. Download the LTS version (recommended)
3. Run the installer and follow the setup wizard
4. Restart your computer

**macOS:**
```bash
# Using Homebrew (recommended)
brew install node

# Or download from nodejs.org
```

**Linux (Ubuntu/Debian):**
```bash
# Update package list
sudo apt update

# Install Node.js and npm
sudo apt install nodejs npm

# Verify installation
node --version
npm --version
```

### Step 3: Install Project Dependencies
Open terminal/command prompt in the project folder and run:

```bash
# Navigate to project directory
cd tennis-ranking-system

# Install dependencies
npm install
```

## 🚀 Deployment Options

### Option 1: Local Development Server (Recommended for Testing)

```bash
# Start development server
npm run dev

# The application will be available at:
# http://localhost:5173
```

**Pros:**
- Easy to set up
- Hot reload for development
- Perfect for testing

**Cons:**
- Only accessible on local machine
- Not suitable for production

### Option 2: Build and Deploy to Static Hosting

#### Build the Project:
```bash
# Create production build
npm run build

# Files will be generated in 'dist' folder
```

#### Deploy to Popular Platforms:

**Netlify (Free Tier Available):**
1. Create account at [netlify.com](https://netlify.com)
2. Drag and drop the `dist` folder to Netlify dashboard
3. Your site will be live with a custom URL

**Vercel (Free Tier Available):**
1. Create account at [vercel.com](https://vercel.com)
2. Connect your project repository or upload `dist` folder
3. Automatic deployment with custom domain

**GitHub Pages (Free):**
1. Upload your project to GitHub repository
2. Go to Settings > Pages
3. Select source as "Deploy from a branch"
4. Choose `gh-pages` or `main` branch with `/dist` folder

### Option 3: Traditional Web Server

If you have your own web server (Apache, Nginx, IIS):

1. Build the project: `npm run build`
2. Copy contents of `dist` folder to your web root directory
3. Configure your web server to serve static files
4. Access via your domain

#### Example Nginx Configuration:
```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/your/dist/folder;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## 🔧 Configuration

### Environment Setup
The application works out of the box with default settings. No additional configuration is required.

### File Storage Location
- **Default**: Browser's local storage + manual Excel export/import
- **Recommended**: Create a dedicated folder for Excel files in your project root
- **Data files**: Will be saved as `.xlsx` files when users export data

## 📱 Accessing the Application

Once deployed, users can access the application through:
- **Local**: `http://localhost:5173` (development)
- **Production**: Your custom domain or hosting URL

### First Time Setup:
1. Open the application in a web browser
2. Go to "Quản lý người chơi" (Player Management) tab
3. Add your first players
4. Start recording matches!

## 💾 Data Management

### Backup Strategy:
1. **Regular Excel Exports**: Users should regularly export data to Excel files
2. **File Organization**: Keep Excel files in a dedicated folder
3. **Version Control**: Use timestamped filenames for backups

### Data Recovery:
If data is lost, users can restore from Excel files using the "Tải dữ liệu từ Excel" (Load from Excel) feature.

## 🔒 Security Considerations

### For Public Deployment:
- Use HTTPS (SSL certificate)
- Consider password protection if needed
- Regular backups of Excel data files
- Monitor server resources

### For Private/Local Use:
- Ensure only authorized users have access
- Regular data backups
- Keep Node.js and dependencies updated

## 🚨 Troubleshooting

### Common Issues:

**1. "Command not found: npm"**
- Solution: Install Node.js properly and restart terminal

**2. "Port 5173 is already in use"**
- Solution: Stop other applications using the port or use different port:
  ```bash
  npm run dev -- --port 3000
  ```

**3. "Permission denied" on Linux/macOS**
- Solution: Use `sudo` for npm install or fix npm permissions:
  ```bash
  sudo chown -R $(whoami) ~/.npm
  ```

**4. Excel files not downloading**
- Solution: Check browser's download settings and permissions

**5. Application not loading**
- Check browser console for errors (F12)
- Ensure all files are uploaded correctly
- Verify web server configuration

## 📞 Support and Maintenance

### Regular Maintenance:
1. **Monthly**: Export data to Excel as backup
2. **Quarterly**: Update Node.js and dependencies if needed
3. **Annually**: Review and update hosting platform

### Getting Help:
- Check browser console for error messages (Press F12)
- Verify all files are properly uploaded
- Ensure web server is running
- Test in different browsers

### Updates:
When you receive updated project files:
1. Backup current Excel data
2. Replace old files with new ones
3. Run `npm install` if `package.json` changed
4. Rebuild and redeploy
5. Restore data from Excel backup

## 📊 Performance Optimization

### For Better Performance:
- Use a CDN for faster loading
- Enable gzip compression on web server
- Use HTTP/2 if available
- Optimize images and assets

### Resource Usage:
- **CPU**: Low usage, suitable for basic hosting
- **RAM**: ~50MB for Node.js development server
- **Bandwidth**: Minimal, mostly static files
- **Storage**: Grows with match history and player data

## 🎯 Production Checklist

Before going live:
- [ ] Test all features (add players, record matches, export data)
- [ ] Verify Excel export/import functionality
- [ ] Test on different devices and browsers
- [ ] Set up regular backup schedule
- [ ] Configure proper domain name
- [ ] Enable HTTPS if publicly accessible
- [ ] Test data recovery from Excel files
- [ ] Document access URLs for users

## 📞 Contact Information

For technical support or questions about deployment, please contact your development team or system administrator.

---

*This guide covers the most common deployment scenarios. For specific hosting platforms or custom requirements, additional configuration may be needed.*
