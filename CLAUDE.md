# PavementScan — Project Reference (CLAUDE.md)

> **For AI use.** All project context lives here — no need to check external memory files.

---

## Table of Contents

1. [What Is PaveScan](#1-what-is-pavescan)
2. [Live URL & Deployment](#2-live-url--deployment)
3. [File Structure](#3-file-structure)
4. [Tech Stack](#4-tech-stack)
5. [Data Schema](#5-data-schema)
6. [UI Layout](#6-ui-layout)
7. [Features List](#7-features-list)
8. [Key Functions Reference](#8-key-functions-reference)
9. [Project Settings Schema](#9-project-settings-schema)
10. [AI Scanning System](#10-ai-scanning-system)
11. [Calibration System](#11-calibration-system)
12. [Street Drawing (Pin Mode)](#12-street-drawing-pin-mode)
13. [Photo Systems](#13-photo-systems)
14. [Street View Integration](#14-street-view-integration)
15. [Known Decisions & Rules](#15-known-decisions--rules)
16. [Current Version](#16-current-version)

---

## 1. What Is PaveScan

A pavement assessment tool built for crack seal and slurry seal contractors (e.g. Cal's company). Field workers drive streets, the app auto-collects Street View photos along the route, sends them to an AI model, and returns a condition rating (LVL 1–4). The app tracks square footage, generates reports, and helps prioritize which streets need treatment.

**Login:** username `Cal.Zentara` / passcode `0911`

---

## 2. Live URL & Deployment

- **Live:** https://autobuildcharlie.github.io/PavementScan/
- **Repo:** GitHub Pages — auto-deploys on push to `master`
- **Deploy command:** `/git-deploy` or manual `git add . && git commit -m "..." && git push`
- **Version tag convention:** bump version number in `index.html` on `<link rel="stylesheet">` and `<script src="app.js">` query strings (e.g. `?v=142`)

---

## 3. File Structure

```
PavementScan/
├── index.html       — All HTML: login, header, modals, panels, lightbox
├── app.js           — All JavaScript (~3940 lines): map, AI, data, UI
├── style.css        — All CSS: dark theme, layout, components
└── CLAUDE.md        — This file
```

No build system. No npm. No dependencies except Google Maps JS API (loaded via script tag) and the AI worker proxy.

---

## 4. Tech Stack

| Layer | What |
|---|---|
| Maps | Google Maps JavaScript API (`mapId: f2e86140855a96ecc6c0576f`, dark theme) |
| Street View photos | Google Street View Static API (via proxy) |
| AI analysis | GPT-4o or Gemini Flash via Cloudflare Worker proxy |
| AI proxy URL | `https://cse-worker.aestheticcal22.workers.dev` |
| Road type detection | OpenStreetMap Overpass API |
| Geocoding | Google Maps Geocoder (JS API) |
| Persistence | `localStorage` only — no backend database |
| Auth | Simple sessionStorage flag (`cse_auth = '1'`) |
| Fonts | Inter (Google Fonts) |
| Deployment | GitHub Pages |

---

## 5. Data Schema

### localStorage Keys

| Key | Contents |
|---|---|
| `cse_projects` | Array of all project objects (JSON) |
| `cse_active_project` | UUID string of the selected project |
| `cse_global_settings` | `{ globalAiNotes: string }` |

### Project Object

```js
{
  id: "uuid",
  name: "Anaheim Q2 2026",
  type: "crack-seal" | "slurry" | "both",
  streets: [ ...street objects... ],
  createdAt: "ISO string",

  // per-project settings (with defaults):
  photoInterval: 200,        // ft between scan photo samples
  maxPhotos: 5,              // max scan photos per street
  detectRR: true,            // show R&R section
  aiEnabled: true,           // run AI analysis on scan
  scanModel: "gpt",          // "gpt" | "gemini"
  aiNotes: "",               // per-project AI instructions
  detectWideCracks: false    // wide crack detection flag
}
```

### Street Object

```js
{
  id: "uuid",
  name: "W Crestwood Ln",
  lat, lng,                  // midpoint coords
  length,                    // ft (user-entered or auto)
  width,                     // ft (auto from road type)
  sqft,                      // length × width
  rating: "level-1" | "level-2" | "level-3" | "level-4" | null,
  roadType: "residential" | "arterial" | "highway" | "parking-lot",
  notes: "",                 // user notes
  analysis: "",              // AI analysis text
  adminNotes: "",            // internal notes
  weedAlert: bool,
  weedNotes: "",
  ravelingAlert: bool,
  ravelingNotes: "",
  svImage: "url",            // thumbnail for list
  path: [{ lat, lng }, ...], // highlight polyline points
  photos: [...],             // on-site photos (see below)
  rrPhotos: [...],           // R&R photos
  scanPhotos: [...],         // AI-analyzed Street View photos
  photoRatings: {},          // { photoIndex: "level-X" }
  scannedAt: "ISO string",
  createdAt: "ISO string"
}
```

### Photo Object (on-site photos)

```js
{
  id: "uuid",
  dataUrl: "base64",
  lat, lng,
  address: "",
  note: "",
  rating: "level-X" | null,
  takenAt: "ISO string"
}
```

### Scan Photo Object

```js
{
  url: "sv static url",
  hdUrl: "sv static url (larger)",
  label: "N at 123ft",
  lat, lng
}
```

---

## 6. UI Layout

```
┌──────────────────────────────────────────────────────────┐
│ HEADER: logo | stats pills | Report btn | Global Settings│
├──────────────┬───────────────────────────┬───────────────┤
│ LEFT PANEL   │        MAP (center)        │ RIGHT PANEL   │
│ - Project    │  Google Maps dark mode     │ Street Detail │
│   selector   │  + polyline overlays       │ (hidden until │
│   + settings │  + photo markers           │  street       │
│ - Streets    │                            │  selected)    │
│   list       │  [Street View panel -      │               │
│ - Search bar │   slides over map]         │               │
│ - Quick      │                            │               │
│   actions    │                            │               │
│   (Pin/SV/   │                            │               │
│   Photo)     │                            │               │
└──────────────┴───────────────────────────┴───────────────┘
```

**Modals (overlays):**
- Add Street — name + length input
- Scan (spinner) — while AI runs
- Photo Lightbox — view/rate/delete/retake any photo
- SV Snap modal — save a Street View screenshot to a street
- Name Prompt — confirm street name after Pin.End
- Refine AI modal — shows generated calibration rules
- Global Settings modal — global AI instructions textarea
- Report modal — full project PDF-style report

---

## 7. Features List

### Core
- Multi-project support — create, rename, delete, switch projects
- Per-project type: crack seal / slurry / both
- Street list with search
- Add street by address (auto-geocodes, detects road type + width)
- Stats bar: total streets, sq ft, sq yards, avg rating

### Street Drawing (Pin Mode)
- Pin.Start / Pin.End button in sidebar
- Click map to drop start point (green crosshair cursor), click again for end (red crosshair cursor)
- Draws a polyline on the map along the route
- After Pin.End, shows "Name This Street" confirmation prompt
- Right-click on map cancels drawing mode at any time

### AI Scanning
- Samples Street View photos along the street path (every N ft, up to max photos)
- Sends photos to AI (GPT-4o or Gemini Flash) for pavement condition analysis
- Returns: overall rating (LVL 1–4), analysis text, weed/raveling/R&R flags
- Per-project settings control photo interval and max photo count
- AI can be disabled per project (still captures photos, no analysis)

### Ratings
- LVL 1 — Good condition
- LVL 2 — Light cracks
- LVL 3 — Heavy cracks
- LVL 4 — Alligator cracking
- Color coded: green / yellow / orange / red
- Rating can be manually overridden in detail panel or lightbox

### Calibration System
- When user changes a rating, logs the correction
- Shows "Why did you change this?" prompt (in lightbox or detail panel)
- "Refine AI" button generates custom rules from correction history
- Rules get injected into all future AI prompts

### Global AI Instructions
- Gear icon in header → Global Settings
- Free-text box for grading standards that apply to every scan
- Injected into every AI prompt across all projects

### Photo Systems
- **On-Site Photos** — taken from phone camera in the field; shown in detail panel under "On-Site Photos"; named "StreetName (1)", "StreetName (2)"...
- **R&R Photos** — remove & replace documentation photos (only shown if `detectRR` is on)
- **Scan Photos** — Street View static images captured automatically during AI scan; shown in detail panel grid

### Street View
- Toggle Street View mode from sidebar
- Click anywhere on map to open Street View at that location
- "Snap Photo" — saves current SV view as an on-site photo or R&R photo
- "Retake Photo" — replaces a specific scan photo with current SV angle

### Lightbox
- Opens for on-site photos, R&R photos, or scan photos
- Rate, add note, delete, navigate prev/next
- Retake button (for scan photos only) — opens Street View at that photo's location
- Changing rating in lightbox updates street rating + triggers calibration prompt

### Map Features
- Dark map theme
- Street polylines colored by rating
- Photo markers on map (camera icon)
- Animated pulse on selected street
- Fit map to all markers button
- Search by address / intersection

### Report
- AI-generated project summary report
- Lists all streets with ratings, sq ft, recommended treatment
- Shows totals and project overview

### Advanced Settings (per project, collapsible)
- AI Instructions textarea
- Toggle: Detect R&R / Wide Cracks / AI enabled
- Photo Interval stepper (+/- buttons, default 200 ft)
- Max Photos stepper (+/- buttons, default 5)
- Scan model selector (GPT / Gemini)

---

## 8. Key Functions Reference

### Auth & Init
| Function | What it does |
|---|---|
| `doLogin()` | Validates credentials, sets sessionStorage flag, calls `initMap()` |
| `initMap()` | Google Maps init, loads projects, sets up listeners |

### Projects
| Function | What it does |
|---|---|
| `loadProjects()` | Reads from localStorage, sets `activeProject` |
| `saveProjects()` | Writes all projects to localStorage |
| `createProject(name, type)` | Creates new project with defaults |
| `switchProject(id)` | Changes active project, re-renders everything |
| `deleteProject(id)` | Confirm + delete |
| `renameProject(id)` | Inline rename in selector |
| `renderProjectSelector()` | Re-renders the whole left-panel project bar + settings |
| `toggleSettingsCollapse()` | Collapses/expands settings section |
| `toggleAdvanced()` | Collapses/expands advanced settings subsection |
| `savePhotoInterval(v)` | Saves interval, re-renders selector |
| `saveMaxPhotos(v)` | Saves max, re-renders selector |
| `toggleRR()` / `toggleAI()` / `toggleWideCracks()` | Toggle per-project flags |
| `setScanModel(model)` | Sets "gpt" or "gemini" |

### Streets
| Function | What it does |
|---|---|
| `saveStreet()` | Reads modal inputs, geocodes address, detects road type, kicks off AI scan |
| `selectStreet(id)` | Opens right detail panel for a street |
| `closeDetailPanel()` | Hides right panel |
| `setRating(id, rating)` | Manually sets street rating, logs calibration if AI rating existed |
| `deleteStreet(id)` / `confirmDelete(id)` | Delete with confirmation |
| `rescanStreet(id)` | Re-runs AI analysis on existing street |
| `renderStreetList()` | Re-renders the left-panel street list |
| `updateStats()` | Recalculates header stat pills |

### Street Drawing
| Function | What it does |
|---|---|
| `startFreeHighlight()` | Activates Pin.Start mode, sets cursor |
| `cancelHighlight()` / `stopDrawingMode()` | Exits drawing mode, clears temp elements |
| `handleMapClick(latLng)` | Routes clicks to highlight or photo mode |
| `saveHighlightedStreet(startPt, endPt)` | Geocodes midpoint, shows name prompt |
| `promptStreetName(street, suggestedName)` | Shows name confirmation modal |
| `confirmStreetName()` | Saves name to pending street and stores it |
| `setMapCursor(cursorClass)` | Forces custom SVG cursor onto Google Maps internal canvas |
| `drawAllHighlights()` | Redraws all street polylines on map |

### AI Scanning
| Function | What it does |
|---|---|
| `analyzeStreetView(street)` | Main scan function — samples points, fetches SV photos, calls AI |
| `getSamplePoints(street)` | Returns array of { lat, lng, heading } for photo capture |
| `getStreetViewUrl(lat, lng, heading)` | Builds SV Static API URL |
| `fetchSVMetadata(lat, lng)` | Checks if SV imagery exists at a location |
| `checkPhotoHasRoad(base64)` | Pre-filter — skips non-road images |
| `extractRating(text)` | Parses "level-X" from AI response |
| `extractPhotoRatings(text, count)` | Parses per-photo ratings from AI |
| `recalcRatingFromPhotos(streetId)` | Recalculates street rating from individual photo ratings |

### Calibration
| Function | What it does |
|---|---|
| `logCalibrationCorrection(street, aiRating, calRating)` | Saves correction to localStorage |
| `showReasonPrompt()` | Shows "why did you change?" prompt — in lightbox or detail panel |
| `dismissReasonPrompt()` | Hides prompt |
| `saveCalibrationReason()` | Saves reason text to correction log |
| `openRefineAIModal()` | Calls AI to generate rules from correction log |
| `applyCalibrationRules()` | Saves generated rules to localStorage |
| `clearCalibrationRules()` | Clears all rules |

### Photos
| Function | What it does |
|---|---|
| `openPhotoCapture(streetId)` | Opens hidden file input for on-site photo |
| `handlePhotoCapture(e, streetId)` | Compresses + stores photo, re-renders |
| `openRRPhotoCapture(streetId)` | Same for R&R photos |
| `deletePhoto(streetId, photoId)` | Deletes on-site photo |
| `deleteRRPhoto(streetId, photoId)` | Deletes R&R photo |
| `deleteScanPhoto(streetId, index)` | Deletes one scan photo |
| `retakeScanPhoto(streetId, photoIndex)` | Enters retake mode, opens Street View |
| `snapRetake()` | Replaces scan photo with current SV angle |
| `setOnSitePhotoRating(streetId, photoId, rating)` | Updates rating on on-site photo |
| `setPhotoRating(streetId, photoIndex, rating)` | Updates rating on scan photo |

### Lightbox
| Function | What it does |
|---|---|
| `openLightbox(photos, idx, streetId, arrayName, rrMap)` | Opens lightbox for any photo array |
| `lightboxNav(dir)` | Navigate -1 or +1 |
| `lightboxSetRating(value)` | Updates rating from lightbox select |
| `lightboxDeletePhoto()` | Deletes current photo |
| `lightboxRetakePhoto()` | Triggers retake flow from lightbox |
| `lightboxSaveNote()` | Saves text note to current photo |
| `closeLightbox()` | Hides lightbox |
| `_renderLightbox()` | Internal — re-renders lightbox content for current index |

### Street View
| Function | What it does |
|---|---|
| `toggleStreetView()` | Enables SV click mode |
| `openStreetViewAt(lat, lng, heading)` | Opens SV panel at coords |
| `snapStreetView(isRR)` | Captures current SV frame, opens save modal |
| `saveSnap()` | Saves snapped photo to street |
| `closeStreetViewPanel()` | Closes SV panel, returns to map |

### Report
| Function | What it does |
|---|---|
| `generateProjectReport()` | Builds prompt, calls AI, renders HTML report in modal |
| `closeReport(e)` | Closes report modal |

### Helpers
| Function | What it does |
|---|---|
| `geocodeAddress(address)` | Promise wrapper for Google geocoder |
| `detectRoadType(lat, lng)` | OpenStreetMap query for highway tag → maps to road type |
| `calcDistanceFt(p1, p2)` | Haversine distance in feet |
| `escHtml(str)` | XSS-safe HTML escaping |
| `formatNumber(n)` | Locale number formatting |
| `showToast(msg, duration)` | Bottom toast notification |
| `getGlobalSettings()` / `saveGlobalSettings()` | Read/write global settings |

---

## 9. Project Settings Schema

All stored on the project object itself (not separate localStorage key):

| Field | Default | Description |
|---|---|---|
| `photoInterval` | `200` | Feet between scan photo capture points |
| `maxPhotos` | `5` | Max scan photos per street |
| `detectRR` | `true` | Show R&R section in detail panel |
| `aiEnabled` | `true` | Run AI analysis (false = photos only) |
| `scanModel` | `"gpt"` | `"gpt"` = GPT-4o, `"gemini"` = Gemini Flash |
| `aiNotes` | `""` | Per-project AI grading instructions |
| `detectWideCracks` | `false` | Wide crack detection toggle |

---

## 10. AI Scanning System

### How It Works

1. `getSamplePoints(street)` — samples points along the street path every `photoInterval` ft, up to `maxPhotos`
2. Each point: fetch SV metadata to confirm imagery exists
3. Download SV Static photo → convert to base64 → `checkPhotoHasRoad()` pre-filter
4. Valid photos collected → single AI call with all photos
5. AI returns: rating, analysis text, weed/raveling/R&R flags, per-photo ratings
6. Results stored on street object, re-renders detail panel

### AI Prompt Construction

Injected in order:
1. Global AI instructions (`cse_global_settings.globalAiNotes`)
2. Per-project AI notes (`activeProject.aiNotes`)
3. Calibration rules (from `cse_calibration_rules`)
4. Base system prompt (rating criteria, LVL definitions)
5. Photos as base64 image attachments

### Proxy Worker

All AI calls go through: `https://cse-worker.aestheticcal22.workers.dev`

The worker holds the actual API keys and routes to OpenAI or Google based on the model parameter.

---

## 11. Calibration System

Tracks when users override the AI's rating and learns from corrections.

**Flow:**
1. User changes rating → `logCalibrationCorrection()` saves to `cse_calibration_log`
2. `showReasonPrompt()` appears — asks "Why did you change this?"
3. User types reason → saved alongside the correction
4. User clicks "Refine AI" → `openRefineAIModal()` sends full log to AI
5. AI generates plain-English rules (e.g. "Faded striping alone is LVL 2 not LVL 1")
6. Rules saved to `cse_calibration_rules` → injected into every future scan prompt

**Where the prompt shows:**
- If lightbox is open → inside `#lightbox-calibration-reason` (inside lightbox)
- Otherwise → inside `#calibration-reason-prompt` (in detail panel)

---

## 12. Street Drawing (Pin Mode)

**Button:** `Pin.Start` → first click → becomes `Pin.End` → second click → done

**Cursor behavior:**
- Pin.Start active → green crosshair SVG cursor (via `setMapCursor('cursor-pin-start')`)
- Pin.End active → red crosshair SVG cursor (via `setMapCursor('cursor-pin-end')`)
- Must force cursor onto Google Maps internal `canvas` and `div` elements — setting it on `#map` alone doesn't work

**After drawing:**
- Geocodes midpoint via Google geocoder
- Shows "Name This Street" modal with suggested name pre-filled
- User confirms or types a new name
- Street saved, highlight polyline drawn, AI scan kicks off

**Cancel:**
- Right-click on map at any time
- Listener: `map.addListener('rightclick')` + `document.getElementById('map').addEventListener('contextmenu')`

---

## 13. Photo Systems

### Three Photo Types

| Type | Array | How Added | Shown In |
|---|---|---|---|
| On-Site Photos | `street.photos` | Camera button → file input | Detail panel "On-Site Photos" |
| R&R Photos | `street.rrPhotos` | R&R button → file input or SV snap | Detail panel "R&R Photos" (if detectRR on) |
| Scan Photos | `street.scanPhotos` | Auto during AI scan | Detail panel scan photo grid |

### On-Site Photo Naming
Photos are labeled by street name + sequential number: `"W Crestwood Ln (1)"`, `"W Crestwood Ln (2)"`, etc.
This is generated at render time from the street's `name` field + index in `photos` array.

### Photo Compression
On-site and R&R photos are compressed before storage via `compressPhoto(file, maxPx, quality)` — reduces localStorage usage.

### Lightbox `arrayName` Parameter
When opening the lightbox, pass which array to use:
- `"photos"` — on-site photos
- `"rrPhotos"` — R&R photos
- `"scanPhotos"` — AI scan photos

---

## 14. Street View Integration

### Modes
1. **Scan mode** — automatic during `analyzeStreetView()`, not user-visible
2. **Interactive SV** — user clicks "Street View" button, then clicks map to browse
3. **Retake mode** — user clicks "Retake Photo" in lightbox, SV opens at that photo's coords, "Replace Photo" button appears in toolbar

### Street View Panel
- Slides in from right, overlays the map
- Toolbar: Back to Map | Snap Photo | Snap R&R | Replace Photo (retake mode only)
- `.sv-toolbar` z-index: 9999 (must be above Google Maps controls)

### SV Static API
- Thumbnail: `400×250`, stored as `url`
- HD: `800×500`, stored as `hdUrl`
- Both built via `getStreetViewUrl()` / `getStreetViewUrlHD()`

---

## 15. Known Decisions & Rules

| Decision | Reason |
|---|---|
| Street name from midpoint geocode only | Start/end points near intersections caused wrong names. Midpoint is most reliably on the street itself. |
| Name confirmation prompt after every draw | User kept getting wrong auto-detected names and had to fix them after |
| No "Clear Line" button | Duplicate of Delete — removed |
| No "Snap to Road" button | The polyline drawing already snaps well — not needed |
| No page/body scroll | Panels scroll independently; body overflow locked to `hidden` |
| Custom cursor must target internal canvas | Google Maps ignores cursor set on `#map` — must query and set on all child `canvas` + `div` elements |
| R&R section is conditional | Only shown if `detectRR` is enabled — reduces clutter for non-R&R jobs |
| Advanced settings hidden by default | Reduces cognitive load for new projects; accessible via "Advanced" toggle |
| Photo steppers re-render selector on save | Otherwise the displayed value doesn't update until page reload |
| Calibration prompt shown inside lightbox | If lightbox is open, the detail panel is hidden — prompt must render in `#lightbox-calibration-reason` |
| No chips/preset buttons for AI instructions | Cal decided against them — free text textarea is sufficient |
| No separate user-facing doc | Cal decided CLAUDE.md is enough |

---

## 16. Current Version

**v142** (as of last session — bump this when deploying)

Check `index.html` line 7 and line 261 for the `?v=XXX` query string on stylesheet and script tags.

> **Note to AI:** When Cal says "deploy" or "push live", use `/git-deploy`. Always bump the version number in `index.html` before deploying.
