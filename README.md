# Tennis Doubles Ranking System

A full-stack web application for managing tennis doubles matches, rankings, and seasons. Built with vanilla JavaScript (Vite), Express, PostgreSQL, and Redis.

## Features

### 🎾 Player Management
- Add and remove players dynamically
- Per-season player rosters

### 🏆 Match Recording
- **Doubles & Singles**: 2v2 or 1v1 matches
- **Manual partner selection**: Players choose their own partners
- **Score tracking** with winner selection

### 📊 Ranking System
- **Point-based ranking**: Winners get 4 points, losers get 1 point
- **Multi-season support**: Track rankings per season, by date, and lifetime
- **Form tracking**: Recent win/loss streaks (phong độ)
- **Money tracking**: Configurable loss penalty (default 20,000 VND)
- **Real-time updates**: Rankings update via SSE push

### 📅 Season Management
- Multiple concurrent active seasons
- Auto-end by date, manual end/reactivate
- Per-season player rosters and configurable loss penalty

### 📁 Export & Backup
- **Excel export**: Rankings, matches, and statistics to `.xlsx`
- **JSON backup/restore**: Full database backup including users
- **Date/season/lifetime** export modes

### 🔒 Security
- JWT authentication with AES-256-GCM encrypted httpOnly cookies
- CSRF protection (HMAC-derived secrets)
- bcrypt password hashing (14 rounds)
- Role-based access (admin / editor)
- Helmet security headers, rate limiting

---

## Quick Start

### Option 1: Docker (Recommended)

```bash
cp .env.example .env    # Configure environment variables
docker compose up -d    # Start app + PostgreSQL + Redis
```

The app will be available at `http://localhost:3001`.

### Option 2: Local Development

```bash
# Start database services
docker compose up -d postgres redis

# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Start dev servers (Vite + Express concurrently)
npm run dev-full
```

Frontend: `http://localhost:5173` | API: `http://localhost:3001`

### Option 3: PM2 (Production)

```bash
npm run build
pm2 start ecosystem.config.cjs --env production
```

---

## Project Structure

```
├── config/              # Environment & cookie configuration
├── lib/                 # Core libraries (Redis cache, JWT encryption)
├── middleware/           # Express middleware (auth, CSRF, compression, rate-limit)
├── routes/              # API route modules
├── migrations/          # SQL migrations
├── tests/               # Vitest test suite
├── src/                 # Frontend (Vite SPA)
├── server.js            # Express app entry point (~340 lines)
├── database-postgresql.js  # Database schema & queries
├── ecosystem.config.cjs # PM2 cluster configuration
├── Dockerfile           # Multi-stage Docker build
└── docker-compose.yml   # Full-stack deployment
```

For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

---

## Deployment

| Mode | Command | Notes |
|------|---------|-------|
| **Docker** | `docker compose up -d` | Full stack, recommended |
| **PM2** | `pm2 start ecosystem.config.cjs` | Cluster mode, requires external PG + Redis |
| **Bare metal** | `NODE_ENV=production node server.js` | Single process |
| **Development** | `npm run dev-full` | Vite HMR + Express |

### Environment Variables

See [`.env.example`](.env.example) for all available configuration options.

Key variables:
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — PostgreSQL connection
- `REDIS_URL` — Redis connection
- `JWT_SECRET`, `CSRF_SECRET` — Security secrets (required)
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — System admin credentials (required)
- `EDITOR_USERNAME`, `EDITOR_PASSWORD` — System editor credentials (required)

---

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check (Docker HEALTHCHECK) |
| `GET /api/init` | Optional | Bootstrap data for frontend |
| `POST /api/auth/login` | No | Login, returns httpOnly cookies |
| `GET /api/players` | Optional | List players |
| `GET /api/seasons` | Optional | List seasons |
| `GET /api/matches` | Optional | List matches |
| `GET /api/rankings/lifetime` | Optional | Lifetime rankings |
| `GET /api/export-excel` | Auth | Export to Excel |
| `GET /api/backup` | Admin | Full JSON backup |
| `POST /api/restore` | Admin | Restore from backup |
| `GET /api/events` | Optional | SSE real-time updates |

---

## Testing

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:watch    # Watch mode
```

---

## Tech Stack

- **Frontend**: Vanilla JS (ES6+), Vite, CSS custom properties
- **Backend**: Node.js, Express
- **Database**: PostgreSQL 15
- **Cache**: Redis 7 (with stampede protection)
- **Auth**: JWT + bcrypt + AES-256-GCM
- **Deploy**: Docker, PM2, or bare metal

## License

This project is created for personal/commercial use.
