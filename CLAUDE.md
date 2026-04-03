# PavementScan — Project Reference (CLAUDE.md)

> **For AI use.** All project context lives here — no need to check external memory files.

---

## Table of Contents

1. [What Is PavementScan](#1-what-is-pavementscan)
2. [Live URL & Deployment](#2-live-url--deployment)
3. [File Structure](#3-file-structure)
4. [Tech Stack](#4-tech-stack)
5. [Data Schema](#5-data-schema)
6. [Desktop UI Layout](#6-desktop-ui-layout)
7. [Mobile UI Layout](#7-mobile-ui-layout)
8. [Features List — Desktop](#8-features-list--desktop)
9. [Features List — Mobile](#9-features-list--mobile)
10. [Key Functions Reference — Desktop](#10-key-functions-reference--desktop)
11. [Key Functions Reference — Mobile](#11-key-functions-reference--mobile)
12. [Project Settings Schema](#12-project-settings-schema)
13. [AI Scanning System](#13-ai-scanning-system)
14. [Calibration System](#14-calibration-system)
15. [Street Drawing (Pin Mode)](#15-street-drawing-pin-mode)
16. [Photo Systems](#16-photo-systems)
17. [Street View Integration](#17-street-view-integration)
18. [Known Decisions & Rules](#18-known-decisions--rules)
19. [Current Version](#19-current-version)

---

## 1. What Is PavementScan

A pavement assessment tool built for crack seal and slurry seal contractors (Cal's company). Field workers drive streets, the app auto-collects Street View photos along the route, sends them to an AI model, and returns a condition rating (LVL 1–4). Tracks square footage, generates reports, helps prioritize treatment.

**Login:** username `Cal.Zentara` / passcode `0911`

---

## 2. Live URL & Deployment

- **Desktop:** https://autobuildcharlie.github.io/PavementScan/
- **Mobile:** https://autobuildcharlie.github.io/PavementScan/mobile.html
- **Repo:** https://github.com/AutoBuildCharlie/PavementScan
- **Branch:** `master` — GitHub Pages auto-deploys on push
- **Deploy command:** `/git-deploy` or `git add . && git commit -m "vXXX: ..." && git push`
- **Version convention:** bump `?v=XXX` on `<link rel="stylesheet">` and `<script src="...">` in both `index.html` and `mobile.html`
- **Current version:** v226 (desktop app.js v194, style.css v182), mobile.js v48

---

## 3. File Structure

```
CrackingSealingEst/
├── index.html      — Desktop HTML: login, header, modals, panels, lightbox
├── app.js          — Desktop JS (~4000+ lines): map, AI, data, UI
├── style.css       — Desktop CSS: dark theme, layout, components
├── mobile.html     — Mobile HTML: Google Maps-style layout
├── mobile.css      — Mobile CSS: bottom sheet, FABs, sheets
├── mobile.js       — Mobile JS (~1600 lines): all mobile logic
├── manifest.json   — PWA manifest (name, icon, theme, start_url)
├── sw.js           — Service worker v2 (caches local files only)
└── CLAUDE.md       — This file
```

No build system. No npm. Pure HTML/CSS/JS.

---

## 4. Tech Stack

| Layer | What |
|---|---|
| Maps | Google Maps JavaScript API (dark theme via inline styles on mobile, mapId on desktop) |
| Street View photos | Google Street View Static API (via proxy) |
| AI analysis | GPT-4o or Gemini Flash via Cloudflare Worker proxy |
| AI proxy URL | `https://cse-worker.aestheticcal22.workers.dev` |
| Road type detection | OpenStreetMap Overpass API |
| Geocoding | Google Maps Geocoder (JS API) |
| Persistence | `localStorage` only — no backend |
| Auth | `sessionStorage` flag (`cse_auth = '1'`) |
| Fonts | Inter (Google Fonts — loaded async on mobile to avoid blocking) |
| Deployment | GitHub Pages |
| PWA | manifest.json + sw.js (service worker caches only local files) |

---

## 5. Data Schema

### localStorage Keys

| Key | Contents |
|---|---|
| `cse_projects` | Array of all project objects (JSON) |
| `cse_active_project` | UUID string of selected project |
| `cse_global_settings` | `{ globalAiNotes: string }` |

Both desktop and mobile share the same localStorage keys — data is identical across both.

### Project Object

```js
{
  id: "uuid",
  name: "Anaheim Q2 2026",
  type: "crack-seal" | "slurry" | "both",
  streets: [ ...street objects... ],
  createdAt: "ISO string",
  photoInterval: 200,        // ft between scan photo samples
  maxPhotos: 6,              // max scan photos per street
  detectRR: true,            // show R&R section
  aiEnabled: true,           // run AI analysis on scan
  scanModel: "gpt-4o",       // "gpt-4o" | "gemini-2.0-flash"
  aiNotes: "",               // per-project AI instructions
  includeWideCracks: false,  // wide crack detection toggle
  detectLaneLayout: false,   // lane layout AI detection (off by default)
  calibrationLog: [],        // correction history
  calibrationRules: [],      // generated AI rules
}
```

### Street Object

```js
{
  id: "uuid",
  name: "W Crestwood Ln",
  lat, lng,                  // midpoint coords
  length,                    // ft
  width,                     // ft (auto from road type)
  sqft,                      // length × width
  rating: "level-1" | "level-2" | "level-3" | "level-4" | null,
  aiRating: "level-X" | null,  // original AI rating before manual override
  roadType: "residential" | "arterial" | "highway" | "parking-lot",
  notes: "",
  analysis: "",              // AI analysis text
  adminNotes: "",
  weedAlert: bool, weedNotes: "",
  ravelingAlert: bool, ravelingNotes: "",
  rrAlert: bool,
  svImage: "url",            // thumbnail
  path: [{ lat, lng }, ...], // polyline points
  photos: [...],             // on-site photos
  rrPhotos: [...],           // R&R photos
  scanPhotos: [...],         // AI-analyzed Street View photos
  scannedAt: "ISO string",
  createdAt: "ISO string",
  completed: bool,           // Mark Done system — grayed out + sorted to bottom
  dueDate: "YYYY-MM-DD" | null,
  order: number | null,      // route stop number (can be X.5 for half stops)
  orderClickPt: {lat, lng} | null,  // where user clicked to assign order (shown on map)
  orderNote: "",             // why this street is next — AI training data
}
```

### Photo Object

```js
{
  id: "uuid",
  dataUrl: "base64",         // on-site/RR photos
  url: "sv static url",      // scan photos
  hdUrl: "sv static url",    // scan photos HD
  lat, lng,
  label: "",
  note: "",
  rating: "level-X" | null,
  takenAt: "ISO string"
}
```

---

## 6. Desktop UI Layout

```
┌──────────────────────────────────────────────────────────────┐
│ HEADER: PavementScan | stats pills | Report | Global Settings│
├──────────────┬─────────────────────────────┬─────────────────┤
│ LEFT PANEL   │        MAP (center)          │ RIGHT PANEL     │
│ - Project    │  Google Maps dark mode       │ Street Detail   │
│   selector   │  + polyline overlays         │ 3 tabs:         │
│   + settings │  + photo markers             │ Overview|Photos │
│ - Streets    │  + animated pulse on select  │ |Analysis       │
│   list       │                              │ (hidden until   │
│ - Search bar │  [Street View panel -        │  street select) │
│ - Quick      │   slides over map]           │                 │
│   actions    │                              │                 │
│   (Pin/SV/   │                              │                 │
│   Photo)     │                              │                 │
└──────────────┴─────────────────────────────┴─────────────────┘
```

**Desktop Modals:** Add Street, Scan spinner, Photo Lightbox, SV Snap, Name Prompt, Refine AI, Global Settings, Report

---

## 7. Mobile UI Layout

Google Maps-style layout:
- **Full-screen map** — dark theme via inline styles (no mapId needed)
- **Top bar** — project chip (tap to switch) + search bar (filters street list in real-time)
- **FABs (right side)** — Photo, Street View worker (draggable), Location, Pin
  - FABs hide automatically when bottom sheet is fully open
- **Bottom sheet** — 3 states: peek (120px) | half (50%) | full (100%)
  - Drag handle is full-width, 48px tall — easy to grab anywhere
  - Handle color = active street's rating color
  - Double pull-down on handle to refresh (not map drag)
- **Street list view** — inside sheet, swipe left on item to delete
- **Street detail view** — 3 tabs: Overview | Photos | Analysis
- **Overlays:** Project sheet, Scan sheet, Name sheet, SV overlay, Snap sheet, Lightbox, Scanning spinner

**PWA:** installable via "Add to Home Screen", service worker caches local files only (not Google APIs — they were causing 5-min hangs). Splash screen shows on load, hides when map tiles load or after 8s max.

---

## 8. Features List — Desktop

### Core
- Multi-project support — create, rename, delete, switch
- Per-project type: crack seal / slurry / both
- Street list with search
- Add street by address (auto-geocodes, detects road type + width)
- Stats bar: total streets, sq ft, sq yards, avg rating
- **Import Street List** — paste tab-separated table (Street|Begin|End), geocodes both intersections, draws polyline, optional batch AI scan. ~70-75% geocoding accuracy for cross-street segments.

### Street Drawing (Pin Mode)
- Pin.Start → click map → Pin.End → click map → name prompt
- Green crosshair cursor on start, red on end
- Right-click cancels at any time
- Street name suggested from midpoint geocode

### Route Ordering (Manual)
- **▶ Set Route Order** button in project bar — activates tap-to-order mode
- Left-click street on map → assigns stop number at click point (yellow badge)
- Right-click street on map → assigns half stop (e.g. 2.5) — purple badge (for streets worked in two passes with a connecting street in between)
- After each click, note prompt expands in bar — type reason ("connects to stop 2", "do before traffic") or skip. Notes are AI training data for future route learning.
- Counter stays at current number after half stops so sequence is maintained
- **✓ Mark Done** in detail panel — grays out street text, sorts to bottom of list, dims polyline on map
- Stop badges show at exact click point (= where worker starts that street)
- Arterials intentionally left unordered — too many factors AI can't see (permits, traffic, lane closures)

### AI Scanning
- Samples Street View photos every N ft along path (up to maxPhotos)
- GPT-4o or Gemini Flash via proxy
- Returns: rating (LVL 1–4), analysis text, weed/raveling/R&R alerts
- AI can be disabled per project

### Ratings
- LVL 1 — Good (green) / LVL 2 — Light cracks (yellow)
- LVL 3 — Heavy cracks (orange) / LVL 4 — Alligator (red)
- Override in detail panel or lightbox

### Detail Panel (3 tabs)
- **Overview** — alerts, stat grid (sqft/sy/length/width), treatment, rating selector, rescan/delete, mark done
- **Photos** — SV thumbnail, on-site photos, R&R photos, scan photo grid
- **Analysis** — AI analysis text (level line stripped — shown in header), admin notes

### Settings (per project)
- Toggles: Wide Cracks, AI Analysis, R&R Detection, Lane Layout (2×2 grid)
- Project Type pill — full width, own row
- Advanced (collapsible): Photo Interval stepper, Max Photos stepper, Scan Model (GPT/Gemini)

### Map
- Dark theme, polylines colored by rating
- Pulsing glow on selected street (slow, ~2s cycle), main line semi-transparent
- Photo markers, search by address
- Order number badges on polylines — yellow (full stop) or purple (half stop)

### Report
- AI-generated project summary (all streets, ratings, sqft, treatment recommendations)

---

## 9. Features List — Mobile

All desktop features plus mobile-specific:
- **Tap polyline on map** → detail sheet opens (wide invisible tap target)
- **Search** filters street list in real-time + geocodes on Enter
- **"Use My Location"** in Add Street sheet — GPS → reverse geocode → fills name
- **One-tap photo FAB** — if street selected, goes straight to camera; if not, finds nearest street within 2000ft
- **Swipe left** on street list item → red Delete button appears
- **Handle color** = rating color of selected street
- **FABs hide** when sheet fully open
- **Live location** blue dot + accuracy circle (tracks as you move, button turns blue)
- **Pull-to-refresh** — double pull on sheet handle only (not map)
- **Loading splash** — shows immediately, hides when tiles load or 8s max
- **PWA installable** — manifest + service worker
- **▶ Set Route Order** in project sheet — gold order bar appears, tap streets to assign stop numbers
- **½ toggle button** in order bar — tap to switch to half-stop mode (purple badge), auto-resets after each tap
- Note prompt sheet slides up after each tap — type reason or skip
- **✓ Mark Done / ↩ Mark Incomplete** in overview tab

---

## 10. Key Functions Reference — Desktop

### Auth & Init
| Function | What |
|---|---|
| `doLogin()` | Validates creds, sets sessionStorage, shows app |
| `initMap()` | Google Maps init, loads projects, sets up listeners |

### Projects
| Function | What |
|---|---|
| `loadProjects()` / `saveProjects()` | Read/write localStorage |
| `createProject(name, type)` | New project with defaults |
| `switchProject(id)` | Change active project, re-render |
| `renderProjectSelector()` | Re-renders left panel project bar + settings |
| `toggleSettingsCollapse()` / `toggleAdvanced()` | Collapse settings sections |

### Streets
| Function | What |
|---|---|
| `saveStreet()` | Geocodes, detects road type, kicks off AI scan |
| `selectStreet(id)` | Opens right detail panel |
| `setRating(id, rating)` | Sets rating, logs calibration |
| `rescanStreet(id)` | Re-runs AI on existing street |
| `renderStreetList()` | Re-renders left panel list |
| `updateStats()` | Recalculates header pills |

### Street Drawing
| Function | What |
|---|---|
| `startFreeHighlight()` | Activates Pin mode |
| `handleMapClick(latLng)` | Routes clicks to pin or photo mode |
| `confirmStreetName()` | Saves street, kicks off scan |
| `setMapCursor(class)` | Forces cursor on Maps internal canvas |
| `drawAllHighlights()` | Redraws all polylines |

### AI Scanning
| Function | What |
|---|---|
| `analyzeStreetView(street)` | Main scan — samples, fetches photos, calls AI |
| `getSamplePoints(street)` | Returns `{lat,lng,heading}` array |
| `getStreetViewUrl(...)` | Builds SV Static API URL |
| `extractRating(text)` | Parses "level-X" from AI text |
| `recalcRatingFromPhotos(id)` | Recalculates from individual photo ratings |

### Calibration
| Function | What |
|---|---|
| `logCalibrationCorrection(street, ai, cal)` | Saves correction |
| `showReasonPrompt()` | "Why did you change?" — in lightbox or detail panel |
| `openRefineAIModal()` | AI generates rules from log |
| `applyCalibrationRules()` | Saves rules to localStorage |

### Photos
| Function | What |
|---|---|
| `openPhotoCapture(streetId)` | Opens file input |
| `handlePhotoCapture(e, id)` | Compresses + stores photo |
| `deleteScanPhoto(streetId, idx)` | Deletes one scan photo |
| `retakeScanPhoto(streetId, idx)` | Opens SV at photo coords for retake |

### Lightbox
| Function | What |
|---|---|
| `openLightbox(photos, idx, streetId, arrayName)` | Opens for any photo array |
| `lightboxSetRating(value)` | Updates rating, triggers calibration if scan photo |
| `lightboxRetakePhoto()` | Enters retake mode |
| `_renderLightbox()` | Re-renders current photo |

### Helpers
| Function | What |
|---|---|
| `geocodeAddress(address)` | Promise → `{lat, lng}` |
| `detectRoadType(lat, lng)` | OSM Overpass → road type string |
| `calcDistanceFt(p1, p2)` | Haversine in feet |
| `escHtml(str)` | XSS-safe escaping |
| `showToast(msg, dur)` | Bottom toast |
| `getGlobalSettings()` / `saveGlobalSettings()` | Global settings r/w |

---

## 11. Key Functions Reference — Mobile

| Function | What |
|---|---|
| `initMap()` | Maps init + splash hide + pull-to-refresh init |
| `loadProjects()` / `saveProjects()` | Same localStorage as desktop |
| `renderAll()` | Re-renders chip, list, project list, polylines, markers, stats |
| `setSheetState(state)` | peek/half/full — also hides FABs and updates handle color |
| `openStreet(id)` | Opens detail view, pans map, animates polyline |
| `renderStreetDetail()` | Renders header + tabs |
| `switchMobileTab(tab)` | overview / photos / analysis |
| `renderOverviewTab(s)` | Alerts, stat grid, rating select, actions |
| `renderPhotosTab(s)` | Photo grids + add buttons |
| `renderAnalysisTab(s)` | Formatted AI text + admin notes |
| `drawAllPolylines()` | Draws all streets + wide tap targets + pulse on active |
| `analyzeStreet(street)` | Full AI scan (same logic as desktop) |
| `getSamplePoints(street)` | Sample points along path |
| `handleMapClick(latLng)` | Pin mode — first click start, second click end |
| `togglePinMode()` | Start/cancel pin drawing |
| `confirmNameSheet()` | Saves pinned street, kicks off scan |
| `goToMyLocation()` | Blue dot + accuracy circle, watches position |
| `startPhoto()` | Camera — uses selected street or nearest within 2000ft |
| `openLightboxMobile(streetId, array, idx)` | Opens photo lightbox |
| `lbSetRating(value)` | Rate photo, recalc street rating |
| `openSVAt(lat, lng, heading)` | Opens Street View overlay |
| `snapSV(isRR)` | Captures SV frame, opens save sheet |
| `initWorkerDrag()` | Drag worker figure → drop on map → opens SV |
| `filterStreetList(query)` | Real-time street list filter |
| `swipeStart/Move/End` | Swipe-to-delete on street items |
| `useMyLocationForScan()` | GPS → reverse geocode → fills name input |
| `initPullToRefresh()` | Double pull-down on handle → reload |
| `updateHandleColor()` | Sets handle color to active street rating |

---

## 12. Project Settings Schema

Stored on project object (not separate key):

| Field | Default | Description |
|---|---|---|
| `photoInterval` | `200` | Feet between scan photo capture points |
| `maxPhotos` | `6` | Max scan photos per street |
| `detectRR` | `true` | Show R&R section |
| `aiEnabled` | `true` | Run AI analysis |
| `scanModel` | `"gpt-4o"` | `"gpt-4o"` or `"gemini-2.0-flash"` |
| `aiNotes` | `""` | Per-project AI grading instructions |
| `includeWideCracks` | `false` | Wide crack detection |
| `detectLaneLayout` | `false` | Lane layout AI detection (off by default — accuracy ~75%) |

---

## 13. AI Scanning System

### Flow
1. `getSamplePoints(street)` — samples every `photoInterval` ft along path, up to `maxPhotos`
2. Fetch SV Static photo → base64
3. All photos → single AI call
4. AI returns: rating, analysis, flags, per-photo ratings
5. Stored on street, re-renders UI

### Prompt Construction (in order)
1. Global AI instructions (`cse_global_settings.globalAiNotes`)
2. Per-project AI notes (`activeProject.aiNotes`)
3. Calibration rules (`activeProject.calibrationRules`)
4. Base system prompt (LVL definitions, rating criteria)
5. Photos as base64 image attachments

### Proxy
All calls → `https://cse-worker.aestheticcal22.workers.dev`
Worker holds API keys, routes to OpenAI or Google based on `provider` param.

### Notes
- `checkHasRoad` pre-filter was **removed from mobile** (caused extra AI calls, slowed scan)
- Level line stripped from displayed analysis text (shown in header instead)
- Lane layout uses satellite image + separate AI call — off by default

---

## 14. Calibration System

1. User changes rating → `logCalibrationCorrection()` → saved to `activeProject.calibrationLog`
2. "Why did you change?" prompt appears (in lightbox or detail panel)
3. User types reason → saved with correction
4. "Refine AI" → AI reads log → generates plain-English rules
5. Rules saved to `activeProject.calibrationRules` → injected into every future scan

**Prompt location:**
- Lightbox open → `#lightbox-calibration-reason` (inside lightbox)
- Otherwise → `#calibration-reason-prompt` (detail panel)

---

## 15. Street Drawing (Pin Mode)

**Desktop:** Pin.Start button → green crosshair cursor → click start → red crosshair → click end → name modal

**Mobile:** Tap Pin FAB → tap start on map → tap end → name sheet

**Shared:**
- Midpoint geocoded for name suggestion
- Name confirmation always shown (auto-detect was unreliable)
- Right-click (desktop) or Cancel button (mobile) exits pin mode
- Desktop: must force cursor onto Google Maps internal `canvas` elements

---

## 16. Photo Systems

| Type | Array | Added Via | Shown In |
|---|---|---|---|
| On-Site | `street.photos` | Camera → file input | Detail "On-Site Photos" |
| R&R | `street.rrPhotos` | R&R button or SV snap | Detail "R&R Photos" (if detectRR) |
| Scan | `street.scanPhotos` | Auto during AI scan | Detail scan photo grid |

- Photos compressed before storage (max 1200px, 80% quality)
- Lightbox works for all 3 types: pass `arrayName` = `"photos"` | `"rrPhotos"` | `"scanPhotos"`
- Retake: opens SV at photo's coords, "Replace Photo" button swaps the scan photo

---

## 17. Street View Integration

### Modes
1. **Scan mode** — automatic in `analyzeStreetView()`, not user-visible
2. **Interactive** — user drags worker figure (desktop/mobile) or clicks SV button → drops on map
3. **Retake** — from lightbox → SV opens at photo coords → "Replace Photo" swaps it

### SV Static URLs (via proxy)
- Thumbnail: `400×250` → stored as `url`
- HD: `800×500` → stored as `hdUrl`

### Desktop
- SV panel slides in from right over map
- Toolbar: Back | Snap Photo | Snap R&R | Replace Photo (retake only)
- z-index 9999 (above Maps controls)

### Mobile
- SV full-screen overlay
- Same toolbar buttons

---

## 18. Known Decisions & Rules

| Decision | Reason |
|---|---|
| Midpoint geocode for street name | Start/end near intersections gave wrong names |
| Name prompt after every draw | Auto-detect was unreliable |
| Mobile uses inline map styles not mapId | mapId requires Cloud Console config; inline styles work everywhere |
| Service worker caches local files only | Caching Google Fonts caused 5-minute load hangs |
| Splash screen 8s timeout | Map `tilesloaded` never fires if network fails — must force-hide |
| Google Fonts loaded async on mobile | Blocked page render when loaded synchronously |
| `checkHasRoad` removed from mobile | Added extra AI call per photo, doubled scan time |
| Level line stripped from analysis display | Already shown in header; showing it in body caused confusion when user overrode rating |
| Lane layout off by default | AI accuracy ~75-80%, not critical for crack seal |
| Pull-to-refresh on handle only | Map touch events triggered accidental refreshes |
| Double-pull required to refresh | Single pull too easy to trigger accidentally |
| FABs hide when sheet is full | Sheet covers FABs at full height — hidden automatically |
| Toggle pills 2×2 grid | 4 in a row was too tight to read |
| Project Type pill full width | Needs its own row — `flex: 1 1 100%; max-width: 100%` |
| Scan Model moved to Advanced | Reduces clutter in main settings |
| No chips/presets for AI instructions | Free-text textarea is sufficient |
| Calibration prompt in lightbox | Detail panel hidden when lightbox is open |
| AI route optimization removed | Cal has 14 years construction experience — patterns are known, not learned. Manual ordering via click-on-map is better. |
| Route order is manual only | Office sets stop numbers on desktop, workers follow. Arterials left unordered (too many factors: permits, traffic, lane closures). |
| Half stops (.5) via right-click desktop / ½ toggle mobile | Some streets worked in two passes with a connecting street in between — 2.5 means "return to finish after stop 3" |
| Order notes = AI training data | Cal types why each street is next ("connects to stop 2", "do before traffic"). Will feed future "Suggest Route" AI feature after 5-10 projects. |
| Import geocoding ~70-75% accurate | Mill Valley streets are short and close together. Cross-street intersections sometimes snap to wrong block. "NORTH END"/"SOUTH END" are not real intersections — app uses start point only for those. |
| Project name on its own row | Was cramped on same row as action buttons — now dropdown is full-width row, buttons below |

---

## 19. Current Version

- **Desktop:** v226 (app.js v194, style.css v182)
- **Mobile JS:** v48, mobile.css v4
- **Service Worker:** v2

Check `index.html` for `?v=XXX` on stylesheet + app.js script.
Check `mobile.html` for `?v=XXX` on mobile.js script.

> **Note to AI:** When Cal says "deploy" or "push live", use `/git-deploy`. Always bump version numbers in `index.html` AND `mobile.html` before deploying.

## 20. Pending / Next Steps

- **AI scanning regression** — Cal reported streets added on desktop are not being rated (street adds but no rating). AI toggle is ON. Suspected cause: `checkPhotoHasRoad` or proxy issue. Needs debugging next session — ask Cal: does the scan spinner appear? What does the toast say?
- **GRSI Mill Valley import** — Cal imported the 2026 Preventative Maintenance Project street list (60 streets, Mill Valley CA) using the Import feature. Results pending review — need screenshot to compare against GRSI green map and flag streets that geocoded incorrectly.
- **Future: AI route suggestion** — after 5-10 projects of manual ordering + notes, build "Suggest Route" button that reads past order data + notes and proposes a starting order.
