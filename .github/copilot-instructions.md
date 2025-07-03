<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

# Tennis Ranking System - Copilot Instructions

This is a web-based tennis doubles ranking system with the following key features:

## System Requirements:
- **Players**: Around 8 players (flexible to add/remove)
- **Format**: Doubles tennis (2 vs 2)
- **Pairing**: Manual partner selection
- **Scoring**: Winners get 4 points each, losers get 1 point each
- **Money tracking**: Losers pay 20,000 VND each
- **Tournament**: Custom tournament format

## Technical Stack:
- **Frontend**: Vanilla JavaScript with Vite
- **Storage**: Local Storage (posgreSQL)
- **Export**: XLSX library for Excel export
- **UI**: Responsive design with modern CSS

## Key Features:
1. Player management (add/remove players)
2. Match recording with manual partner selection
3. Point-based ranking system
4. Match history tracking
5. Money lost tracking
6. Export rankings to Excel (.xlsx)
7. Responsive web interface
8. Data saved in to posgreSQL database
## Code Guidelines:
- Use modern JavaScript (ES6+)
- Implement responsive design
- Use local storage for data persistence
- Follow clean code principles
- Add proper error handling
- Include Vietnamese language support where needed

# Tennis Ranking System - Copilot Instructions

This is a comprehensive web-based tennis doubles ranking system with authentication, shared data, and deployment capabilities.

## System Requirements:
- **Players**: Flexible player management (add/remove dynamically)
- **Format**: Doubles tennis (2 vs 2)
- **Pairing**: Manual partner selection for each match
- **Scoring**: Winners get 4 points each, losers get 1 point each
- **Money tracking**: Losers pay 20,000 VND each
- **Authentication**: Public viewing, admin login for management
- **Data**: Shared data across multiple users via server

## Technical Stack:
- **Frontend**: Vanilla JavaScript (ES6+) with Vite build system
- **Backend**: Node.js + Express with ES modules
- **Authentication**: JWT + bcrypt + express-session
- **Storage**: Excel files (.xlsx) using ExcelJS library
- **Security**: Helmet, CORS, rate limiting, input validation
- **Deployment**: Docker + native deployment options
- **UI**: Responsive CSS design with Vietnamese language support

## Project Structure:

### Core Application Files:
- `index.html` - Main HTML layout with authentication classes
- `src/main.js` - Frontend JavaScript with TennisRankingSystem class
- `src/style.css` - Responsive CSS with authentication UI styles
- `server.js` - Express server with authentication middleware
- `package.json` - Dependencies and scripts
- `.env` - Environment variables and admin credentials

### Configuration Files:
- `vite.config.js` - Build configuration
- `.dockerignore` - Docker exclusions
- `.gitignore` - Git exclusions

### Deployment Files:
- `Dockerfile` - Multi-stage Docker container
- `docker-compose.yml` - Container orchestration
- `setup.sh` / `setup.bat` - Local setup scripts
- `deploy-cloudflare.sh` - Cloudflare Tunnel deployment
- `start-production.sh` - Production startup script
- `docker-setup.sh` / `docker-setup.bat` - Docker deployment scripts

### Documentation:
- `START_HERE.md` - Quick start guide
- `CUSTOMER_SETUP_GUIDE.md` - End-user instructions
- `DEPLOYMENT_GUIDE.md` - Technical deployment guide
- `DOCKER_GUIDE.md` - Docker-specific instructions
- `SECURITY_GUIDE.md` - Security best practices
- `SECURITY_REPORT.md` - Security audit results
- `AUTHENTICATION_GUIDE.md` - Authentication system docs
- `DELIVERY_CHECKLIST.md` - Final delivery checklist

## Main Class: TennisRankingSystem

### Core Properties:
- `players[]` - Array of player objects with id, name, points, wins, losses, moneyLost
- `matches[]` - Array of match objects with teams, scores, winner, timestamp
- `currentFileName` - Current Excel file name for data persistence
- `serverMode` - Boolean indicating if server is available for shared data
- `isAuthenticated` - Boolean indicating if user is logged in as admin
- `user` - Current user object with username, email, role
- `authToken` - JWT token for authentication
- `apiBase` - Base URL for API endpoints

### Authentication Methods:
- `checkAuthStatus()` - Verify current authentication status with server
- `login(username, password)` - Authenticate user and get JWT token
- `logout()` - Clear authentication and update UI
- `updateUIForAuthStatus()` - Show/hide UI elements based on auth status
- `updateAuthHeader()` - Update header with login/logout controls
- `showLoginModal()` - Display login form modal

### Player Management:
- `addPlayer()` - Add new player with validation
- `removePlayer(playerId)` - Remove player and update all data
- `renderPlayers()` - Display player list with auth-aware delete buttons
- `updatePlayerSelects()` - Populate match form dropdowns

### Match Management:
- `recordMatch()` - Record new match with validation and point calculation
- `renderMatchHistory()` - Display chronological match history
- `calculateMatchPoints(isWinner)` - Calculate points (4 for win, 1 for loss)

### Ranking System:
- `renderRankings()` - Display sorted rankings table
- `calculateWinPercentage(wins, losses)` - Calculate win percentage
- `formatMoney(amount)` - Format VND currency display
- `showDatabaseInfo()` - Display system statistics modal

### Data Persistence:
- `saveToLocalStorage()` - Save data to browser storage
- `loadFromLocalStorage()` - Load data from browser storage
- `saveToServer()` - Save Excel data to server (admin only)
- `loadFromServer()` - Load latest Excel data from server
- `autoSave()` - Automatic data saving
- `detectServerMode()` - Check if server is available

### Excel Integration:
- `createExcelData()` - Generate Excel workbook with players and matches sheets
- `parseExcelData(base64Data)` - Parse Excel file and update system data
- `exportToExcel()` - Export current data to Excel file
- `loadFromExcel(file)` - Import data from uploaded Excel file

### UI Management:
- `init()` - Initialize system, check auth, load data
- `setupEventListeners()` - Bind all event handlers
- `switchTab(tabName)` - Handle tab navigation
- `updateFileStatus(message, type)` - Display status messages
- `resetDatabase()` - Clear all data with confirmation

## Server API Endpoints:

### Authentication (server.js):
- `POST /api/auth/login` - Admin login with rate limiting
- `POST /api/auth/logout` - Logout and destroy session
- `GET /api/auth/status` - Check authentication status

### Data Management:
- `GET /api/files` - List Excel files (public)
- `GET /api/load-excel/:fileName` - Load specific Excel file (public)
- `GET /api/current-data/:fileName?` - Get latest data file (public)
- `POST /api/save-excel` - Save Excel file (admin only)
- `DELETE /api/delete-excel/:fileName` - Delete Excel file (admin only)

### Security Middleware:
- `authenticateToken()` - JWT token validation
- `checkAuth()` - Optional authentication check
- `handleValidationErrors()` - Input validation error handling
- `sanitizeFileName()` - File name security sanitization
- Rate limiting for general, API, auth, and upload endpoints
- CORS configuration with domain whitelist
- Helmet security headers
- Express session management

## Key Features:

### 1. Authentication System:
- **Public Access**: View rankings and match history only
- **Admin Access**: Full player and match management
- **Default Credentials**: admin / tennis2024! (changeable in .env)
- **Security**: JWT tokens, bcrypt password hashing, session management
- **Rate Limiting**: 5 login attempts per 15 minutes per IP

### 2. Player Management:
- Add players with duplicate name prevention
- Remove players (removes from all historical matches)
- Real-time statistics calculation
- Persistent storage across sessions

### 3. Match Recording:
- Manual team selection (4 different players required)
- Score input with validation
- Winner selection
- Automatic point calculation (4 for winners, 1 for losers)
- Money tracking (20,000 VND per loss)
- Match history with timestamps

### 4. Ranking System:
- Point-based leaderboard
- Win/loss statistics
- Win percentage calculation
- Money lost tracking
- Real-time updates

### 5. Data Persistence:
- **Local Mode**: Browser localStorage for single-user
- **Server Mode**: Shared Excel files for multi-user
- **Import/Export**: Excel file compatibility
- **Backup**: Automatic timestamped backups

### 6. Security Features:
- Environment-based configuration
- Input validation and sanitization
- File path security checks
- CORS protection
- Security headers
- Rate limiting
- Non-root Docker user

## CSS Classes and Styling:

### Authentication Classes:
- `.edit-only` - Hidden for non-authenticated users
- `.auth-section` - Header authentication controls
- `.login-section` - Login button area
- `.user-info` - Logged-in user display
- `.modal` - Login modal overlay
- `.guest-info` - Information box for public users

### UI Components:
- `.tabs` / `.tab-button` / `.tab-content` - Tab navigation system
- `.player-card` - Individual player display cards
- `.match-form` - Match recording form layout
- `.rankings-table` - Leaderboard table styling
- `.file-management` - Excel import/export controls
- `.status-message` - System status notifications

### Responsive Design:
- Mobile-first approach with breakpoints
- Flexible grid layouts
- Touch-friendly button sizing
- Responsive tables with horizontal scroll

## Environment Variables (.env):

### Authentication:
- `ADMIN_USERNAME` - Default admin username
- `ADMIN_PASSWORD` - Default admin password (change in production!)
- `ADMIN_EMAIL` - Admin email address
- `JWT_SECRET` - JWT signing secret
- `SESSION_SECRET` - Session encryption secret

### Server Configuration:
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment mode (production/development)
- `ALLOWED_ORIGINS` - Comma-separated list of allowed CORS origins

### Security Settings:
- `RATE_LIMIT_WINDOW_MS` - Rate limiting window
- `RATE_LIMIT_MAX_REQUESTS` - Max requests per window
- `RATE_LIMIT_API_MAX` - Max API requests per window

## Deployment Options:

### 1. Local Development:
```bash
npm install
npm run build
npm start
```

### 2. Production Server:
```bash
./deploy-cloudflare.sh
npm run server
```

### 3. Docker Deployment:
```bash
docker build -t tennis-ranking .
docker run -p 3001:3001 tennis-ranking
```

### 4. Docker Compose:
```bash
docker-compose up -d
```

## Code Guidelines:

### JavaScript:
- Use ES6+ modules and syntax
- Async/await for asynchronous operations
- Proper error handling with try/catch
- Class-based architecture for main system
- Event-driven UI updates
- Input validation on both client and server
- JWT token management for authentication

### CSS:
- Mobile-first responsive design
- CSS custom properties for theming
- Flexbox and Grid for layouts
- Smooth transitions and animations
- Consistent spacing and typography
- Accessible color schemes

### Security:
- Never store secrets in code
- Use environment variables for configuration
- Validate all user inputs
- Sanitize file names and paths
- Implement proper authentication flows
- Use HTTPS in production
- Regular security audits

### Error Handling:
- Graceful degradation from server to local mode
- User-friendly error messages
- Console logging for debugging
- Status message system for user feedback
- Validation error display
- Network error recovery

## Testing Scenarios:

### Authentication Testing:
1. Access without login (should show rankings only)
2. Login with correct credentials (should show all features)
3. Login with incorrect credentials (should show error)
4. Logout (should return to public view)
5. Token expiration handling

### Data Management Testing:
1. Add/remove players
2. Record matches with various scenarios
3. Import/export Excel files
4. Server mode vs local mode switching
5. Data persistence across browser sessions

### Security Testing:
1. CORS policy enforcement
2. Rate limiting on login attempts
3. Input validation on all forms
4. File upload security
5. JWT token validation

## Troubleshooting:

### Common Issues:
- **CORS errors**: Check ALLOWED_ORIGINS in .env
- **Build failures**: Ensure all dependencies installed
- **Authentication failures**: Verify .env credentials
- **File not found**: Check dist/ directory exists
- **Database errors**: Verify data/ directory permissions

### Debug Mode:
- Check browser console for client errors
- Check server logs for API errors
- Verify network requests in browser dev tools
- Test API endpoints directly with curl/Postman

## Vietnamese Language Support:
- All UI text in Vietnamese
- Vietnamese number and currency formatting
- Proper encoding for Vietnamese characters
- Excel export with Vietnamese headers
- Date/time formatting in Vietnamese locale

This system provides a complete tennis ranking solution with modern web technologies, security best practices, and multiple deployment options. The code is maintainable, scalable, and ready for production use.
