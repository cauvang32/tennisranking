# 🎾 Tennis Ranking System - Customer Quick Start Guide

## 🎯 What You're Getting
A complete web-based tennis doubles ranking system with **SHARED DATA** that will:
- Track your tennis group's matches and rankings **with everyone seeing the same data**
- Calculate points automatically (winners get 4 points, losers get 1 point)
- Track money owed (losers pay 20,000 VND each)
- **Automatically save data** to Excel files in the `/data` folder
- **Share data across all devices** - phones, tablets, computers
- Work on your local network so everyone can access it

## 🌟 NEW: Shared Data Features
✅ **All users see the same data** - Perfect for tournaments!  
✅ **Automatic saves** - Data saved to `/data` folder instantly  
✅ **No more manual exports** - Everything is automatic  
✅ **Network sharing** - Share with your whole tennis group  
✅ **Real-time updates** - Add a match, everyone sees it immediately  

## 🏃‍♂️ Quick Setup (3 Steps)

### Step 1: Install Node.js (One-time setup)
1. Go to **nodejs.org** in your web browser
2. Click the big green "Download" button (choose LTS version)
3. Run the downloaded file and click "Next" through the installer
4. **Restart your computer** after installation

### Step 2: Setup Your Tennis System
1. Extract the provided project files to a folder on your computer
2. Open "Command Prompt" (Windows) or "Terminal" (Mac/Linux)
3. Navigate to your project folder:
   ```
   cd path/to/your/tennis-ranking-system
   ```
4. Install the system:
   ```
   npm install
   ```

### Step 3: Start Your Shared System
Run this command whenever you want to use the system:
```
npm start
```

Then open your web browser and go to: **http://localhost:3001**

## 🌐 Sharing with Your Tennis Group

### For Your Tennis Group:
1. **Find your computer's IP address**:
   - Windows: Open Command Prompt, type `ipconfig`, look for "IPv4 Address"
   - Mac: System Preferences > Network > Advanced > TCP/IP
   - Linux: Terminal, type `ip addr show`

2. **Share this address** with your tennis group:
   ```
   http://YOUR-IP-ADDRESS:3001
   ```
   Example: `http://192.168.1.100:3001`

3. **Everyone can access** the same data from their phones/computers!

### Network Setup Tips:
- **Same WiFi**: Everyone must be on the same WiFi network
- **Firewall**: May need to allow port 3001 through firewall
- **Router**: Some routers block this - check router settings if needed

## 📱 How to Use the System

### First Time Setup:
1. Click on "Quản lý người chơi" (Player Management) tab
2. Add all your tennis players using the "Thêm người chơi" button
3. You're ready to start recording matches!

### Recording a Match:
1. Go to "Ghi nhận trận đấu" (Record Match) tab
2. Select 4 players for the doubles match
3. Click "Tạo trận đấu" to set up teams
4. Select the winning team
5. Click "Lưu kết quả" to save

### Viewing Rankings:
- Click "Bảng xếp hạng" (Rankings) tab to see:
  - Current point standings
  - Money owed by each player
  - Win/loss records

### Match History:
- Click "Lịch sử trận đấu" (Match History) tab to:
  - See all past matches
  - Edit or delete matches if needed
  - View detailed statistics

## 💾 Data Management (Now Automatic!)

### 🎉 No More Manual Backups!
- **Automatic saving**: Data is saved instantly to `/data` folder
- **Shared access**: Everyone sees the same data immediately
- **Excel files**: Automatically created with timestamps
- **Version history**: Multiple backup files kept automatically

### Where Your Data Lives:
1. **Primary Storage**: `/data` folder in your project
2. **File Format**: Excel (.xlsx) files with timestamps
3. **Backup**: Browser localStorage as secondary backup
4. **Access**: All users share the same data files

### Data Recovery:
- **Automatic**: System always loads the latest data file
- **Manual**: If needed, you can load specific Excel files from `/data` folder
- **Backup files**: Multiple timestamped versions kept for safety

## 🔒 Security & Network

### For Local Network Use:
- **Safe sharing**: Only people on your WiFi can access
- **No internet required**: Works completely offline once set up
- **Private data**: Data stays on your computer, not in the cloud

### For Public Access (Advanced):
If you want internet access, see the detailed DEPLOYMENT_GUIDE.md for hosting options.

## 🚨 Important Tips

### DO's:
✅ **Keep the server running** - Don't close the terminal/command window  
✅ **Share your IP address** - Let your tennis group access the same data  
✅ **Test with friends** - Add test players and try recording matches  
✅ **Check the /data folder** - See your Excel files being created automatically  

### DON'Ts:
❌ **Don't close the terminal** - This stops the server and sharing  
❌ **Don't delete /data folder** - This is where all your data is stored  
❌ **Don't modify Excel files manually** - Let the system manage them  
❌ **Don't use multiple systems** - Stick to one server for your group  

## 🆘 Common Issues & Solutions

### "Command not found: npm"
**Problem**: Node.js not installed properly  
**Solution**: Reinstall Node.js from nodejs.org and restart computer

### "Port already in use"
**Problem**: Another program is using port 3001  
**Solution**: Stop other programs or restart your computer

### Excel files not being created
**Problem**: Permission issues with /data folder  
**Solution**: Check if /data folder exists and has write permissions

### "Cannot access from other devices"
**Problem**: Firewall or network settings  
**Solution**: 
- Check Windows firewall settings for port 3001
- Ensure all devices are on the same WiFi network
- Try disabling firewall temporarily to test

### Data not syncing between devices
**Problem**: Using different servers or cached data  
**Solution**: 
- Ensure everyone is accessing the same IP address
- Refresh browser pages (Ctrl+F5 or Cmd+Shift+R)
- Check that server is still running

## 📞 Getting Help

### Self-Help Checklist:
1. ✅ Is Node.js installed? (`node --version` in terminal)
2. ✅ Did you run `npm install` in the project folder?
3. ✅ Is the server running? (`npm start` should show "Server running...")
4. ✅ Are you using the correct web address? (http://localhost:3001)
5. ✅ Can you see the /data folder in your project directory?
6. ✅ Are all devices on the same WiFi network?

### Technical Support:
If you need help:
1. Take a screenshot of any error messages
2. Note what you were trying to do when the problem occurred
3. Check if the /data folder has Excel files
4. Try accessing from the host computer first, then other devices
5. Contact your technical support person with these details

## 🎉 You're Ready!

Your tennis ranking system is now ready for **SHARED GROUP USE**! Start by:
1. Adding your regular players
2. Recording a few test matches
3. Sharing your IP address with the tennis group
4. Everyone can now access the same data in real-time!

**Remember**: Keep the server running, and everyone will always see the latest data automatically saved to Excel files!

---

*Need the full technical details? See "DEPLOYMENT_GUIDE.md" for advanced deployment options and detailed troubleshooting.*
