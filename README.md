# Tennis Doubles Ranking System

A web-based tennis doubles ranking system built with vanilla JavaScript and Vite. This application allows you to manage players, record matches, track rankings, and export data to Excel.

## Features

### 🎾 Player Management
- Add and remove players dynamically
- Support for around 8 players (flexible)
- Simple player management interface

### 🏆 Match Recording
- **Doubles format**: 2 vs 2 matches
- **Manual partner selection**: Players can choose their own partners
- **Score tracking**: Record match scores
- **Winner selection**: Mark winning team

### 📊 Ranking System
- **Point-based ranking**: Winners get 4 points, losers get 1 point
- **Comprehensive statistics**: Wins, losses, win rate
- **Money tracking**: Losers pay 20,000 VND each
- **Real-time updates**: Rankings update automatically

### 📋 Match History
- Complete match history with dates
- Team compositions and scores
- Winner identification
- Chronological order (newest first)

### 📁 Excel File Storage
- **Primary storage**: Local .xlsx files
- **Auto-save**: Automatically saves to Excel after changes
- **Load data**: Import existing Excel files
- **Backup**: Browser localStorage as fallback
- **Portable**: Take your data files anywhere

### 📁 Export Functionality
- **Excel export**: Export rankings and match history to .xlsx file
- **Multiple sheets**: Players, Matches, and Rankings data
- **Formatted data**: Ready for printing or sharing
- **File management**: Load and save data files easily

## Installation & Setup

1. **Clone or download** the project files
2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run development server**:
   ```bash
   npm run dev
   ```

4. **Build for production**:
   ```bash
   npm run build
   ```

## Usage

### Adding Players
1. Go to the "Quản lý người chơi" (Player Management) tab
2. Enter player name and click "Thêm" (Add)
3. Players will appear in the list below

### Recording Matches
1. Go to the "Trận đấu" (Matches) tab
2. Select 4 different players (2 for each team)
3. Enter match scores (optional)
4. Select the winning team
5. Click "Ghi nhận trận đấu" (Record Match)

### Viewing Rankings
1. Go to the "Xếp hạng" (Rankings) tab
2. See players ranked by points
3. View detailed statistics including money lost
4. Click "Xuất Excel" (Export Excel) to download data

### Match History
1. Go to the "Lịch sử" (History) tab
2. View all recorded matches
3. See team compositions, scores, and winners

### File Management
1. **Load Data**: Click "Tải dữ liệu từ Excel" to import existing Excel file
2. **Save Data**: Click "Lưu dữ liệu ra Excel" to export current data
3. **Auto-save**: Data automatically saves after each match/player change
4. **Reset**: Click "Xóa toàn bộ dữ liệu" to clear all data (Excel files remain safe)

## Scoring System

- **Winners**: Each player gets **4 points**
- **Losers**: Each player gets **1 point**
- **Money penalty**: Each loser pays **20,000 VND**

## Technical Details

- **Frontend**: Vanilla JavaScript (ES6+)
- **Build Tool**: Vite
- **Styling**: Modern CSS with responsive design
- **Storage**: Browser localStorage for data persistence
- **Export**: XLSX library for Excel file generation
- **Languages**: Vietnamese interface with English code

## Browser Support

- Modern browsers with ES6+ support
- Chrome, Firefox, Safari, Edge (latest versions)
- Mobile responsive design

## Data Storage

- **Primary storage**: Local Excel (.xlsx) files
- **Auto-save**: Data automatically saves to Excel files
- **Backup storage**: Browser localStorage for fallback
- **File management**: Load existing data from Excel files
- **Portable**: Data files can be shared and moved between computers
- **No server required**: Works completely offline

## Contributing

This is a custom project for tennis tournament management. Feel free to modify and extend based on your needs.

## License

This project is created for personal/commercial use as requested.
