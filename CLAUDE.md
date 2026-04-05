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
20. [Pending / Next Steps](#20-pending--next-steps)

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
- **Current version:** v280 (desktop app.js v245, style.css v185), mobile.js v49, schedule-map.html v339

---

## 3. File Structure

```
CrackingSealingEst/
├── index.html      — Desktop HTML: login, header, modals, panels, lightbox
├── app.js          — Desktop JS (~4500+ lines): map, AI, data, UI
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
| PDF parsing | PDF.js v3.11.174 (loaded from CDN on demand) |
| Road type detection | OpenStreetMap Overpass API |
| Geocoding | Google Maps Geocoder (JS API) — returns `partialMatch` flag |
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
  lat, lng,                  // midpoint coords (geocoded center for imported streets)
  length,                    // ft
  width,                     // ft (auto from road type)
  sqft,                      // length × width
  rating: "level-1" | "level-2" | "level-3" | "level-4" | null,
  aiRating: "level-X" | null,  // original AI rating before manual override
  roadType: "residential" | "arterial" | "highway" | "parking-lot",
  notes: "",
  beginAt: "",               // begin intersection from import (e.g. "Locust Ave")
  endAt: "",                 // end intersection from import (e.g. "E Blithedale Ave")
  analysis: "",              // AI analysis text
  adminNotes: "",
  weedAlert: bool, weedNotes: "",
  ravelingAlert: bool, ravelingNotes: "",
  rrAlert: bool,
  svImage: "url",            // thumbnail
  path: [{ lat, lng }, ...], // polyline points — null for imported/undrawn streets
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
│   + settings │  + gold dots (needs pin)     │ Overview|Photos │
│ - Tools      │  + animated pulse on select  │ |Analysis       │
│   (Pin/SV/   │                              │ (hidden until   │
│   Photo)     │  [Street View panel -        │  street select) │
│ - Search bar │   slides over map]           │                 │
│ - Street     │                              │                 │
│   list       │                              │                 │
│   (Needs     │                              │                 │
│   Pinning +  │                              │                 │
│   On Map)    │                              │                 │
└──────────────┴─────────────────────────────┴─────────────────┘
```

**Desktop Modals:** Add Street, Scan spinner, Photo Lightbox, SV Snap, Name Prompt, Refine AI, Global Settings, Report, Import Street List

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

### Import Street List (rebuilt v228+)
- **↓ Import** button in project bar opens modal
- **PDF drag-drop** — drop PDF onto dashed zone, PDF.js renders pages, GPT-4o reads table
- AI extracts: `street name - begin intersection - end intersection` for every row including duplicates
- **Review step** — list fills textarea with amber banner: "Review before importing"
- User can edit/delete lines before hitting Import
- On import: geocodes each street name in the city — checks `partialMatch` flag
- **Confident geocode** → street added with lat/lng, gold 📍 dot on map, in Needs Pinning list
- **Uncertain geocode** → skipped, shown in summary at end
- `beginAt` / `endAt` stored on street object — shown in detail panel Overview tab
- No polyline drawn — Cal pins each street manually for accuracy
- Map zooms to fit all imported streets after import
- PDF model: GPT-4o with image prompt (Gemini proxy doesn't support images)
- PDF prompt uses dash format to avoid safety filter: "street - begin - end"

### Street Drawing (Pin Mode)
- Pin.Start → click map → Pin.End → click map → name prompt
- Green crosshair cursor on start, red on end
- Right-click cancels at any time
- Street name suggested from midpoint geocode

### Map Markers
- Streets WITH a polyline path → no dot (clickable via polyline)
- Streets WITHOUT a path (needs pinning) → gold 📍 dot at geocoded center
- Gold dots disappear when street is pinned (path added)
- Photo markers still appear for streets with on-site photos

### Street List — Two Sections
- **📍 Needs Pinning** — amber tinted cards, streets imported but not drawn
- **On Map** — normal colored cards with rating
- Section headers only show when both sections have streets

### Route Ordering (Manual)
- **▶ Set Route Order** button in project bar — activates tap-to-order mode
- Left-click street on map → assigns stop number at click point (yellow badge)
- Right-click street on map → assigns half stop (e.g. 2.5) — purple badge
- After each click, note prompt expands in bar — type reason or skip
- **✓ Mark Done** in detail panel — grays out street, sorts to bottom, dims polyline
- Arterials intentionally left unordered

### AI Scanning
- Samples Street View photos every N ft along path (up to maxPhotos)
- GPT-4o or Gemini Flash via proxy
- Returns: rating (LVL 1–4), analysis text, weed/raveling/R&R alerts
- AI can be disabled per project
- Only runs on streets with a drawn path (not needs-pinning streets)

### Ratings
- LVL 1 — Good (green) / LVL 2 — Light cracks (yellow)
- LVL 3 — Heavy cracks (orange) / LVL 4 — Alligator (red)
- Override in detail panel or lightbox

### Detail Panel (3 tabs)
- **Overview** — From/To segment info (if imported), alerts, stat grid, treatment, rating selector, rescan/delete, mark done
- **Photos** — SV thumbnail, on-site photos, R&R photos, scan photo grid
- **Analysis** — AI analysis text, admin notes

### Settings (per project)
- Toggles: Wide Cracks, AI Analysis, R&R Detection, Lane Layout (2×2 grid)
- Project Type pill — full width, own row
- Advanced (collapsible): Photo Interval stepper, Max Photos stepper, Scan Model (GPT/Gemini)

### Map
- Dark theme, polylines colored by rating
- Pulsing glow on selected street
- Order number badges — yellow (full stop) or purple (half stop)

### Report
- AI-generated project summary

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
- **Live location** blue dot + accuracy circle
- **Pull-to-refresh** — double pull on sheet handle only (not map)
- **Loading splash** — shows immediately, hides when tiles load or 8s max
- **PWA installable** — manifest + service worker
- **▶ Set Route Order** in project sheet — gold order bar appears, tap streets to assign stop numbers
- **½ toggle button** in order bar — tap to switch to half-stop mode, auto-resets after each tap
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

### Streets
| Function | What |
|---|---|
| `saveStreet()` | Geocodes, detects road type, kicks off AI scan |
| `selectStreet(id)` | Opens right detail panel |
| `setRating(id, rating)` | Sets rating, logs calibration |
| `rescanStreet(id)` | Re-runs AI on existing street |
| `renderStreetList()` | Re-renders list with Needs Pinning + On Map sections |
| `updateStats()` | Recalculates header pills |

### Import
| Function | What |
|---|---|
| `openImportModal()` | Opens import modal, resets state |
| `handleImportDrop(e)` | PDF drop handler — loads PDF.js, renders pages, calls GPT-4o |
| `parseImportList(text)` | Parses "street - begin - end" or "street \| begin \| end" format |
| `runImportList()` | Geocodes each name, checks partialMatch, creates street objects |

### Map Markers
| Function | What |
|---|---|
| `placeAllMarkers()` | Only places gold dots for streets WITHOUT a path (needs pinning) |
| `fitMapToMarkers()` | Zooms map to fit all markers |

### Street Drawing
| Function | What |
|---|---|
| `startFreeHighlight()` | Activates Pin mode |
| `handleMapClick(latLng)` | Routes clicks to pin or photo mode |
| `confirmStreetName()` | Saves street, kicks off scan |
| `drawAllHighlights()` | Redraws all polylines |

### AI Scanning
| Function | What |
|---|---|
| `analyzeStreetView(street)` | Main scan — samples, fetches photos, calls AI |
| `getSamplePoints(street)` | Returns `{lat,lng,heading}` array |
| `extractRating(text)` | Parses "level-X" from AI text |

### Geocoding
| Function | What |
|---|---|
| `geocodeAddress(address)` | Promise → `{lat, lng, formatted, locationType, partialMatch}` |
| `detectRoadType(lat, lng)` | OSM Overpass → road type string |

### Helpers
| Function | What |
|---|---|
| `calcDistanceFt(p1, p2)` | Haversine in feet |
| `escHtml(str)` | XSS-safe escaping |
| `showToast(msg, dur)` | Bottom toast |

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
| `drawAllPolylines()` | Draws all streets + wide tap targets + pulse on active |
| `analyzeStreet(street)` | Full AI scan (same logic as desktop) |
| `handleMapClick(latLng)` | Pin mode — first click start, second click end |
| `togglePinMode()` | Start/cancel pin drawing |
| `goToMyLocation()` | Blue dot + accuracy circle, watches position |
| `startPhoto()` | Camera — uses selected street or nearest within 2000ft |
| `filterStreetList(query)` | Real-time street list filter |
| `initPullToRefresh()` | Double pull-down on handle → reload |
| `updateHandleColor()` | Sets handle color to active street rating |

---

## 12. Project Settings Schema

| Field | Default | Description |
|---|---|---|
| `photoInterval` | `200` | Feet between scan photo capture points |
| `maxPhotos` | `6` | Max scan photos per street |
| `detectRR` | `true` | Show R&R section |
| `aiEnabled` | `true` | Run AI analysis |
| `scanModel` | `"gpt-4o"` | `"gpt-4o"` or `"gemini-2.0-flash"` |
| `aiNotes` | `""` | Per-project AI grading instructions |
| `includeWideCracks` | `false` | Wide crack detection |
| `detectLaneLayout` | `false` | Lane layout AI detection (off by default) |

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
**Note:** Gemini via proxy supports text calls only — image inputs go to GPT-4o.

---

## 14. Calibration System

1. User changes rating → `logCalibrationCorrection()` → saved to `activeProject.calibrationLog`
2. "Why did you change?" prompt appears
3. User types reason → saved with correction
4. "Refine AI" → AI reads log → generates plain-English rules
5. Rules saved to `activeProject.calibrationRules` → injected into every future scan

---

## 15. Street Drawing (Pin Mode)

**Desktop:** Pin.Start button → green crosshair cursor → click start → red crosshair → click end → name modal

**Mobile:** Tap Pin FAB → tap start on map → tap end → name sheet

**Shared:**
- Midpoint geocoded for name suggestion
- Name confirmation always shown
- Right-click (desktop) or Cancel button (mobile) exits pin mode

---

## 16. Photo Systems

| Type | Array | Added Via | Shown In |
|---|---|---|---|
| On-Site | `street.photos` | Camera → file input | Detail "On-Site Photos" |
| R&R | `street.rrPhotos` | R&R button or SV snap | Detail "R&R Photos" |
| Scan | `street.scanPhotos` | Auto during AI scan | Detail scan photo grid |

---

## 17. Street View Integration

### Modes
1. **Scan mode** — automatic in `analyzeStreetView()`, not user-visible
2. **Interactive** — user drags worker figure → drops on map
3. **Retake** — from lightbox → SV opens at photo coords → "Replace Photo"

### Desktop
- SV panel slides in from right over map
- Toolbar: Back | Snap Photo | Snap R&R | Replace Photo

### Mobile
- SV full-screen overlay, same toolbar

---

## 18. Known Decisions & Rules

| Decision | Reason |
|---|---|
| Midpoint geocode for street name | Start/end near intersections gave wrong names |
| Name prompt after every draw | Auto-detect was unreliable |
| Mobile uses inline map styles not mapId | mapId requires Cloud Console config |
| Service worker caches local files only | Caching Google Fonts caused 5-minute load hangs |
| Splash screen 8s timeout | Map `tilesloaded` never fires if network fails |
| `checkHasRoad` removed from mobile | Added extra AI call per photo, doubled scan time |
| Level line stripped from analysis display | Already shown in header |
| Lane layout off by default | AI accuracy ~75-80%, not critical |
| Pull-to-refresh on handle only | Map touch events triggered accidental refreshes |
| Double-pull required to refresh | Single pull too easy to trigger accidentally |
| FABs hide when sheet is full | Sheet covers FABs at full height |
| AI route optimization removed | Cal has 14 years construction experience — manual ordering is better |
| Route order is manual only | Office sets stop numbers on desktop, workers follow |
| Half stops (.5) via right-click desktop / ½ toggle mobile | Streets worked in two passes |
| Order notes = AI training data | Feeds future "Suggest Route" AI feature |
| No auto-drawing on import | Geocoding intersection-to-intersection was ~70% accurate — diagonal lines appeared on map. Now: only street name geocoded, Cal pins exact segment |
| Import confidence check via `partialMatch` | If geocoder isn't sure, don't place dot on map — list only |
| Gold dots for needs-pinning streets | Shows Cal where each imported street approximately is so he can click and pin |
| Streets with polylines get no dot | Polyline itself is clickable — dot is redundant and clutters map |
| PDF import uses GPT-4o not Gemini | Cloudflare Worker proxy only supports text for Gemini — image inputs must use GPT-4o |
| PDF prompt uses dash format | "street \| begin \| end" format triggered GPT safety filter — "street - begin - end" does not |
| PDF prompt explicitly states column order | GPT was misreading begin/end columns — prompt now says "column 1 = street, column 2 = begin, column 3 = end, read left to right" |
| beginAt/endAt stored on street | Cal needs to verify which segment of a street was imported (e.g. Elm Ave has 3 different segments in Mill Valley) |
| Project name on its own row | Was cramped on same row as action buttons |
| Scan photo base64 never stored in localStorage | Base64 scan photos fill 5MB limit fast — only URL saved, image re-fetches from proxy on demand. In-session cache via `_photoCache` |
| Gold dots are clickable (gmpClickable: true + el click listener) | AdvancedMarkerElement requires both to be clickable |
| Pin mode — multi-point with Curve toggle | Normal mode: click start → click end → saves. Curve ON: click start → click points → toggle Curve OFF → click end → saves |
| Pinning imported street updates it instead of creating new | When a needs-pinning street is selected and you pin, it updates that street's path — dot disappears, polyline appears |
| Scan auto-retries once on failure | If first scan fails, retries automatically. If both fail, street stays PENDING and shows toast |
| Street search bar at top center of map | Type to filter, Enter selects first match, Escape clears |
| Miles shown as own stat card | Added to detail panel and header stats bar |
| Scan results written to targetStreet not local copy | When pinning imported street, scan results were lost — fixed by using existingNeedsPin reference |
| Pin.End button finishes draw when 2+ points placed | Previously called stopDrawingMode() which cancelled the draw |
| Finish Line button shown after start point placed | Appears in highlight bar after first map click — easiest way to end a curved street |
| drawAllHighlights() called after scan completes | Polyline color now updates immediately when scan finishes, not on next street click |
| Map search Enter geocodes if no project match | Falls back to geocoding + panning map when typed street isn't in project list |
| Amber dot appears after address search | Temporary marker fades out after 3 seconds |
| Scan photo headings use local path segment | Curved streets now compute heading per segment — camera looks down the road not sideways |
| PDF import prompt preserves abbreviations | "Copy text exactly as printed" instruction prevents AI from expanding COP → Corte etc |
| Map image drop import | Drop a screenshot into import modal — AI reads street name labels and places gold dots |
| Import skips already-pinned streets | Streets with a drawn path are never overwritten by import |
| Delete confirm shows in right panel too | Always appears in detail panel in addition to left sidebar card |
| Geocoder uses begin intersection for precision | "Elm Ave & Catalpa Ave, Mill Valley CA" instead of just street name — falls back to name-only if needed |
| Auto-pin from PDF table | Import geocodes begin + end intersections separately, stores as beginLatLng/endLatLng — green/red dots on map, Pin.Start auto-fills both endpoints |
| Geocoder retry chain | begin intersection → end intersection → street name only → skip. 300ms between calls. Streets skipped only after all 3 fail |
| Skipped streets modal stays open | If any streets skipped during import, modal doesn't auto-close — shows amber list, user dismisses manually |
| Overall rating = mode of photo ratings | Most common photo rating wins. Falls back to AI verdict if no photo ratings returned. Already-scanned streets need rescan to update |
| Street count splits comma-names | Multi-name entries like "Plymouth Ave, Valley Cir, Surrey Ave" count as 3 in stat bar — sq ft is not multiplied, only the count |
| Onsite Photo button removed from desktop | Office-only context — SV snap covers photo capture. `startFreePhoto()` still in app.js but no button wired to it |
| Top search bar handles both street filter + geocode | Single input: typing filters project streets with dropdown; Enter geocodes if no project match |
| NB/SB badge computed from path heading | Not stored in name — calculated live from polyline direction. Miller NB and Miller SB are two separate street entries, each counts as 1 |

---

## 19. Current Version

- **Desktop:** v280 (app.js v245, style.css v185)
- **Mobile JS:** v49, mobile.css v4
- **Service Worker:** v2
- **Schedule Map:** v306 (schedule-map.html)

Check `index.html` for `?v=XXX` on stylesheet + app.js script.
Check `mobile.html` for `?v=XXX` on mobile.js script.

> **Note to AI:** When Cal says "deploy" or "push live", use `/git-deploy`. Always bump version numbers in `index.html` AND `mobile.html` before deploying.

---

## 20. Pending / Next Steps

### PavementScan (Desktop/Mobile)
- **Next: "Recalculate All Ratings" button** — apply mode logic to already-scanned streets without rescanning. One button in project bar.
- **Next: Remove "Take Photo" button from right panel detail view on desktop** — useless in office context.
- **Next: Mobile search bar merge** — mobile still has separate "Find street" overlay, needs same merge as desktop v275.
- **Next: CSV export** — dump all streets, ratings, sq ft, lengths into a spreadsheet for city/client handoff.
- **Next: Rescan all PENDING** — button to kick off scans on every pinned street with no rating yet.
- **Next: Calibration rules viewer** — show active AI rules, allow deleting bad ones.
- **Future: AI route suggestion** — after 5-10 projects of manual ordering + notes, build "Suggest Route" button that reads `order`, `orderNote`, `orderClickPt` data.
- **Future: backend/cloud storage** — currently localStorage only, no cross-device sync. Export/Import is the workaround.

### Schedule Map Tool (`schedule-map.html`) — GRSI Newark 2025
- **What it is:** Standalone page for GRSI's Newark 2025 Citywide Slurry Seal Project. Upload color-coded schedule images → AI extracts street names + dates → place colored labels on clean master map → export PDF.
- **Accessible from:** PavementScan header → "📋 Schedule Map" button
- **Live URL:** https://autobuildcharlie.github.io/PavementScan/schedule-map.html
- **GRSI contact:** Terri — waiting on full 60-page plan PDF (71MB, too big for email — Terri finding a way to share via Drive/WeTransfer)
- **Project:** City of Newark, Alameda County — 2025 Citywide Slurry Seal Project CIPA10005.FY2025
- **What AI extracted:** 61 streets from the color-coded schedule PDF (MK - MASTER MAP file). Grouped by day correctly (4/13 Mon through 5/5 Tue).
- **Schedule dates:** Weeks of 4/13, 4/21, 4/27, and 5/4
- **Background map issue:** MK-MASTER MAP PDF only has the cover sheet (Location Map is small/embedded). Full plan sheets (pages 3–59) have individual zoomed-in maps with street names — waiting on Terri to share those.
- **Workaround for now:** Screenshot/crop just the Location Map from the cover sheet and upload that as background image instead of the full PDF.

### Schedule Map — How It Works
1. **Step 1:** Upload color-coded schedule images/PDF → AI reads each page → extracts `{name, date, day, color, split}` → deduped list appears in right panel
2. **Step 2:** Set PDF page number (default 1) → upload clean map image or PDF → renders as background
3. **Step 3:** Click street name in right panel → click on map → colored label drops at that spot. Drag to reposition. Double-click to remove.
4. **Export PDF:** `window.print()` → save as PDF. Schedule list prints alongside map.

### Schedule Map — Known Decisions
| Decision | Reason |
|---|---|
| PDF page selector on Step 2 | Cover sheet loads as page 1 by default — user needs to specify which page has the actual map |
| Labels are manually placed | Auto-geocoding wouldn't align to the GRSI map image coordinates |
| Drag-and-drop on both zones | Easier than click-to-browse for large PDF files |
| Split streets show ★ badge | Half-street work days noted without duplicate entries |
| All pages sent to AI individually | Multi-page PDFs — each page is a separate schedule week |
| Overpass delay 1.5s between streets | Overpass rate-limits (429/504) at faster rates — 1.5s keeps it stable |
| Overpass auto-retry on 429/504 | Waits 4-8s and retries up to 3x before giving up on a street |
| Abbreviation expansion before Overpass | OSM sometimes stores full names (Drive vs Dr) — try both forms |
| Case-insensitive Overpass regex | `["name"~"^name$",i]` — note: `i` not `"i"` (quoted i = 400 Bad Request) |
| Full Newark street cache | One Overpass query fetches all named ways in Newark → local fuzzy match for not-found streets |
| Word overlap fuzzy match threshold 0.67 | 2 of 3 words must match — handles typos like "Sant Luke" → "St Luke" |
| Upgrade pills to polylines button | Streets placed by geocoder (pill labels) can be upgraded to real Overpass road lines |
| Plan PDF skips pages 1-3 | Pages 1-3 are cover, legend, site index — no segment data |
| Plan PDF renders at scale 1.2 | Lower than default 2.0 — 60% less memory, still readable for AI |
| Plan PDF renders 1 page at a time | Render → send → discard — keeps browser memory flat for 60-page PDFs |
| Dates come from schedule screenshots not plan PDF | Plan PDF shows WHERE, not WHEN. Dates/colors from color-coded overview map Cal screenshotted |
| NewPark Mall/Plaza never found | They're a shopping mall/parking lot — not in OSM as road names. Leave as not-found |
| Source tracking on segment data | Each extracted segment tagged with plan page number + confidence level |
| Click polyline = info popup | Shows name, date, segment from→to, source page, confidence. Click map to close |

### Schedule Map — Current Architecture (v311)
- **Background:** Real Google Map centered on Newark, CA
- **Step 1 (NEW):** Upload plan PDF → AI reads every page → extracts `{name, from, to, confidence, sourcePage}` → saved to `savedSegments` in localStorage → nothing drawn on map yet
- **Step 2 (NEW):** Upload color-coded schedule map image → AI reads colors + dates, gets known street list from savedSegments as context → creates streets with color/date → places on map with clipped segments
- **Export/Import:** ⬇ Export button saves all data (streets + days + savedSegments) to JSON file. ⬆ Import loads it back — survives hard refreshes and updates.
- **Clear Streets button:** Wipes placed streets + colors but keeps savedSegments from plan PDF
- **Segment Review panel:** After Step 1, click "Review" link → overlay shows all 172 segments, sorted low-confidence first. Shows name, from→to, plan page number.
- **Placement chain:** Overpass exact → Overpass expanded abbreviations → fuzzy match against full Newark cache → Google geocoder → not-found
- **Save state:** All placed streets + paths + savedSegments saved to localStorage
- **Week filter:** All | Week 1 | Week 2 etc — auto-detected from dates
- **Not-found banner:** Expandable list showing all failed streets + retry button
- **Click polyline:** Info popup shows name, date, segment from→to, source page, confidence flag
- **Double-click polyline:** Removes it from map
- **Print/Export PDF:** `window.print()` → full map + legend

### Schedule Map — GRSI Newark 2025 Status (as of v339 session)
- **Plan PDF:** 250708- Newark 2025 Citywide Slurry Seal Plans.pdf (71MB, in Cal's Downloads folder)
- **PDF structure:** Page 1 = overview street map (thick black segments), Page 3 = site index map (numbered boxes), Pages 4-60 = zoomed-in plan sheets
- **Plan PDF skips pages 1-3** — AI starts reading at page 4
- **Plan PDF re-uploaded this session** with improved AI prompt — now correctly skips background context streets, only extracts gray-shaded treatment roads
- **Export JSON:** Cal has saved `newark-schedule-2026-04-05 (2).json` in Downloads — use this to skip re-uploading the 71MB PDF
- **~104 streets placed, 11 not found** after retry — not-found streets are small residential streets not in OpenStreetMap (Mindewine Dr, Port Tidelwood Pl, Port Tidelwood St, Mote Dr, Arquilla Ct, Tampico Pl, Eva St, Albion Ct, Garner Ave, Aldrin Ct, Munyan Dr)
- **Clipping status:** Streets draw FULL (not clipped to exact segment). Clipping was tried twice (v316, v324) — both caused diagonal lines — reverted. Full streets is permanent decision.
- **Map is light mode** — switched from dark theme this session for better print quality
- **Street labels:** Bold black text only, no pill background, white outline for readability. Labels appear on print via beforeprint temporary overlays.
- **Print workflow:** 🖨 Print Section (map only, no legend) + 🖨 Print+Legend. User zooms to each area and prints sections to assemble a big map.
- **Manual pin mode:** ✏ Draw button on each not-found street — click start + end on map to draw manually
- **Search bar:** Type to filter street list, Enter pans map to first match
- **Retry not-found:** Uses full per-street Overpass + Google geocode + around:120 fallback (slow but accurate — Cal prefers accuracy over speed always)
- **Current state:** Functional. Color schedule not yet uploaded — streets are gray (no color/date). 11 streets still not found, can be manually drawn.
- **Next session:** Upload color schedule → streets get colored by week. Manually draw remaining 11 not-found streets using ✏ Draw. Export fresh JSON after.

### Schedule Map — Known Decisions (updated)
| Decision | Reason |
|---|---|
| Plan PDF first, color schedule second | Plan PDF gives exact segments reliably. Color map AI was adding wrong streets. |
| savedSegments persisted to localStorage | So plan PDF doesn't need to be re-uploaded when adding more streets |
| Export/Import JSON button | Hard refreshes wipe localStorage — export saves everything to a file |
| Clear Streets keeps savedSegments | User needs to wipe bad color data without losing 71MB PDF extraction |
| Segment review panel | Shows all 172 extracted segments with confidence flags so user can spot errors |
| Color map AI reading abandoned | Too unreliable — reads background street labels as colored segments, confuses red/orange, creates duplicates |
| Full streets drawing instead of clipped | Both geocoder-based and local OSM intersection clipping were tried. Local approach caused diagonal lines (threshold too loose, parallel streets matched as intersections). Full streets is the current fallback. |
| Google Maps still in use | Despite issues, still the base map — may revisit if better approach found |
| Plan PDF pages 1-3 skipped | Page 1 = overview map, Page 3 = site index — no segment data on these pages |
| Batch geocoding uses single Overpass cache call | Fetching all Newark streets in one call then matching locally = 3 seconds vs minutes of 429 errors. Never make per-street Overpass calls for batch operations. |
| Place All Streets button added | Draws all segments from savedSegments as gray polylines without needing a color schedule. Deduplicates by name, skips already-placed streets. |
| matchline/edge-of-page skipped in geocodeIntersection | These are drafting terms not real intersections — treated same as dead end (returns null, clips from start to road end) |
| All geocoder bounds now use NEWARK_BBOX constant | Previously had 3 different hardcoded bounds — now all reference one constant for consistency |
| Geocoder promises have 10s timeout | Google Maps Geocoder callback can hang indefinitely — added setTimeout(resolve(null), 10000) to both geocodeStreet and geocodeIntersection |
| Clipping permanently removed from drawFromCachedElements | Tried twice (v316, v324) — both caused diagonal lines. Full streets is the permanent decision. Never re-attempt clipping in this function. |
| Retry button calls retryNotFound() not geocodeAll() | geocodeAll() only uses fast OSM cache. retryNotFound() uses full per-street Overpass + Google geocode + around:120 fallback. Retry must always use the accurate path. |
| Cal always prefers accuracy over speed | Explicit preference stated. Never remove slow-but-accurate fallbacks for speed gains on this project. |
| Plan PDF AI prompt requires gray-filled road surface | Old prompt said "gray shaded" — AI kept picking up background context labels. New prompt explicitly says the ROAD SURFACE must be visibly filled gray, not just labeled. |
| Street labels = bold black text, no pill | Removed pill background. Labels are plain bold black text with white text-shadow outline. Applied via ScheduleLabel.onAdd() and .map-label CSS. |
| Print labels added via beforeprint | Polyline streets have no persistent label. beforeprint creates temporary ScheduleLabel overlays for all placed polyline streets. afterprint removes them. |
| Map is light mode permanently | Switched from dark theme for better print quality. MAP_STYLES only hides POI/transit now. |

### Built This Session (v322–v339)
- **v322:** Upgrade pill labels — added per-street Overpass fallback in upgrade flow
- **v323:** No fake results — removed geocoder fallback, streets either get real Overpass road line or go to not-found list
- **v324:** Clipping in drawFromCachedElements using beginAt/endAt — REVERTED (caused diagonal lines again)
- **v325:** Removed per-street Overpass from upgrade (speed) — REVERTED next version (Cal wants accuracy)
- **v326:** Restored per-street Overpass fallback in upgrade — accuracy over speed
- **v327:** Reverted clipping — back to full streets, no diagonal lines
- **v328:** Hide all Google map labels on print — only custom street labels show
- **v329:** Street search bar — filters list in real-time, Enter pans map to match
- **v330:** Manual pin mode — ✏ Draw button on not-found streets, click start+end on map
- **v331:** Section printing — 🖨 Print Section (map only) + 🖨 Print+Legend, print labels added to polyline streets via beforeprint
- **v332:** Street labels as bold text — no pill background, white outline, colored by schedule color
- **v333:** Labels changed to black text only (not schedule color)
- **v334:** Switched to light map — dark theme removed, better for printing
- **v335:** Smarter name matching — Saint/St swap, plural handling (Edward/Edwards), substring word overlap
- **v336:** Fixed plan PDF AI prompt — only extract streets with visibly gray-filled road surface, skip context labels
- **v337:** ✏ Draw + × Delete buttons added directly to not-found banner
- **v338:** Google geocode + Overpass around:120 fallback — Google finds location, Overpass confirms real road geometry
- **v339:** Fixed retry button — now calls retryNotFound() which uses full drawStreetFromOverpass (with Google+around fallback) instead of cache-only geocodeAll

### Built Previous Sessions (v312–v321)
- **v312:** Fixed clipping — skip matchline/edge-of-page/edge-of-map as geocodable endpoints
- **v313:** Added **▶ Place All Streets** button — draws all 115 segments from plan PDF as gray lines without needing a color schedule
- **v314:** Fixed geocodeAll — load Newark cache once upfront, no per-street Overpass calls (3 seconds vs minutes)
- **v315:** Fixed upgradePillsToPolylines — same cache-first fix, no per-street Overpass calls
- **v316:** Applied segment clipping in drawFromCachedElements — geocodes begin/end intersections before drawing
- **v317:** Widened Newark bbox, removed double bounds check on geocoder
- **v318:** Local OSM intersection clipping — find cross point using cached geometry (no API calls) — REVERTED, caused diagonal lines
- **v319:** Reverted clipping — draw full streets cleanly
- **v320:** Audit fixes — res.ok checks on all fetches, geocoder timeouts (10s), consistent Newark bounds, spinner error handling, Fit All feedback toast
- **v321:** Fixed ScheduleLabel polyline removal order + handlePlanUpload try/catch indent

### Built Previous Sessions (v307–v311)
- **v307:** savedSegments persisted to localStorage, auto-apply to new streets on manual add
- **v308:** Flipped flow — Step 1 = Plan PDF (saves segments, draws nothing), Step 2 = Color Schedule (creates + draws streets)
- **v309:** Segment review panel — overlay shows all extracted segments sorted low-confidence first
- **v310:** Clear Streets button — wipes placed streets but keeps savedSegments
- **v311:** Export/Import buttons — save all data to JSON file, reload anytime without re-uploading PDF

### Built Previous Sessions (v278–v306)
- **v278:** Created `schedule-map.html`. Added "📋 Schedule Map" button to PavementScan header.
- **v279-v293:** PDF upload, Google Maps, Overpass polylines, geocoder fallback, week filters, save state
- **v294-v306:** Abbreviation expansion, Newark street cache, fuzzy matching, Overpass retry logic, plan PDF Phase 2 (segment extraction + clipping)

### Built Previous Sessions (v278–v293)
- **v278:** Created `schedule-map.html`. Added "📋 Schedule Map" button to PavementScan header.
- **v279:** PDF drag-and-drop, PDF.js rendering for Step 1 and Step 2.
- **v280:** PDF page number selector for Step 2.
- **v281:** Replaced image background with real Google Map, auto-geocode after extraction.
- **v282:** Amber not-found banner, Newark bounding box for geocoder.
- **v283-284:** Print exports full map only, light map style for paper handoff.
- **v285:** Print legend panel with dates, colors, street list.
- **v286:** Save state to localStorage, color key overlay, Fit All button.
- **v287:** Switched to Maps JS Geocoder.
- **v288-289:** Replaced AdvancedMarkerElement with custom OverlayView (ScheduleLabel).
- **v290:** Fixed "google is not defined" — ScheduleLabel defined inside initMap callback.
- **v291:** Hide POI/transit icons from map.
- **v292:** Overpass API polylines, hard Newark bounds, geocoder fallback, paths saved to localStorage.
- **v293:** Week filter buttons (All/Week 1/Week 2 etc).
