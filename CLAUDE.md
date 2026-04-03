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
- **Current version:** v256 (desktop app.js v225, style.css v184), mobile.js v49

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

---

## 19. Current Version

- **Desktop:** v274 (app.js v242, style.css v184)
- **Mobile JS:** v49, mobile.css v4
- **Service Worker:** v2

Check `index.html` for `?v=XXX` on stylesheet + app.js script.
Check `mobile.html` for `?v=XXX` on mobile.js script.

> **Note to AI:** When Cal says "deploy" or "push live", use `/git-deploy`. Always bump version numbers in `index.html` AND `mobile.html` before deploying.

---

## 20. Pending / Next Steps

- **GRSI Mill Valley project** — Cal finished marking streets for the Mill Valley 2026 Preventative Maintenance Project. All streets pinned.
- **Pin workflow** — Click gold dot → select street → Pin.Start → click start → click curve points (Curve ON) → hit green Finish Line button → name prompt → dot disappears → polyline appears → AI scans automatically.
- **Finish Line button** — appears in highlight bar after first map click, stays visible until street is saved. Easiest way to end a curved street without toggling Curve OFF.
- **Map image import** — drop a screenshot of a pavement plan map into import modal → AI reads street name labels → geocodes them → places gold dots. Already-pinned streets are skipped.
- **Geocoder + intersection** — import geocodes begin and end intersections separately. Green dot = start, red dot = end. Pin.Start auto-fills both endpoints so Cal just hits Finish Line.
- **Built (v271): Retry chain** — geocoder now tries: begin intersection → end intersection → street name only → skip. 300ms delay between each call. Streets are skipped only after all 3 options fail. If only one intersection resolves, that point is used as the gold dot instead of falling back to a redundant street name geocode.
- **Future: AI route suggestion** — after 5-10 projects of manual ordering + notes, build "Suggest Route" button that reads `order`, `orderNote`, `orderClickPt` data.
- **Future: backend/cloud storage** — currently localStorage only, no cross-device sync. Export/Import is the workaround. Backend would enable desktop↔mobile sync.
