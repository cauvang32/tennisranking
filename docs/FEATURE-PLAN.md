# Feature Implementation Plan — Tennis Ranking System

> Generated: 2026-07-08
> Scope: 3 major feature areas across backend (PostgreSQL + Express), frontend (vanilla JS SPA), and DevOps

---

## Current Architecture Summary

| Layer | Tech | Key Files |
|-------|------|-----------|
| **Database** | PostgreSQL 15 | `database-postgresql.js` (~1200 lines) |
| **Cache** | Redis 7 (ioredis) | `lib/redis-cache.js` |
| **Backend** | Express 5 (ESM) | `server.js` (orchestrator) → `routes/*.js` (factories) |
| **Frontend** | Vanilla JS + Vite 8 SPA | `src/main.js` (~4000 lines), `index.html`, `src/style.css` |
| **Auth** | JWT (HS256) + AES-256-GCM cookie encryption | `lib/jwt-encryption.js`, `middleware/auth.js` |
| **Deployment** | Docker Compose (PG + Redis) / PM2 cluster | `docker-compose.yml`, `ecosystem.config.cjs` |
| **Media** | Static files in `public/` → `dist/` via Vite build | `public/image.png` (hero banner) |

**Critical patterns to preserve:**
- Router factory injection (deps passed in, never imported)
- Three-tier cache (PG → Redis → Client) with NOTIFY-based invalidation
- `sanitizeResponse()` on all API responses
- `asyncHandler()` wrapper on all async routes
- CSRF + rate-limiting on all mutations
- Vietnamese UI labels, English code/comments

---

## Feature 1: Self-Service Image Editor

### Goal
Allow administrators to upload and update website images (hero banner, logo, etc.) independently without technical support or file system access.

### Database Changes

**New table: `site_images`**

```sql
CREATE TABLE site_images (
  id            SERIAL PRIMARY KEY,
  key           VARCHAR(64) UNIQUE NOT NULL,  -- e.g. 'hero_banner', 'logo', 'favicon'
  filename      VARCHAR(255) NOT NULL,         -- original filename
  storage_path  VARCHAR(512) NOT NULL,         -- relative path under uploads/
  content_type  VARCHAR(64) NOT NULL,          -- image/png, image/jpeg, image/webp
  file_size     INTEGER NOT NULL,              -- bytes
  alt_text      VARCHAR(255) DEFAULT '',       -- accessibility
  is_active     BOOLEAN DEFAULT true,          -- toggle visibility
  uploaded_by   VARCHAR(255),
  uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_site_images_key_active ON site_images(key, is_active);
```

**Keys to pre-seed:**
- `hero_banner` — the main banner image (replaces hardcoded `/image.png`)
- `logo` — site logo (replaces emoji 🎾)
- `favicon` — browser tab icon
- `background` — optional page background image

### Backend Changes

**New route file: `routes/images.js`**

```
GET  /api/images              — List all active site images (cached)
GET  /api/images/:key         — Get single image by key
GET  /api/images/:key/file    — Serve the actual image file (cached 1 year)
POST /api/images/:key         — Upload/replace image (admin only, multer)
PUT  /api/images/:key/meta    — Update alt_text, is_active (admin only)
POST /api/images/migrate-hero — One-time migration: copy public/image.png into DB
```

**Key implementation details:**
- Use `multer` for file upload (already in `package.json` deps)
- Store files in `data/uploads/images/` directory (Docker volume mounted)
- Max file size: 10MB per image
- Allowed MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/svg+xml`
- Old file cleanup on replace (delete previous storage_path)
- Image served through Express static route with long cache headers
- Cache invalidation: `rankingsCache.invalidateOnImageChange()` on upload/update

**Server wiring (`server.js`):**
```js
import { createImageRouter } from './routes/images.js'
// ...
app.use('/api/images', createImageRouter(routeCtx))
// Serve uploaded images
app.use('/uploads', express.static(join(__dirname, 'data/uploads'), {
  maxAge: '365d',
  setHeaders: (res, path) => { res.setHeader('X-Content-Type-Options', 'nosniff') }
}))
```

**Migration script: `migrations/08-add-site-images.sh`**
- Creates `site_images` table
- Seeds `hero_banner` row pointing to existing `public/image.png`
- Creates `data/uploads/images/` directory if needed

### Frontend Changes

**New UI: Image Editor Panel** (inside admin-only section, new tab or section in accounts tab)

```
📸 Quản Lý Hình Ảnh
├── Banner Trang Chủ
│   ├── Preview hiện tại (thumbnail)
│   ├── Nút "Thay đổi hình ảnh" → file picker
│   ├── Ô nhập "Văn bản thay thế (alt text)"
│   ├── Nút "Lưu" / "Xóa"
│   └── Trạng thái: Kích thước, ngày tải lên
├── Logo Trang Web
│   └── (same structure)
├── Favicon
│   └── (same structure)
└── Hình Nền (tùy chọn)
    └── (same structure)
```

**Implementation in `src/main.js`:**
- New function: `loadSiteImages()`, `uploadSiteImage(key, file, altText)`, `updateImageMeta(key, meta)`
- Drag-and-drop + click-to-upload with preview
- Client-side image validation (size, type) before upload
- Toast notification on success/error
- Image preview uses the new `/api/images/:key/file` endpoint

**Hero banner integration:**
- Replace hardcoded `<img src="/image.png">` with dynamic fetch from `/api/images/hero_banner/file`
- Fallback to `/image.png` if no image in DB (graceful degradation)

**CSS changes (`src/style.css`):**
- Image editor panel styling
- Drag-and-drop zone styling
- Preview thumbnail styling

### Docker/Deployment Changes

**`docker-compose.yml`** — Add volume for uploads:
```yaml
volumes:
  - ./data/uploads:/app/data/uploads
```

**`.dockerignore`** — Exclude `data/uploads/` from build context (already exists, add entry)

---

## Feature 2: Tournament Management Enhancements

### 2A. Post-Tournament Updates — "Final Tournament Results" Text Field

#### Database Changes

Add columns to existing `seasons` table:

```sql
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS final_results TEXT;
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS conclusion_image_path VARCHAR(512);
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS conclusion_image_filename VARCHAR(255);
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS conclusion_image_size INTEGER;
```

**Migration script: `migrations/09-add-season-results.sh`**

#### Backend Changes

**`database-postgresql.js`:**
- Add `final_results`, `conclusion_image_path` to `SEASON_SELECT_COLS` fragment
- Update `createSeason()`, `updateSeason()` to accept these fields
- Add `updateSeasonResults()` method for partial updates
- Add `uploadSeasonConclusionImage()` method (multer-based, stores to `data/uploads/seasons/:seasonId/`)

**`routes/seasons.js` — New/updated endpoints:**

```
PUT  /api/seasons/:id/results       — Update final_results text
POST /api/seasons/:id/conclusion-image — Upload conclusion image (admin only)
DELETE /api/seasons/:id/conclusion-image — Remove conclusion image
GET  /api/seasons/:id/conclusion-image — Serve conclusion image
```

**`routes/images.js`** — Add seasonal image serving under `/uploads/seasons/`

#### Frontend Changes

**Seasons tab enhancement:**
- Each season card in the grid shows a "Kết quả cuối cùng" (Final Results) section when the season is ended
- For ended seasons, add an editable textarea for "Kết quả giải đấu" (Tournament Results)
- Add "Tải lên hình ảnh tổng kết" (Upload Conclusion Image) button
- Preview of conclusion image in the season card

**Season modal update:**
- Add "Kết quả cuối cùng" textarea to the season edit modal (only shown for ended seasons)
- Add file upload for conclusion image

**`src/main.js` changes:**
- `loadSeasons()` — display final_results and conclusion_image in season cards
- `updateSeasonResults(seasonId, finalResults)` — API call
- `uploadConclusionImage(seasonId, file)` — API call with progress
- `deleteConclusionImage(seasonId)` — API call
- Update season card HTML template to include results section

---

### 2B. Automated Tournament/Cup Brackets

This is the most complex feature. It introduces a new concept: **Cup Tournaments** — separate from the existing league/season format.

#### New Data Model

**Concept:** A "Cup" is a knockout tournament within or across seasons. It has its own structure, regulations, and bracket.

**New tables:**

```sql
-- Cup tournaments (knockout format)
CREATE TABLE cups (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  season_id         INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
  format            VARCHAR(20) NOT NULL DEFAULT 'single_elimination',
                     -- single_elimination, double_elimination, round_robin
  num_teams         INTEGER NOT NULL DEFAULT 8,  -- 4, 8, 16, 32
  regulation_text   TEXT,                          -- custom rules/regulations
  status            VARCHAR(20) DEFAULT 'draft',
                     -- draft, scheduled, in_progress, completed, cancelled
  start_date        DATE,
  end_date          DATE,
  created_by        VARCHAR(255),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT check_cup_format CHECK (format IN ('single_elimination', 'double_elimination', 'round_robin')),
  CONSTRAINT check_cup_status CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled'))
);

-- Cup participants (players/teams registered for the cup)
CREATE TABLE cup_participants (
  id          SERIAL PRIMARY KEY,
  cup_id      INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
  player1_id  INTEGER NOT NULL REFERENCES players(id),
  player2_id  INTEGER REFERENCES players(id),  -- NULL for solo cups
  team_name   VARCHAR(255),
  seed        INTEGER,                          -- seeding number
  UNIQUE(cup_id, player1_id, player2_id)
);
CREATE INDEX idx_cup_participants_cup ON cup_participants(cup_id);

-- Cup matches (bracket rounds)
CREATE TABLE cup_matches (
  id              SERIAL PRIMARY KEY,
  cup_id          INTEGER NOT NULL REFERENCES cups(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,              -- 1=R16, 2=QF, 3=SF, 4=Final
  match_number    INTEGER NOT NULL,              -- match index within round
  bracket_position VARCHAR(32),                   -- 'top', 'bottom', 'upper-1', etc.
  team1_participant_id INTEGER REFERENCES cup_participants(id),
  team2_participant_id INTEGER REFERENCES cup_participants(id),
  team1_score     INTEGER,
  team2_score     INTEGER,
  winner_participant_id INTEGER REFERENCES cup_participants(id),
  play_date       DATE,
  status          VARCHAR(20) DEFAULT 'scheduled',
                     -- scheduled, in_progress, completed, forfeited, cancelled
  goal_difference INTEGER GENERATED ALWAYS AS (COALESCE(team1_score, 0) - COALESCE(team2_score, 0)) STORED,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT check_cup_match_status CHECK (status IN ('scheduled', 'in_progress', 'completed', 'forfeited', 'cancelled'))
);
CREATE INDEX idx_cup_matches_cup ON cup_matches(cup_id);
CREATE INDEX idx_cup_matches_round ON cup_matches(cup_id, round_number, match_number);

-- Cup advancement rules (auto-advance winners to next round)
CREATE TABLE cup_advancements (
  id              SERIAL PRIMARY KEY,
  from_match_id   INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
  to_match_id     INTEGER NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
  winner_slot     VARCHAR(10) NOT NULL,           -- 'team1' or 'team2' in next match
  UNIQUE(from_match_id, to_match_id, winner_slot)
);
CREATE INDEX idx_cup_advancements_from ON cup_advancements(from_match_id);
CREATE INDEX idx_cup_advancements_to ON cup_advancements(to_match_id);
```

**Migration script: `migrations/10-add-cup-tournaments.sh`**

#### Backend Changes

**New route file: `routes/cups.js`**

```
GET    /api/cups                        — List all cups
GET    /api/cups/:id                    — Get cup details with bracket
POST   /api/cups                        — Create new cup (admin only)
PUT    /api/cups/:id                    — Update cup info (admin only)
DELETE /api/cups/:id                    — Delete cup (admin only, only in draft)

POST   /api/cups/:id/participants       — Add participants (admin only)
PUT    /api/cups/:id/participants       — Reorder/seed participants
DELETE /api/cups/:id/participants/:pid  — Remove participant (draft only)

POST   /api/cups/:id/generate-bracket   — Auto-generate bracket from participants
PUT    /api/cups/:id/matches/:mid       — Update match score/result
POST   /api/cups/:id/advance            — Auto-advance winners to next round
POST   /api/cups/:id/seed-shuffle       — Shuffle seeds for fair bracket
PUT    /api/cups/:id/status             — Change cup status (draft→scheduled→in_progress→completed)
```

**`database-postgresql.js` — New methods:**
- `getCups()`, `getCupById(cupId)`, `createCup()`, `updateCup()`, `deleteCup()`
- `getCupParticipants(cupId)`, `addCupParticipant()`, `removeCupParticipant()`
- `generateBracket(cupId)` — algorithm to create match pairings
- `updateCupMatch(cupId, matchId, team1Score, team2Score)` — with auto-score calculation
- `advanceWinner(cupId, matchId)` — move winner to next round match
- `calculateGoalDifference(team1Score, team2Score)` — stored via generated column
- `getCupBracket(cupId)` — full bracket structure for frontend rendering

**Bracket generation algorithm:**
1. Takes N participants (must be power of 2: 4, 8, 16, 32)
2. Seeds participants by ranking (if season linked) or random
3. Creates round-robin or single-elimination bracket
4. Creates `cup_matches` rows for each round
5. Creates `cup_advancements` linking winners to next round slots

**Auto-advance logic:**
- When a match is marked completed with a winner
- Find the advancement rule for that match
- Fill in the winner as the appropriate team in the next match
- Cascade: if next match now has both teams, mark it as "ready"

#### Frontend Changes

**New tab: "Giải Đấu Cúp" (Cup Tournaments)**

```
🏆 Giải Đấu Cúp
├── Danh sách giải đấu (grid list)
├── Tạo giải đấu mới (modal)
│   ├── Tên giải đấu
│   ├── Liên kết mùa giải (tùy chọn)
│   ├── Định dạng: Loại trừ / Vòng tròn
│   ├── Số đội: 4 / 8 / 16 / 32
│   ├── Quy định (textarea)
│   └── Nút "Tạo"
├── Chi tiết giải đấu
│   ├── Thông tin + Quy định
│   ├── Danh sách đội tham gia (kéo thả để sắp xếp hạt giống)
│   ├── Nút "Tạo bảng đấu" → generate-bracket
│   ├── Nút "Xáo trộn hạt giống" → seed-shuffle
│   ├── Bảng đấu (bracket visualization)
│   │   ├── Vòng 1 (R16)
│   │   ├── Tứ kết (QF)
│   │   ├── Bán kết (SF)
│   │   └── Chung kết (Final)
│   ├── Nhập kết quả (modal per match)
│   │   ├── Team 1 score
│   │   ├── Team 2 score
│   │   ├── Hiệu số (auto-calculated)
│   │   └── Nút "Lưu & Tự động chuyển vòng"
│   └── Nút "Hoàn thành giải đấu"
└── Quản lý trạng thái (draft → scheduled → in_progress → completed)
```

**Bracket visualization:**
- Horizontal bracket layout (left-to-right progression)
- SVG-based connector lines between matches
- Each match node shows: Team names, scores, goal difference
- Click match to open score entry modal
- Color coding: scheduled (gray), in_progress (yellow), completed (green), forfeited (red)
- Responsive: vertical layout on mobile

**`src/main.js` additions:**
- `loadCups()`, `showCupModal()`, `createCup()`, `editCup()`
- `loadCupDetails(cupId)`, `generateBracket(cupId)`
- `renderBracket(cupId, bracketData)` — SVG bracket renderer
- `openMatchScoreModal(matchId)`, `submitMatchScore(matchId, scores)`
- `advanceWinner(matchId)`, `shuffleSeeds(cupId)`
- Drag-and-drop reordering for participant seeding

**CSS:**
- Bracket visualization styles
- Match card styles
- Score entry modal
- Status badges

---

## Implementation Phases & Timeline

### Phase 1: Self-Service Image Editor (Estimated: 3-4 days)

| Task | File(s) | Dependencies |
|------|---------|-------------|
| 1.1 DB migration: `site_images` table | `migrations/08-add-site-images.sh`, `database-postgresql.js` | None |
| 1.2 Upload route + multer config | `routes/images.js` | Phase 1.1 |
| 1.3 Image serving route | `routes/images.js` | Phase 1.1 |
| 1.4 Server wiring + static serving | `server.js` | Phase 1.2 |
| 1.5 Frontend image editor UI | `index.html`, `src/main.js`, `src/style.css` | Phase 1.3 |
| 1.6 Hero banner dynamic loading | `index.html`, `src/main.js` | Phase 1.3 |
| 1.7 Docker volume config | `docker-compose.yml`, `.dockerignore` | Phase 1.4 |
| 1.8 Testing + polish | All above | All Phase 1 |

### Phase 2A: Post-Tournament Results (Estimated: 2 days)

| Task | File(s) | Dependencies |
|------|---------|-------------|
| 2A.1 DB migration: season result columns | `migrations/09-add-season-results.sh`, `database-postgresql.js` | None |
| 2A.2 Update season routes | `routes/seasons.js` | Phase 2A.1 |
| 2A.3 Conclusion image upload | `routes/seasons.js`, `routes/images.js` | Phase 2A.1, Phase 1 |
| 2A.4 Frontend season card update | `index.html`, `src/main.js` | Phase 2A.2 |
| 2A.5 Testing | All above | All Phase 2A |

### Phase 2B: Cup Bracket System (Estimated: 6-8 days)

| Task | File(s) | Dependencies |
|------|---------|-------------|
| 2B.1 DB migration: cups tables | `migrations/10-add-cup-tournaments.sh`, `database-postgresql.js` | None |
| 2B.2 Cup CRUD routes | `routes/cups.js` | Phase 2B.1 |
| 2B.3 Participant management | `routes/cups.js`, `database-postgresql.js` | Phase 2B.1 |
| 2B.4 Bracket generation algorithm | `database-postgresql.js`, `lib/bracket-generator.js` | Phase 2B.2 |
| 2B.5 Match scoring + auto-advance | `routes/cups.js`, `database-postgresql.js` | Phase 2B.4 |
| 2B.6 Frontend cup tab + list | `index.html`, `src/main.js` | Phase 2B.2 |
| 2B.7 Bracket visualization (SVG) | `src/main.js`, `src/style.css`, `src/lib/bracket-renderer.js` | Phase 2B.5 |
| 2B.8 Score entry UI + auto-advance | `src/main.js` | Phase 2B.6 |
| 2B.9 Seed shuffle + drag-drop | `src/main.js` | Phase 2B.6 |
| 2B.10 Testing + polish | All above | All Phase 2B |

### Phase 3: Integration & QA (Estimated: 2-3 days)

| Task | Details |
|------|---------|
| 3.1 Cross-feature testing | Image editor + seasons + cups together |
| 3.2 Cache invalidation audit | Ensure all mutations trigger proper cache invalidation |
| 3.3 Rate limiting review | New endpoints need appropriate rate limits |
| 3.4 CSRF protection | All POST/PUT/DELETE covered |
| 3.5 Mobile responsive testing | Bracket visualization on small screens |
| 3.6 Deployment testing | Docker compose full stack test |
| 3.7 Documentation | Update README.md, CLAUDE.md |

---

## Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Upload directory permissions | Files not writable in Docker | Use Docker volume mount; create dir in Dockerfile |
| Large image storage growth | Disk space exhaustion | Max 10MB per image; cleanup old files on replace; add admin "storage stats" |
| Bracket algorithm complexity | Bugs in seeding/advancement | Start with single-elimination only; thorough unit tests |
| Frontend main.js growth | Already ~4000 lines | Extract cup logic to `src/modules/cup-manager.js`; image editor to `src/modules/image-editor.js` |
| Cache invalidation gaps | Stale bracket data | Add `invalidateOnCupChange()` to RedisCache; use PG NOTIFY triggers |
| CSP blocking uploads | Multer body rejected | Add `blob:` and `data:` to CSP form-action if needed |

---

## File Change Summary

### New Files
```
routes/images.js              — Image management API
routes/cups.js                — Cup tournament API
lib/bracket-generator.js      — Bracket generation algorithm
src/modules/image-editor.js   — Frontend image editor module
src/modules/cup-manager.js    — Frontend cup management module
src/lib/bracket-renderer.js   — SVG bracket visualization
migrations/08-add-site-images.sh
migrations/09-add-season-results.sh
migrations/10-add-cup-tournaments.sh
```

### Modified Files
```
server.js                     — Wire new routes, upload static serving
database-postgresql.js        — New DB methods, season columns
routes/seasons.js             — Final results + conclusion image
index.html                    — New tabs, modals, image editor UI
src/main.js                   — New feature handlers (extract modules)
src/style.css                 — Bracket, image editor, cup styles
docker-compose.yml            — Upload volume mount
.dockerignore                 — Exclude uploads from build
ecosystem.config.cjs          — No changes needed
README.md                     — Document new features
CLAUDE.md                     — Update architecture notes
```

---

## Customer Communication Points

1. **Image Editor:** Admins can change the hero banner, logo, and other images directly from the website. No need to contact developers or access the server.

2. **Final Results:** After each season ends, admins can write a summary text and upload a conclusion image (e.g., group photo, trophy ceremony). This displays on the season's detail page.

3. **Cup Brackets:** 
   - Create knockout tournaments (4/8/16/32 teams)
   - Set custom rules and regulations
   - Auto-generate match pairings from registered players
   - Enter scores → system auto-calculates goal differences and advances winners
   - Visual bracket display with real-time updates

---

## Next Steps

1. **Confirm priority order** with customer (recommended: 1 → 2A → 2B)
2. **Confirm cup format** — single elimination only initially? Or double-elimination from day 1?
3. **Confirm image types** — hero banner + logo sufficient? Or more?
4. **Approve plan** → Begin Phase 1 implementation
