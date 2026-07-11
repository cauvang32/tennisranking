# Feature Plan — Customer Requirements Audit & Implementation

> Generated: 2026-07-10
> Status: Audit complete — all three customer requirements are **fully implemented**
> Migrations 08/09/10 must be applied before deployment.

---

## Requirement 1: Self-Service Image Editor

> Implement an image editor interface that allows administrators to upload and update images on the website independently without requiring technical support.

### Status: ✅ COMPLETE

| Sub-requirement | Implementation | Files |
|---|---|---|
| Database schema | `site_images` table with key, filename, storage_path, content_type, file_size, alt_text, is_active | `migrations/08-add-site-images.sh` |
| Image upload (multer) | POST `/api/images/:key` — admin-only, 10MB limit, validates PNG/JPEG/WebP/GIF/SVG | `routes/images.js:131-177` |
| Image preview | GET `/api/images/:key/file` — serves file with 1-year cache, fallback for hero_banner | `routes/images.js:97-128` |
| Metadata edit | PUT `/api/images/:key/meta` — update alt_text, toggle is_active | `routes/images.js:179-204` |
| Image removal | DELETE `/api/images/:key` — sets is_active=false, deletes file from disk | `routes/images.js:206-231` |
| Pre-seeded keys | hero_banner, logo, favicon, background (all with placeholder values) | `migrations/08-add-site-images.sh` |
| Hero banner migration | POST `/api/images/migrate-hero` — one-time copy of `public/image.png` into system | `routes/images.js:226-360` |
| Frontend UI | Dedicated **Hình Ảnh** tab (admin-only) with upload, preview, alt-text, delete, refresh | `index.html:706-790`, `src/main.js:5198-5355` |
| Dynamic banner | Hero banner auto-reloads on upload via `/images/hero_banner/file` with cache-busting `?t=` | `src/main.js:5184-5195` |
| Cache invalidation | `rankingsCache.invalidateOnImageChange()` on every mutation | `routes/images.js` |

**What the admin sees:**
- Grid of 4 image cards (Banner, Logo, Background, Favicon)
- Each card has: live preview, upload button, delete button, alt-text input (auto-saves with debounce)
- "Dời Banner Từ File Cũ" one-click migration button for existing `public/image.png`

---

## Requirement 2: Tournament Management Enhancements

### 2A. Final Tournament Results (text input per season)

> For each tournament season, add a text input field to display the "Final Tournament Results."

### Status: ✅ COMPLETE

| Sub-requirement | Implementation | Files |
|---|---|---|
| Database column | `final_results TEXT` on `seasons` table | `migrations/09-add-season-results.sh` |
| DB method | `updateSeason()` accepts `finalResults` as 8th parameter, conditionally updates | `database-postgresql.js:612-626` |
| API endpoint | PUT `/api/seasons/:id/results` — admin-only, validates max 10,000 chars | `routes/seasons.js:292-314` |
| Frontend modal | `seasonResultsModal` with textarea (6 rows, 10K char limit), save button | `index.html:974-1007` |
| Frontend display | Ended season cards show "🏆 Kết quả cuối cùng" with newline-preserved text | `src/main.js:2792-2828` |
| Edit trigger | "📋 Xem kết quả" button on ended seasons (visible to admin/editor/public if results exist) | `src/main.js:2818-2826` |
| Cache invalidation | `rankingsCache.invalidateOnSeasonChange()` after update | `routes/seasons.js:311` |

**What the user sees:**
- Ended seasons show a "📋 Xem kết quả" button
- Clicking opens a modal with a pre-filled textarea for the final results text
- After saving, the results appear on the season card with "🏆 Kết quả cuối cùng:" label

### 2B. Tournament Conclusion Image

> Include a section to upload or display a "Tournament Conclusion Image" at the end of each season.

### Status: ✅ COMPLETE

| Sub-requirement | Implementation | Files |
|---|---|---|
| Database columns | `conclusion_image_path`, `conclusion_image_filename`, `conclusion_image_content_type`, `conclusion_image_size` on `seasons` | `migrations/09-add-season-results.sh` |
| Upload API | POST `/api/images/season/:seasonId/conclusion` — admin-only, multer, 10MB limit | `routes/images.js:233-265` |
| Serve API | GET `/api/images/season/:seasonId/conclusion/file` — cached 1 year | `routes/images.js:267-294` |
| Delete API | DELETE `/api/images/season/:seasonId/conclusion` — removes file + clears DB | `routes/images.js:296-323` |
| DB methods | `uploadSeasonConclusionImage()`, `deleteSeasonConclusionImage()` | `database-postgresql.js:1795-1814` |
| Frontend upload | File input in season results modal, previews after upload | `src/main.js:5416-5448` |
| Frontend delete | "🗑️ Xóa ảnh" button (shown only when image exists) | `src/main.js:5450-5470` |
| Frontend display | Ended season cards show the conclusion image (max 120px height, contain fit) | `src/main.js:2814` |

**What the user sees:**
- Same modal as final results (Requirement 2A) includes an image upload section
- Uploaded image previews immediately in the modal
- On the season card, the image displays below the final results text

### 2C. Automated Tournament / Cup Bracket System

> Develop a feature to set up tournament regulations (Cup format), implement a system to pre-define match pairings (fixtures), enable automatic calculation of scores and goal differences based on the pre-defined match pairings.

### Status: ✅ COMPLETE

| Sub-requirement | Implementation | Files |
|---|---|---|
| **Tournament regulations** | | |
| Cup definition | `cups` table: name, format, num_teams, regulation_text, status, dates | `migrations/10-add-cup-tournaments.sh` |
| Format support | `single_elimination`, `double_elimination`, `round_robin` (DB constraint) | `database-postgresql.js:1845` |
| Regulation text | Free-form TEXT field, displayed in cup detail view | `routes/cups.js:84`, `src/main.js:5560` |
| Status workflow | draft → scheduled → in_progress → completed; any → cancelled; cancelled → draft | `routes/cups.js:187-225` |
| CRUD API | Full create/update/delete with validation, structural-change guard after bracket gen | `routes/cups.js:64-185` |
| **Pre-defined match pairings (fixtures)** | | |
| Participant registration | Add players as teams (singles or doubles), with seed ordering | `routes/cups.js:244-282` |
| Seed management | Manual reorder (drag-and-drop via ordered IDs) + random shuffle | `routes/cups.js:284-334`, `routes/cups.js:366-394` |
| Bracket generation | Auto-creates knockout bracket from seeds, pads to power-of-2 with byes | `database-postgresql.js:1958-2065` |
| Bye handling | Matches with only 1 participant auto-complete (0-0, winner advances) | `database-postgresql.js:2006-2017` |
| Advancement rules | `cup_advancements` table links each match winner to the next-round slot | `migrations/10-add-cup-tournaments.sh` |
| **Automatic score calculation** | | |
| Score entry | PUT `/api/cups/:id/matches/:mid` with `team1Score` + `team2Score` | `routes/cups.js:396-425` |
| Winner determination | Higher score wins; winner auto-advances to next round via `cup_advancements` | `database-postgresql.js:2067-2116` |
| Goal difference | `goal_difference` column — generated `AS (team1_score - team2_score) STORED` | `migrations/10-add-cup-tournaments.sh` |
| Status guard | Score updates only allowed when cup is `in_progress` | `routes/cups.js:413` |
| **Frontend UI** | | |
| Cup list | Grid of cards showing name, format, status badge, team count, season link | `src/main.js:5497-5526` |
| Cup detail | Participants list, regulation text, action buttons per status, bracket visualization | `src/main.js:5528-5608` |
| Bracket visualization | Multi-column layout: each round as a column, matches as cards with scores and winner highlighting | `src/main.js:5610-5656` |
| Score input | Inline number inputs + "Ghi điểm" button for scheduled matches during `in_progress` | `src/main.js:5643-5649` |
| Create flow | Modal form → participant selection (checkbox grid) → auto-add to cup | `src/main.js:5663-5857` |

**What the admin sees:**
1. **Create cup** → modal with name, season link, format (single elimination / round robin), team count (4/8/16/32), regulation text
2. **Add participants** → checkbox grid of all players, select up to `numTeams`, confirm
3. **Manage seeds** → manual reorder or random shuffle (🔀 Xáo trộn hạt giống)
4. **Generate bracket** → one click creates all matches, advances to "scheduled" status
5. **Start tournament** → transition to "in_progress"
6. **Enter scores** → inline inputs appear for each scheduled match; on submit, winner auto-advances to the next round
7. **Complete** → transition to "completed" when all matches are done

---

## Implementation Summary

| Requirement | Backend (DB + API) | Frontend (UI) | Migration | Verdict |
|---|---|---|---|---|
| 1. Self-Service Image Editor | ✅ `routes/images.js`, `database-postgresql.js` | ✅ `index.html:706-790`, `src/main.js:5198-5355` | ✅ `migrations/08-add-site-images.sh` | **COMPLETE** |
| 2A. Final Results text | ✅ `routes/seasons.js:292-314`, `database-postgresql.js:612` | ✅ `index.html:974-1007`, `src/main.js:5360-5414` | ✅ `migrations/09-add-season-results.sh` | **COMPLETE** |
| 2B. Conclusion Image | ✅ `routes/images.js:233-323`, `database-postgresql.js:1795-1814` | ✅ `index.html:989-999`, `src/main.js:5416-5470` | ✅ `migrations/09-add-season-results.sh` | **COMPLETE** |
| 2C. Cup Bracket System | ✅ `routes/cups.js` (447 lines), `database-postgresql.js:1818-2116` | ✅ `index.html:792-814`, `src/main.js:5472-5972` | ✅ `migrations/10-add-cup-tournaments.sh` | **COMPLETE** |

---

## Deployment Checklist

Before deploying to production, ensure the following migrations are applied **in order**:

```bash
# 1. Site images table (Feature 1: Image Editor)
./migrations/08-add-site-images.sh

# 2. Season results columns (Feature 2A + 2B)
./migrations/09-add-season-results.sh

# 3. Cup tournament tables (Feature 2C)
./migrations/10-add-cup-tournaments.sh
```

Each migration is **idempotent** — running it twice is safe (no-op if already applied).

### Pre-requisites
- PostgreSQL container `tennis-postgres` must be running (or adjust `DB_CONTAINER` env var)
- Ensure `data/uploads/images/` directory is persistent (use Docker volume `uploads-data` in `docker-compose.yml`)
- The `uploads-data` volume is already configured in `docker-compose.yml`

### Verification After Deployment
1. Login as admin → navigate to **Hình Ảnh** tab → upload a test image
2. Navigate to **Mùa Giải** → click "📋 Xem kết quả" on an ended season → save results text
3. Navigate to **Giải Đấu Cúp** → create a cup → add 4+ participants → generate bracket → start → enter scores

---

## Issues Found & Resolutions

### ✅ Fixed: Unimplemented Cup Formats Exposed to User

**Problem:** `round_robin` was offered in the frontend create-cup dropdown and `double_elimination` was in the DB constraint, but `generateBracket()` only implements single-elimination logic. An admin could select "Vòng tròn" and get an incorrect bracket.

**Fix applied (4 changes):**
1. **`database-postgresql.js`** — Added format guard in `generateBracket()`. Throws clear error if format is not `single_elimination`.
2. **`routes/cups.js`** — Narrowed format validator in both POST `/` and PUT `/:id` to only accept `['single_elimination']`. Added format check in `generate-bracket` endpoint for 400 response. Removed dead `.custom()` validator on `numTeams`.
3. **`src/main.js`** — Removed `round_robin` option from create-cup modal dropdown. Added hint: "Hiện chỉ hỗ trợ định dạng loại trực tiếp".

### ✅ Fixed: `verifyToken()` Returns `null` — TypeError in CSRF & Auth Middleware (Code Review)

**Problem:** `verifyToken()` from `lib/jwt-encryption.js` returns `null` (not throws) for invalid/expired tokens. Both `middleware/csrf.js` (new code) and `middleware/auth.js` (`authenticateToken`) accessed `user.type` without a null guard, causing `TypeError: Cannot read properties of null`.

**Impact:**
- **CSRF middleware:** TypeError caught by try-catch → `req.user` stays unset → falls back to anonymous CSRF secret. Request with expired token + anonymous CSRF token would pass CSRF validation (though `authenticateToken` would still reject at route level).
- **`authenticateToken`:** Same crash in try-catch → falls through to `catch(err)` → 403 response. Works by accident but is fragile.

**Fix applied:**
1. **`middleware/csrf.js`** line 83: `if (user && user.type === 'access')` — null guard before `.type` access
2. **`middleware/auth.js`** line 26: Added `if (!user) return res.status(401)...` early return before `.type` check

### ✅ Fixed: `generate-bracket` Route — 500 Error for Unsupported Formats

**Problem:** The `generate-bracket` endpoint calls `db.generateBracket(cupId)` which now throws for non-`single_elimination` cups. The thrown Error goes through `asyncHandler` → Express error handler → 500 Internal Server Error.

**Fix applied:** Added format check at route level (`routes/cups.js` generate-bracket handler) with `res.status(400).json({ error: '...' })` before calling `db.generateBracket()`.

### Remaining Notes (non-blocking, intentional design)

1. **Cup matches are separate from rankings** — Cup matches live in `cup_matches` table and do **not** feed into the main ranking system (no points awarded, no stats updated). This appears intentional — cups are a parallel tournament system. If the customer wants cup results to affect rankings, this would be a new feature request.

2. **DB constraint still accepts all three formats** — The `check_cup_format` constraint in migration 10 still allows `double_elimination` and `round_robin`. Since the API validator now rejects them, this is a defense-in-depth cleanup only. A future migration (11) could tighten it.

3. **CSRF middleware duplicates token extraction** — The CSRF middleware replicates token decoding from `authenticateToken` because it runs globally before route-level auth. This is a known trade-off. A shared helper could reduce duplication in a future refactor.

4. **Season results modal text is required in frontend, optional in backend** — The frontend `saveSeasonResults()` validates the textarea is non-empty before sending. The backend uses `.optional()`. The frontend guard is stricter, preventing accidental empty saves. This is fine.

### All Customer Requirements Met

All three customer requirements are fully implemented with:
- Database schemas (migrations 08/09/10)
- Backend API routes with auth, validation, and cache invalidation
- Frontend UI with Vietnamese labels
- Proper error handling and user feedback
