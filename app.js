/* ================================================================
   PAVESCAN — App Logic
   Pavement assessment tool for crack seal & slurry seal companies
   ================================================================ */

/* ─── DATA SHAPE REFERENCE ──────────────────────────────────
   localStorage key: "cse_projects"
   [
     {
       id:        "uuid",
       name:      "Anaheim Q2 2026",
       type:      "crack-seal" | "slurry" | "both",  // project type
       streets:   [ ...street objects... ],
       createdAt: "2026-03-30T07:40:00Z"
     }
   ]

   localStorage key: "cse_active_project"
   "uuid" — currently selected project ID

   Street object shape:
   {
     id, name, lat, lng, length, width, sqft,
     rating, roadType, notes, analysis, adminNotes, weedAlert, weedNotes, svImage,
     path: [{ lat, lng }, ...],
     photos: [{ id, dataUrl, lat, lng, address, note, takenAt }],
     scanPhotos: [{ url, hdUrl, label, lat, lng }],
     scannedAt, createdAt
   }
──────────────────────────────────────────────────────────── */

// ─── GLOBALS ───────────────────────────────────────────────
let map = null;
let markers = [];
let projects = [];
let activeProject = null;
let streets = []; // shortcut to activeProject.streets
let activeStreetId = null;
let highlightMode = null;
let highlightStreetId = null;
let highlightMarkers = []; // temp markers while drawing
let polylines = []; // drawn street lines + markers
let _animInterval = null; // animation loop for selected street
let tempPolyline = null; // live polyline while drawing
let tempPath = []; // points being drawn
const PROJECTS_KEY = 'cse_projects';
const ACTIVE_KEY = 'cse_active_project';
const GLOBAL_SETTINGS_KEY = 'cse_global_settings';
const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const SV_BASE = 'https://maps.googleapis.com/maps/api/streetview';
let API_KEY = '';

// ─── OPENAI PROXY (for AI crack analysis) ──────────────────
const AI_PROXY = 'https://cse-worker.aestheticcal22.workers.dev';

// In-memory photo cache — stores base64 data URLs keyed by hdUrl
// Not persisted to localStorage (avoids quota issues)
const _photoCache = new Map();

// ─── LOGIN ─────────────────────────────────────────────────
function doLogin() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value.trim();
  if (user === 'Cal.Zentara' && pass === '0911') {
    sessionStorage.setItem('cse_auth', '1');
    document.getElementById('login-screen').style.display = 'none';
    initMap(); // finish loading the app
  } else {
    document.getElementById('login-error').classList.remove('hidden');
  }
}

// ─── INIT ──────────────────────────────────────────────────
function initMap() {
  // Check login before loading the app — overlay covers everything so no need to hide header/main
  if (sessionStorage.getItem('cse_auth') !== '1') {
    document.getElementById('login-screen').style.display = 'flex';
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  API_KEY = getMapKey();
  loadProjects();
  migrateOldData();

  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 33.83, lng: -117.91 }, // Anaheim default
    zoom: 12,
    mapTypeId: 'roadmap',
    mapId: 'f2e86140855a96ecc6c0576f',
    colorScheme: 'DARK',
    disableDefaultUI: true,
    zoomControl: true,
    mapTypeControl: true,
    mapTypeControlOptions: {
      position: google.maps.ControlPosition.TOP_RIGHT
    }
  });

  // Track cursor position on map for worker drop
  map.addListener('mousemove', (e) => { window._workerHoverLatLng = e.latLng; });

  // Map click listener
  map.addListener('click', (e) => handleMapClick(e.latLng));

  // Right-click cancels drawing mode
  map.addListener('rightclick', () => {
    if (drawingMode) { stopDrawingMode(); showToast('Pin cancelled'); }
  });
  document.getElementById('map').addEventListener('contextmenu', (e) => {
    if (drawingMode) { e.preventDefault(); stopDrawingMode(); showToast('Pin cancelled'); }
  });

  initWorkerDrag();
  renderProjectSelector();
  renderStreetList();
  placeAllMarkers();
  placePhotoMarkers();
  drawAllHighlights();
  updateStats();
  if (streets.length > 0) fitMapToMarkers();

  // Auto-fix streets missing road type (runs once per device)
  migrateRoadTypes();

  // Auto-generate scan photo galleries for existing streets
  migrateScanPhotos();

  // Backfill boundary points for existing streets
  migrateBoundaryPoints();
}

// ─── ADVANCED MARKER HELPER ────────────────────────────────
function makeMarker(opts) {
  const { icon, ...rest } = opts;
  const m = new google.maps.marker.AdvancedMarkerElement(rest);
  m.getPosition = () => m.position;
  return m;
}

// Safe removal — works for both Polylines (setMap) and AdvancedMarkers (m.map = null)
function removeFromMap(item) {
  if (!item) return;
  if (typeof item.setMap === 'function') item.setMap(null);
  else item.map = null;
}

function makeDotContent(color, size, borderColor, opacity = 1) {
  const el = document.createElement('div');
  el.style.cssText = `width:${size}px;height:${size}px;background:${opacity < 1 ? 'transparent' : color};border:2px solid ${borderColor || '#fff'};border-radius:50%;cursor:pointer;`;
  return el;
}

// ─── STORAGE & PROJECTS ────────────────────────────────────
function loadProjects() {
  try {
    projects = JSON.parse(localStorage.getItem(PROJECTS_KEY)) || [];
  } catch { projects = []; }

  // Get active project or create default
  const activeId = localStorage.getItem(ACTIVE_KEY);
  activeProject = projects.find(p => p.id === activeId);

  if (!activeProject && projects.length > 0) {
    activeProject = projects[0];
  }
  if (!activeProject) {
    activeProject = createProject('Default Project');
  }

  streets = activeProject.streets;
  try { localStorage.setItem(ACTIVE_KEY, activeProject.id); } catch(e) { /* quota */ }
}

function saveProjects() {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch (e) {
    showToast('Storage full — delete old photos or projects to free space');
    console.error('localStorage save failed:', e);
  }
}

function exportProject() {
  if (!activeProject) return;
  const json = JSON.stringify(activeProject, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${activeProject.name.replace(/[^a-z0-9]/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Project exported');
}

// ─── DUE DATE HELPERS ──────────────────────────────────────
function formatDueDateBadge(dueDateStr) {
  if (!dueDateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(dueDateStr + 'T00:00:00');
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0)  return { label: 'Overdue',  cls: 'due-overdue' };
  if (diffDays === 0) return { label: 'Due Today', cls: 'due-today' };
  if (diffDays === 1) return { label: 'Due Tomorrow', cls: 'due-soon' };
  if (diffDays <= 6)  return { label: 'Due ' + due.toLocaleDateString('en-US',{weekday:'short'}), cls: 'due-soon' };
  return { label: due.toLocaleDateString('en-US',{month:'short',day:'numeric'}), cls: 'due-future' };
}

function setStreetDueDate(id, value) {
  const s = streets.find(s => s.id === id);
  if (!s) return;
  s.dueDate = value || null;
  saveStreets();
  renderStreetList();
  if (activeStreetId === id) selectStreet(id);
}

function setStreetOrder(id, value) {
  const s = streets.find(s => s.id === id);
  if (!s) return;
  const num = parseInt(value);
  s.order = isNaN(num) || num < 1 ? null : num;
  saveStreets();
  renderStreetList();
  drawAllHighlights();
}

// ─── ROUTE OPTIMIZATION ────────────────────────────────────
function routeDist(route) {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += calcDistanceFt({ lat: route[i].lat, lng: route[i].lng }, { lat: route[i+1].lat, lng: route[i+1].lng });
  }
  return total;
}

function twoOptImprove(route) {
  if (route.length < 4) return route;
  let improved = true;
  let best = [...route];
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 2; k < best.length; k++) {
        // Reverse the segment between i+1 and k
        const candidate = best.slice(0, i + 1).concat(best.slice(i + 1, k + 1).reverse()).concat(best.slice(k + 1));
        if (routeDist(candidate) < routeDist(best)) {
          best = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}

// Group streets into proximity clusters — any street within maxFt of another in the group joins it.
function buildClusters(streets, maxFt) {
  const clusters = streets.map(s => [s]);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length && !merged; i++) {
      for (let j = i + 1; j < clusters.length && !merged; j++) {
        for (const a of clusters[i]) {
          for (const b of clusters[j]) {
            if (calcDistanceFt({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) <= maxFt) {
              clusters[i] = clusters[i].concat(clusters.splice(j, 1)[0]);
              merged = true;
              break;
            }
          }
          if (merged) break;
        }
      }
    }
  }
  return clusters;
}

// Cluster-first, route-second: group nearby streets, route between clusters, route within each cluster.
function optimizeWithClusters(streetList, startLat, startLng) {
  const CLUSTER_FT = 500;
  const clusters = buildClusters(streetList, CLUSTER_FT);
  // Represent each cluster by its centroid for inter-cluster routing
  const clusterPts = clusters.map(c => ({
    lat: c.reduce((s, x) => s + x.lat, 0) / c.length,
    lng: c.reduce((s, x) => s + x.lng, 0) / c.length,
    streets: c
  }));
  const orderedClusters = twoOptImprove(nearestNeighborOrder([...clusterPts], startLat, startLng));
  // Route within each cluster starting from where the previous cluster ended
  let ordered = [];
  let curLat = startLat, curLng = startLng;
  for (const cp of orderedClusters) {
    const internal = cp.streets.length > 1
      ? twoOptImprove(nearestNeighborOrder([...cp.streets], curLat, curLng))
      : cp.streets;
    ordered = ordered.concat(internal);
    if (internal.length) { curLat = internal[internal.length-1].lat; curLng = internal[internal.length-1].lng; }
  }
  return ordered;
}

function nearestNeighborOrder(pool, startLat, startLng) {
  const unvisited = [...pool];
  const result = [];
  let curLat = startLat, curLng = startLng;
  while (unvisited.length > 0) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const d = calcDistanceFt({ lat: curLat, lng: curLng }, { lat: unvisited[i].lat, lng: unvisited[i].lng });
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const chosen = unvisited.splice(bestIdx, 1)[0];
    result.push(chosen);
    curLat = chosen.lat; curLng = chosen.lng;
  }
  return result;
}

function setRouteMode(mode) {
  activeProject.routeMode = mode;
  saveProjects();
  renderProjectSelector();
  showToast('Route mode: ' + mode.charAt(0).toUpperCase() + mode.slice(1));
}

function optimizeRoute() {
  if (!streets.length) { showToast('No streets to optimize'); return; }
  const mode = activeProject.routeMode || 'hybrid';
  let ordered = [];
  const startStreet = streets.find(s => s.id === activeProject.startStreetId) || streets[0];
  const startLat = startStreet.lat, startLng = startStreet.lng;

  if (mode === 'auto') {
    ordered = optimizeWithClusters([...streets], startLat, startLng);
    // Pin start street to position 1
    if (activeProject.startStreetId) {
      const idx = ordered.findIndex(s => s.id === activeProject.startStreetId);
      if (idx > 0) ordered = [ordered[idx], ...ordered.slice(0, idx), ...ordered.slice(idx + 1)];
    }
  } else if (mode === 'manual') {
    showToast('Manual mode — set route stop numbers directly on each street');
    return;
  } else {
    // Hybrid — group by due date first, then cluster-first routing within each group
    const withDate = streets.filter(s => s.dueDate);
    const withoutDate = streets.filter(s => !s.dueDate);
    const dateGroups = {};
    withDate.forEach(s => { if (!dateGroups[s.dueDate]) dateGroups[s.dueDate] = []; dateGroups[s.dueDate].push(s); });
    const sortedDates = Object.keys(dateGroups).sort();
    let lastLat = startLat, lastLng = startLng;
    sortedDates.forEach(date => {
      const sorted = optimizeWithClusters(dateGroups[date], lastLat, lastLng);
      ordered = ordered.concat(sorted);
      if (sorted.length) { lastLat = sorted[sorted.length-1].lat; lastLng = sorted[sorted.length-1].lng; }
    });
    if (withoutDate.length) ordered = ordered.concat(optimizeWithClusters(withoutDate, lastLat, lastLng));
  }

  ordered.forEach((s, i) => { s.order = i + 1; });
  saveStreets();
  renderStreetList();
  drawAllHighlights();
  showToast('Route optimized — ' + ordered.length + ' streets ordered');
}

function clearRouteOrder() {
  streets.forEach(s => { s.order = null; });
  saveStreets();
  renderStreetList();
  drawAllHighlights();
  showToast('Route order cleared');
}

function setStartStreet(id) {
  activeProject.startStreetId = (activeProject.startStreetId === id) ? null : id;
  saveProjects();
  placeAllMarkers();
  drawAllHighlights();
  selectStreet(id);
  showToast(activeProject.startStreetId ? '★ Starting street set' : 'Starting street cleared');
}

function toggleStreetDone(id) {
  const s = streets.find(s => s.id === id);
  if (!s) return;
  s.completed = !s.completed;
  saveStreets();
  renderStreetList();
  drawAllHighlights();
  selectStreet(id);
  showToast(s.completed ? '✓ Street marked done' : 'Street marked incomplete');
}

function saveStreets() {
  activeProject.streets = streets;
  saveProjects();
}

function createProject(name, type = 'crack-seal') {
  const project = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    name: name,
    type: type, // 'crack-seal' | 'slurry' | 'both'
    includeWideCracks: false, // default: skip 1.25"+ cracks
    detectRR: false, // Remove & Replace detection off by default
    rrMinSize: '2x2', // Minimum R&R area in feet (width x length)
    aiEnabled: true, // AI analysis + photo capture on by default
    scanModel: 'gpt-4o', // AI model used for scanning
    aiNotes: '', // custom instructions injected into every AI scan prompt
    photoInterval: 200, // ft between mid-point photos
    maxPhotos: 6,       // max total photos per street
    calibrationLog: [], // corrections Cal made to AI ratings (max 50)
    calibrationRules: [], // approved rules from Refine AI — injected into prompts
    streets: [],
    createdAt: new Date().toISOString()
  };
  projects.push(project);
  saveProjects();
  return project;
}

function switchProject(id) {
  activeProject = projects.find(p => p.id === id);
  if (!activeProject) return;
  streets = activeProject.streets;
  try { localStorage.setItem(ACTIVE_KEY, activeProject.id); } catch(e) { /* quota */ }
  activeStreetId = null;
  // Close Street View if open to avoid stale state
  if (streetViewPano) closeStreetViewPanel();
  document.getElementById('detail-panel').classList.add('hidden');
  renderProjectSelector();
  renderStreetList();
  placeAllMarkers();
  placePhotoMarkers();
  drawAllHighlights();
  updateStats();
  if (streets.length > 0) fitMapToMarkers();
}

function deleteProject(id) {
  if (projects.length <= 1) { showToast('Cannot delete the only project'); return; }
  const container = document.getElementById('project-selector');
  // Toggle off if already showing
  const existing = container.querySelector('.delete-confirm');
  if (existing) { existing.remove(); return; }

  const confirmEl = document.createElement('div');
  confirmEl.className = 'delete-confirm';
  confirmEl.style.marginTop = '6px';
  confirmEl.innerHTML = `
    <span>Delete project and all streets?</span>
    <div class="delete-confirm-btns">
      <button class="dc-yes" onclick="event.stopPropagation(); doDeleteProject('${id}')">Yes, delete</button>
      <button class="dc-no" onclick="event.stopPropagation(); this.parentElement.parentElement.remove()">Cancel</button>
    </div>
  `;
  container.appendChild(confirmEl);
}

function doDeleteProject(id) {
  projects = projects.filter(p => p.id !== id);
  saveProjects();
  switchProject(projects[0].id);
  showToast('Project deleted');
}

function renameProject(id) {
  const project = projects.find(p => p.id === id);
  if (!project) return;
  const name = prompt('Project name:', project.name);
  if (!name || !name.trim()) return;
  project.name = name.trim();
  saveProjects();
  renderProjectSelector();
}

let _settingsCollapsed = false;
let _advancedOpen = false;

function toggleAdvanced() {
  _advancedOpen = !_advancedOpen;
  const body = document.getElementById('advanced-body');
  const arrow = document.getElementById('advanced-arrow');
  if (body) body.classList.toggle('hidden', !_advancedOpen);
  if (arrow) arrow.textContent = _advancedOpen ? '▾' : '▸';
}

function toggleSettingsCollapse() {
  _settingsCollapsed = !_settingsCollapsed;
  const body = document.getElementById('project-settings-body');
  const arrow = document.getElementById('settings-arrow');
  if (body) body.classList.toggle('hidden', _settingsCollapsed);
  if (arrow) arrow.textContent = _settingsCollapsed ? '▸' : '▾';
}

function renderProjectSelector() {
  const container = document.getElementById('project-selector');
  if (!container) return;
  container.innerHTML = `
    <div class="project-row">
      <select id="project-dropdown" onchange="switchProject(this.value)">
        ${projects.map(p => `<option value="${p.id}" ${p.id === activeProject.id ? 'selected' : ''}>${p.name} (${p.streets.length})</option>`).join('')}
      </select>
      <button class="btn-project-action" onclick="addNewProject()" title="New Project">+ New</button>
      <button class="btn-project-action" onclick="renameProject('${activeProject.id}')" title="Rename">Rename</button>
      <button class="btn-project-action" onclick="exportProject()" title="Export project as JSON">Export</button>
      <button class="btn-project-action btn-project-delete" onclick="deleteProject('${activeProject.id}')" title="Delete">Delete</button>
    </div>
    <div class="project-row route-row">
      <span class="route-label">Route:</span>
      <div class="route-mode-group">
        <button class="route-mode-btn ${(activeProject.routeMode||'hybrid')==='manual'?'active':''}" onclick="setRouteMode('manual')" title="Set order numbers yourself — no auto-sorting">Manual</button>
        <button class="route-mode-btn ${(activeProject.routeMode||'hybrid')==='hybrid'?'active':''}" onclick="setRouteMode('hybrid')" title="Due dates first, then nearest-neighbor efficiency">Hybrid</button>
        <button class="route-mode-btn ${(activeProject.routeMode||'hybrid')==='auto'?'active':''}" onclick="setRouteMode('auto')" title="Pure nearest-neighbor — ignore due dates">Auto</button>
      </div>
      <button class="btn-project-action btn-optimize" onclick="optimizeRoute()" title="Apply route optimization">⚡ Optimize Route</button>
      ${streets.some(s => s.order != null) ? '<button class="btn-project-action" onclick="clearRouteOrder()" style="border-color:rgba(239,68,68,0.4);color:#ef4444">&#x2715; Clear</button>' : ''}
    </div>
    <div class="settings-collapse-bar" onclick="toggleSettingsCollapse()">
      <span>Settings</span>
      <span id="settings-arrow">${_settingsCollapsed ? '▸' : '▾'}</span>
    </div>
    <div id="project-settings-body" ${_settingsCollapsed ? 'class="hidden"' : ''}>
    <div class="project-toggles">
      <div class="toggle-pill" onclick="toggleWideCracks()" title="${activeProject.includeWideCracks ? 'Wide cracks (1.25&quot;+) INCLUDED in scope' : 'Wide cracks (1.25&quot;+) NOT in scope — click to change'}">
        <span class="toggle-label">Wide Cracks 1.25"+</span>
        <span class="toggle-value ${activeProject.includeWideCracks ? 'toggle-on' : 'toggle-off'}">${activeProject.includeWideCracks ? 'IN SCOPE' : 'OUT'}</span>
      </div>
      <div class="toggle-pill" onclick="toggleAI()" title="${activeProject.aiEnabled !== false ? 'AI analysis & photo capture ON — click to turn off' : 'AI analysis & photo capture OFF — click to turn on'}">
        <span class="toggle-label">AI Analysis</span>
        <span class="toggle-value ${activeProject.aiEnabled !== false ? 'toggle-on' : 'toggle-off'}">${activeProject.aiEnabled !== false ? 'ON' : 'OFF'}</span>
      </div>
      <div class="toggle-pill" onclick="toggleRR()" title="${activeProject.detectRR ? 'Remove & Replace detection ON — click to turn off' : 'Remove & Replace detection OFF — click to turn on'}">
        <span class="toggle-label">R&amp;R Detection</span>
        <span class="toggle-value ${activeProject.detectRR ? 'toggle-on' : 'toggle-off'}">${activeProject.detectRR ? 'ON' : 'OFF'}</span>
      </div>
      ${activeProject.detectRR ? `
      <div class="toggle-pill" title="Minimum R&R area — only flag areas this size or larger" onclick="event.stopPropagation()">
        <span class="toggle-label">Min R&amp;R Size</span>
        <div style="display:flex;align-items:center;gap:3px;margin-top:2px">
          <input type="text" id="rr-min-size" value="${activeProject.rrMinSize || '2x2'}"
            style="width:44px;background:var(--bg-dark);border:1px solid var(--border);border-radius:4px;color:var(--accent);font-size:11px;font-weight:700;padding:2px 4px;text-align:center"
            placeholder="2x2"
            onchange="setRRMinSize(this.value)"
            onclick="event.stopPropagation()">
          <span style="font-size:9px;color:var(--text-dim)">ft</span>
        </div>
      </div>` : ''}
      <div class="toggle-pill" onclick="toggleLaneLayout()" title="${activeProject.detectLaneLayout ? 'Lane Layout detection ON — click to turn off' : 'Lane Layout detection OFF — click to turn on'}">
        <span class="toggle-label">Lane Layout</span>
        <span class="toggle-value ${activeProject.detectLaneLayout ? 'toggle-on' : 'toggle-off'}">${activeProject.detectLaneLayout ? 'ON' : 'OFF'}</span>
      </div>
      <div class="toggle-pill toggle-pill-full" onclick="cycleProjectType()" title="Project type — click to change">
        <span class="toggle-label">Project Type</span>
        <span class="toggle-value toggle-on">${activeProject.type === 'slurry' ? 'Slurry Seal' : activeProject.type === 'both' ? 'Both' : 'Crack Seal'}</span>
      </div>
    </div>
    <div class="advanced-toggle-bar" onclick="toggleAdvanced()">
      <span>Advanced</span>
      <span id="advanced-arrow">${_advancedOpen ? '▾' : '▸'}</span>
    </div>
    <div id="advanced-body" ${_advancedOpen ? '' : 'class="hidden"'}>
      <div class="photo-settings-row">
        <div class="photo-setting-card">
          <span class="photo-setting-label">Photo every</span>
          <div class="photo-stepper">
            <button class="photo-step-btn" onclick="savePhotoInterval(${(activeProject.photoInterval||200)-50})">−</button>
            <span class="photo-setting-val">${activeProject.photoInterval || 200} ft</span>
            <button class="photo-step-btn" onclick="savePhotoInterval(${(activeProject.photoInterval||200)+50})">+</button>
          </div>
        </div>
        <div class="photo-setting-card">
          <span class="photo-setting-label">Max photos</span>
          <div class="photo-stepper">
            <button class="photo-step-btn" onclick="saveMaxPhotos(${(activeProject.maxPhotos||6)-1})">−</button>
            <span class="photo-setting-val">${activeProject.maxPhotos || 6}</span>
            <button class="photo-step-btn" onclick="saveMaxPhotos(${(activeProject.maxPhotos||6)+1})">+</button>
          </div>
        </div>
      </div>
      <div class="photo-settings-default">Default: 200 ft · 6 photos</div>
      <div class="toggle-pill model-pill" style="margin-top:6px" title="AI model used for scanning">
        <span class="toggle-label">Scan Model</span>
        <select class="model-select" onchange="setScanModel(this.value)" onclick="event.stopPropagation()">
          <option value="gpt-4o" ${(activeProject.scanModel || 'gpt-4o') === 'gpt-4o' ? 'selected' : ''}>GPT-4o</option>
          <option value="gemini-2.0-flash" ${activeProject.scanModel === 'gemini-2.0-flash' ? 'selected' : ''}>Gemini Flash</option>
        </select>
      </div>
      <div class="ai-notes-row">
        <span class="ai-notes-label">AI Instructions</span>
        <textarea class="ai-notes-input" placeholder="e.g. Older neighborhood — focus on longitudinal cracking near gutters" onchange="saveAiNotes(this.value)">${escHtml(activeProject.aiNotes || '')}</textarea>
      </div>
      <div class="calib-bar">
        <span class="calib-bar-label">
          ${activeProject.calibrationRules?.length > 0
            ? `&#10003; ${activeProject.calibrationRules.length} calibration rule${activeProject.calibrationRules.length > 1 ? 's' : ''} active`
            : activeProject.calibrationLog?.length > 0
              ? `${activeProject.calibrationLog.length} correction${activeProject.calibrationLog.length > 1 ? 's' : ''} logged`
              : 'Calibration — no corrections yet'}
        </span>
        <div class="calib-bar-actions">
          ${activeProject.calibrationLog?.length > 0 ? `<button class="btn-calib-refine" onclick="openRefineAIModal()">Refine AI</button>` : ''}
          ${activeProject.calibrationRules?.length > 0 ? `<button class="btn-calib-clear" onclick="clearCalibrationRules()">Clear</button>` : ''}
        </div>
      </div>
    </div>
    </div>
  `;
}

function toggleLaneLayout() {
  activeProject.detectLaneLayout = !activeProject.detectLaneLayout;
  saveProjects();
  renderProjectSelector();
  showToast(activeProject.detectLaneLayout ? 'Lane Layout ON' : 'Lane Layout OFF');
}

function toggleRR() {
  activeProject.detectRR = !activeProject.detectRR;
  saveProjects();
  renderProjectSelector();
  showToast(activeProject.detectRR ? 'R&R Detection ON' : 'R&R Detection OFF');
}

function setRRMinSize(value) {
  const clean = value.trim();
  if (!clean) return;
  activeProject.rrMinSize = clean;
  saveProjects();
  showToast(`R&R min size: ${clean} ft`);
}

function cycleProjectType() {
  const types = ['crack-seal', 'slurry', 'both'];
  const current = activeProject.type || 'crack-seal';
  activeProject.type = types[(types.indexOf(current) + 1) % types.length];
  saveProjects();
  renderProjectSelector();
  renderStreetList();
  if (activeStreetId) selectStreet(activeStreetId);
  const labels = { 'crack-seal': 'Crack Seal', 'slurry': 'Slurry Seal', 'both': 'Both' };
  showToast(`Project type: ${labels[activeProject.type]}`);
}

function saveAiNotes(value) {
  activeProject.aiNotes = value.trim();
  saveProjects();
  if (activeProject.aiNotes) showToast('AI instructions saved');
}

function savePhotoInterval(value) {
  activeProject.photoInterval = Math.max(100, Math.min(1000, parseInt(value) || 200));
  saveProjects();
  renderProjectSelector();
  showToast(`Photo every ${activeProject.photoInterval} ft`);
}

function saveMaxPhotos(value) {
  activeProject.maxPhotos = Math.max(2, Math.min(12, parseInt(value) || 6));
  saveProjects();
  renderProjectSelector();
  showToast(`Max ${activeProject.maxPhotos} photos per street`);
}

// ─── GLOBAL SETTINGS ───────────────────────────────────────
function getGlobalSettings() {
  try { return JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) || '{}'); } catch { return {}; }
}

function openGlobalSettings() {
  const settings = getGlobalSettings();
  const input = document.getElementById('global-ai-notes-input');
  if (input) input.value = settings.aiNotes || '';
  document.getElementById('global-settings-overlay').classList.remove('hidden');
}

function closeGlobalSettings(e) {
  if (e && e.target !== document.getElementById('global-settings-overlay')) return;
  document.getElementById('global-settings-overlay').classList.add('hidden');
}

function saveGlobalSettings() {
  const input = document.getElementById('global-ai-notes-input');
  const aiNotes = input ? input.value.trim() : '';
  try { localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify({ aiNotes })); } catch(e) { /* quota */ }
  document.getElementById('global-settings-overlay').classList.add('hidden');
  showToast('Global settings saved');
}

function toggleWideCracks() {
  activeProject.includeWideCracks = !activeProject.includeWideCracks;
  saveProjects();
  renderProjectSelector();
  showToast(activeProject.includeWideCracks ? 'Wide cracks (1.25"+) now IN scope' : 'Wide cracks (1.25"+) now OUT of scope');
}

function toggleAI() {
  activeProject.aiEnabled = activeProject.aiEnabled === false ? true : false;
  saveProjects();
  renderProjectSelector();
  renderStreetList();
  // Re-render detail panel if a street is selected
  if (activeStreetId) selectStreet(activeStreetId);
  showToast(activeProject.aiEnabled ? 'AI analysis & photos ON' : 'AI analysis & photos OFF — manual mode');
}

function setScanModel(model) {
  activeProject.scanModel = model;
  saveProjects();
  const labels = { 'gpt-4o': 'GPT-4o', 'gemini-2.0-flash': 'Gemini Flash', 'claude-opus-4-6': 'Claude Opus' };
  showToast(`Scan model: ${labels[model] || model}`);
}

function addNewProject() {
  const name = prompt('New project name:');
  if (!name || !name.trim()) return;
  const project = createProject(name.trim());
  switchProject(project.id);
  showToast('Project created');
}

// Migrate old data from cse_streets to projects
function migrateOldData() {
  const oldData = localStorage.getItem('cse_streets');
  if (oldData) {
    try {
      const oldStreets = JSON.parse(oldData);
      if (oldStreets.length > 0) {
        activeProject.streets = oldStreets;
        streets = activeProject.streets;
        saveProjects();
      }
      localStorage.removeItem('cse_streets');
    } catch { /* skip */ }
  }

  // Always run field migrations regardless of whether old data existed
  const ratingMap = { good: 'level-1', fair: 'level-2', poor: 'level-3', critical: 'level-4' };
  let changed = false;
  projects.forEach(p => {
    p.streets.forEach(s => {
      if (ratingMap[s.rating]) { s.rating = ratingMap[s.rating]; changed = true; }
      if (!s.rrPhotos) { s.rrPhotos = []; changed = true; }
      if (!s.photos) { s.photos = []; changed = true; }
      if (!s.scanPhotos) { s.scanPhotos = []; changed = true; }
      if (s.weedAlert === undefined) { s.weedAlert = false; changed = true; }
      if (s.ravelingAlert === undefined) { s.ravelingAlert = false; changed = true; }
      if (s.rrAlert === undefined) { s.rrAlert = false; changed = true; }
      if (s.dueDate === undefined) { s.dueDate = null; changed = true; }
      if (s.order === undefined) { s.order = null; changed = true; }
      if (s.completed === undefined) { s.completed = false; changed = true; }
    });
    if (!p.type) { p.type = 'crack-seal'; changed = true; }
    if (p.detectRR === undefined) { p.detectRR = false; changed = true; }
    if (!p.rrMinSize) { p.rrMinSize = '2x2'; changed = true; }
    if (p.aiEnabled === undefined) { p.aiEnabled = true; changed = true; }
    if (!p.scanModel) { p.scanModel = 'gpt-4o'; changed = true; }
    if (p.aiNotes === undefined) { p.aiNotes = ''; changed = true; }
    if (!p.calibrationLog) { p.calibrationLog = []; changed = true; }
    if (!p.calibrationRules) { p.calibrationRules = []; changed = true; }
    if (!p.photoInterval) { p.photoInterval = 200; changed = true; }
    if (!p.maxPhotos) { p.maxPhotos = 6; changed = true; }
    if (!p.routeMode) { p.routeMode = 'hybrid'; changed = true; }
    if (p.startStreetId === undefined) { p.startStreetId = null; changed = true; }
  });
  if (changed) {
    streets = activeProject.streets;
    saveProjects();
  }
}

// ─── MIGRATE ROAD TYPES (one-time, runs on load) ──────────
async function migrateRoadTypes() {
  // Find all streets across all projects missing roadType
  const toFix = [];
  projects.forEach(p => {
    p.streets.forEach(s => {
      if (!s.roadType && s.lat && s.lng) toFix.push(s);
    });
  });
  if (toFix.length === 0) return;

  showToast(`Updating road types for ${toFix.length} street${toFix.length > 1 ? 's' : ''}...`);

  for (const s of toFix) {
    const info = await detectRoadType(s.lat, s.lng);
    s.roadType = info.label;
    s.width = info.width;
    s.sqft = (s.length || 0) * info.width;
    // Nominatim rate limit: 1 req/sec
    await new Promise(r => setTimeout(r, 1100));
  }

  saveProjects();
  renderStreetList();
  updateStats();
  if (activeStreetId) selectStreet(activeStreetId);
  showToast(`${toFix.length} street${toFix.length > 1 ? 's' : ''} updated with road types`);
}

// Interpolate a lat/lng at fraction t (0–1) along a path
function getPathPointAt(path, t) {
  if (!path || path.length === 0) return { lat: 0, lng: 0 };
  if (path.length === 1) return path[0];
  let total = 0;
  const segs = [];
  for (let i = 1; i < path.length; i++) {
    const d = Math.sqrt(Math.pow(path[i].lat - path[i-1].lat, 2) + Math.pow(path[i].lng - path[i-1].lng, 2));
    segs.push(d);
    total += d;
  }
  if (total === 0) return path[0];
  const target = total * t;
  let cum = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === 0) { cum += segs[i]; continue; }
    if (cum + segs[i] >= target) {
      const lt = (target - cum) / segs[i];
      return {
        lat: path[i].lat + (path[i+1].lat - path[i].lat) * lt,
        lng: path[i].lng + (path[i+1].lng - path[i].lng) * lt
      };
    }
    cum += segs[i];
  }
  return path[path.length - 1];
}

// Binary search along path to find exact city/county boundary crossing
async function findExactBoundaryPoint(street) {
  const path = street.path;
  if (!path || path.length < 2) return null;
  const startCity   = street.city;
  const startCounty = street.county;
  let lo = 0, hi = 1;
  for (let i = 0; i < 4; i++) {
    const mid = (lo + hi) / 2;
    const pt  = getPathPointAt(path, mid);
    const geo = await geocodeDetails(pt);
    if (geo.city === startCity && geo.county === startCounty) {
      lo = mid; // still in start jurisdiction — boundary is further ahead
    } else {
      hi = mid; // crossed — boundary is behind this point
    }
    await new Promise(r => setTimeout(r, 300)); // brief pause between calls
  }
  return getPathPointAt(path, (lo + hi) / 2);
}

// ─── MIGRATE BOUNDARY POINTS (one-time, runs on load) ──────
async function migrateBoundaryPoints() {
  const toFix = [];
  projects.forEach(p => {
    p.streets.forEach(s => {
      if (s.crossesBoundary && !s.boundaryPointExact && s.path && s.path.length >= 2) {
        toFix.push(s);
      }
    });
  });
  if (toFix.length === 0) return;

  for (const s of toFix) {
    const exact = await findExactBoundaryPoint(s);
    if (exact) {
      s.boundaryPoint = exact;
      s.boundaryPointExact = true;
    } else {
      s.boundaryPoint = s.path[Math.floor(s.path.length / 2)];
    }
  }
  saveProjects();
  drawAllHighlights();
}

// ─── NAME STREET PROMPT ─────────────────────────────────────
function promptStreetName(street, suggestedName) {
  document.getElementById('name-prompt-input').value = suggestedName || '';
  document.getElementById('name-prompt-overlay').classList.remove('hidden');
  document.getElementById('name-prompt-input').focus();
  window._namingStreetId = street.id;
}

function closeNamePrompt(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('name-prompt-overlay').classList.add('hidden');
  window._pendingStreet = null;
}

function confirmStreetName() {
  const val = document.getElementById('name-prompt-input').value.trim();
  if (!val) return;
  document.getElementById('name-prompt-overlay').classList.add('hidden');

  // If confirming a newly drawn street (pending save)
  if (window._pendingStreet) {
    const { street, roadLengthFt } = window._pendingStreet;
    window._pendingStreet = null;
    street.name = val;
    streets.push(street);
    saveStreets();
    window._drawStart = null;
    clearTempMarkers();
    clearTempPolyline();
    drawAllHighlights();
    renderStreetList();
    placeAllMarkers();
    updateStats();
    drawCount++;
    document.getElementById('highlight-bar-text').textContent = `Street ${drawCount} saved (${formatNumber(roadLengthFt)} ft) — click next street or Done`;
    const pinLabel = document.getElementById('btn-pin-label');
    if (pinLabel) pinLabel.textContent = 'Pin.Start';
    setMapCursor('cursor-pin-start');
    showToast(`${formatNumber(roadLengthFt)} ft — ${formatNumber(street.sqft)} sq ft`);
    if (activeProject.aiEnabled !== false) analyzeStreetView(street).then(async analysis => {
      street.analysis = analysis.text; street.rating = analysis.rating; street.aiRating = analysis.rating;
      street.weedAlert = analysis.weedAlert || false; street.weedNotes = analysis.weedNotes || '';
      street.ravelingAlert = analysis.ravelingAlert || false; street.ravelingNotes = analysis.ravelingNotes || '';
      street.rrAlert = analysis.rrAlert || false; street.rrNotes = analysis.rrNotes || '';
      street.scannedAt = new Date().toISOString();
      if (activeProject.detectLaneLayout && isArterialStreet(street)) {
        const layout = await analyzeLaneLayout(street);
        if (layout) street.laneLayout = layout;
      }
      saveStreets(); renderStreetList(); selectStreet(street.id); placeAllMarkers(); updateStats();
    }).catch(e => { street.rating = 'level-1'; street.analysis = 'Scan failed.'; saveStreets(); selectStreet(street.id); });
    selectStreet(street.id);
    return;
  }

  // Renaming an existing street
  const street = streets.find(s => s.id === window._namingStreetId);
  if (street) {
    street.name = val;
    saveStreets();
    renderStreetList();
    selectStreet(street.id);
  }
}

// ─── INLINE RENAME (detail panel) ──────────────────────────
function startInlineRename(id) {
  document.getElementById('detail-name-display-' + id)?.classList.add('hidden');
  const editRow = document.getElementById('detail-name-edit-' + id);
  if (editRow) {
    editRow.classList.remove('hidden');
    const input = document.getElementById('detail-name-input-' + id);
    if (input) { input.focus(); input.select(); }
  }
}

function saveInlineRename(id) {
  const input = document.getElementById('detail-name-input-' + id);
  const val = input?.value.trim();
  if (!val) return;
  const street = streets.find(s => s.id === id);
  if (!street) return;
  street.name = val;
  saveStreets();
  renderStreetList();
  selectStreet(id);
  showToast('Street renamed');
}

function cancelInlineRename(id) {
  document.getElementById('detail-name-edit-' + id)?.classList.add('hidden');
  document.getElementById('detail-name-display-' + id)?.classList.remove('hidden');
}

// ─── MIGRATE SCAN PHOTOS (one-time, runs on load) ──────────
function migrateScanPhotos() {
  let changed = false;
  projects.forEach(p => {
    p.streets.forEach(s => {
      if (s.scannedAt && (!s.scanPhotos || !s.scanPhotos[0]?.hdUrl)) {
        const pts = getSamplePoints(s);
        s.scanPhotos = pts.map(pt => ({
          url: getStreetViewUrl(pt.lat, pt.lng, pt.heading || 0),
          hdUrl: getStreetViewUrlHD(pt.lat, pt.lng, pt.heading || 0),
          label: pt.label
        }));
        s.photosScanned = pts.length;
        changed = true;
      }
    });
  });
  if (changed) {
    saveProjects();
    if (activeStreetId) selectStreet(activeStreetId);
  }
}

// ─── CITY/COUNTY DETECTION ──────────────────────────────────
function geocodeDetails(latLng) {
  return new Promise((resolve) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ location: latLng }, (results, status) => {
      if (status !== 'OK' || !results.length) {
        resolve({ address: '', city: '', county: '', state: '' });
        return;
      }
      const components = results[0].address_components;
      const get = (type) => {
        const c = components.find(c => c.types.includes(type));
        return c ? c.long_name : '';
      };
      resolve({
        address: results[0].formatted_address,
        route: get('route'),
        city: get('locality') || get('sublocality') || get('neighborhood'),
        county: get('administrative_area_level_2'),
        state: get('administrative_area_level_1')
      });
    });
  });
}

// ─── ROAD TYPE DETECTION (OpenStreetMap) ───────────────────
// Standard curb-to-curb widths by road classification (US DOT / AASHTO)
const ROAD_TYPES = {
  residential:  { label: 'Residential',     width: 32 },
  living_street:{ label: 'Residential',     width: 28 },
  unclassified: { label: 'Local Road',      width: 30 },
  tertiary:     { label: 'Collector',       width: 36 },
  tertiary_link:{ label: 'Collector Ramp',  width: 32 },
  secondary:    { label: 'Minor Arterial',  width: 44 },
  secondary_link:{ label: 'Arterial Ramp',  width: 36 },
  primary:      { label: 'Major Arterial',  width: 52 },
  primary_link: { label: 'Arterial Ramp',   width: 40 },
  trunk:        { label: 'Highway',         width: 60 },
  trunk_link:   { label: 'Highway Ramp',    width: 36 },
  service:      { label: 'Alley / Service', width: 18 },
};

async function detectRoadType(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=17`, {
      headers: { 'User-Agent': 'CrackingSealingEst/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const data = await res.json();
    const osmType = data.type || data.class || '';
    const roadName = data.address?.road || data.name || '';
    const road = ROAD_TYPES[osmType];
    if (road) return { type: osmType, label: road.label, width: road.width, name: roadName };
    return { type: osmType || 'unknown', label: 'Residential', width: 32, name: roadName };
  } catch (e) {
    console.error('Road type detection error:', e);
    return { type: 'unknown', label: 'Residential', width: 32, name: '' };
  }
}

// ─── MODAL CONTROLS ────────────────────────────────────────
function openAddStreetModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('input-street-name').value = '';
  document.getElementById('input-length').value = '';
  document.getElementById('input-notes').value = '';
  document.getElementById('input-street-name').focus();
}

function closeModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('modal-overlay').classList.add('hidden');
}

function showScanModal(msg) {
  const el = document.getElementById('scan-overlay');
  document.getElementById('scan-status').textContent = msg || 'Pulling imagery and analyzing pavement condition';
  el.style.display = 'flex';
  el.classList.remove('hidden');
}

function hideScanModal() {
  const el = document.getElementById('scan-overlay');
  el.style.display = 'none';
  el.classList.add('hidden');
}

// ─── ADD STREET ────────────────────────────────────────────
async function saveStreet() {
  const name = document.getElementById('input-street-name').value.trim();
  const length = parseFloat(document.getElementById('input-length').value) || 0;
  const notes = document.getElementById('input-notes').value.trim();

  if (!name) {
    showToast('Enter a street name or address');
    return;
  }

  closeModal();
  showScanModal('Looking up address...');

  try {
    // Geocode the address
    const geo = await geocodeAddress(name);
    if (!geo) {
      hideScanModal();
      showToast('Could not find that address — try a more specific one');
      return;
    }

  showScanModal('Detecting road type...');

  // Detect road type from OpenStreetMap
  const roadInfo = await detectRoadType(geo.lat, geo.lng);
  const width = roadInfo.width;

  showScanModal('Pulling Street View imagery...');

  // Build street object
  const street = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    name: geo.formatted || name,
    lat: geo.lat,
    lng: geo.lng,
    length: length,
    width: width,
    sqft: length * width,
    roadType: roadInfo.label,
    rating: 'pending',
    notes: notes,
    analysis: '',
    svImage: getStreetViewUrl(geo.lat, geo.lng),
    scannedAt: null,
    createdAt: new Date().toISOString()
  };

  // Run AI scan if enabled
  if (activeProject.aiEnabled !== false) {
    showScanModal('AI analyzing pavement condition...');
    const analysis = await analyzeStreetView(street);
    street.analysis = analysis.text;
    street.rating = analysis.rating;
    street.aiRating = analysis.rating; // store AI's original rating for calibration tracking
    street.weedAlert = analysis.weedAlert || false;
    street.weedNotes = analysis.weedNotes || '';
    street.ravelingAlert = analysis.ravelingAlert || false;
    street.ravelingNotes = analysis.ravelingNotes || '';
    street.rrAlert = analysis.rrAlert || false;
    street.rrNotes = analysis.rrNotes || '';
    street.scannedAt = new Date().toISOString();
    if (activeProject.detectLaneLayout && isArterialStreet(street)) {
      showScanModal('Analyzing lane layout...');
      const layout = await analyzeLaneLayout(street);
      if (layout) street.laneLayout = layout;
    }
  }

  // Save
  streets.push(street);
  saveStreets();

  hideScanModal();

  // Update UI
  renderStreetList();
  placeAllMarkers();
  updateStats();
  selectStreet(street.id);
  fitMapToMarkers();

  showToast(activeProject.aiEnabled !== false ? 'Street added and scanned' : 'Street added (AI off)');
  } catch (err) {
    console.error('Save street error:', err);
    hideScanModal();
    showToast('Something went wrong — try again');
  }
}

// ─── GEOCODING (uses built-in Maps JS geocoder) ───────────
function geocodeAddress(address) {
  return new Promise((resolve) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: address }, (results, status) => {
      if (status === 'OK' && results.length > 0) {
        const result = results[0];
        resolve({
          lat: result.geometry.location.lat(),
          lng: result.geometry.location.lng(),
          formatted: result.formatted_address,
          locationType: result.geometry.location_type // ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
        });
      } else {
        console.error('Geocoding failed:', status);
        resolve(null);
      }
    });
  });
}

// ─── STREET VIEW ───────────────────────────────────────────
function getStreetViewUrl(lat, lng, heading = 0) {
  return `${SV_BASE}?size=640x300&location=${lat},${lng}&heading=${heading}&pitch=-10&fov=100&key=${API_KEY}`;
}

function getStreetViewUrlHD(lat, lng, heading = 0) {
  return `${SV_BASE}?size=640x640&location=${lat},${lng}&heading=${heading}&pitch=-25&fov=80&key=${API_KEY}`;
}

// When direct thumbnail load fails, try fetching via worker proxy (unrestricted key)
async function loadSvThumbnailViaProxy(imgEl, svUrl) {
  try {
    const dataUrl = await imageUrlToBase64(svUrl);
    if (dataUrl) {
      imgEl.src = dataUrl;
    } else {
      imgEl.src = '';
      imgEl.alt = 'Street View not available';
    }
  } catch (e) {
    imgEl.src = '';
    imgEl.alt = 'Street View not available';
  }
}

// ─── AI ANALYSIS ───────────────────────────────────────────

// Offset a lat/lng point in a given heading direction by distanceFt
function offsetPoint(lat, lng, headingDeg, distanceFt) {
  const headingRad = headingDeg * Math.PI / 180;
  const latPerFt = 1 / 364000;
  const lngPerFt = 1 / (364000 * Math.cos(lat * Math.PI / 180));
  return {
    lat: lat + distanceFt * Math.cos(headingRad) * latPerFt,
    lng: lng + distanceFt * Math.sin(headingRad) * lngPerFt
  };
}

// True if street is a main road (arterial, highway, collector)
function isMainStreet(street) {
  const label = (street.roadType || '').toLowerCase();
  return label.includes('arterial') || label.includes('highway') || label.includes('collector');
}

// Calculate sample points — always looking INTO the street from each endpoint
// Start/end points are offset 40ft inward so the camera sits on the street,
// not at the intersection corner where it would capture the cross street instead.
const ENDPOINT_OFFSET_FT = 80;
function getSamplePoints(street) {
  const path = street.path;
  if (!path || path.length < 2) return [{ lat: street.lat, lng: street.lng, heading: 0, label: 'Start' }];

  const startPt = path[0];
  const endPt   = path[path.length - 1];
  const headingForward  = calcHeading(startPt, endPt);
  const headingBackward = (headingForward + 180) % 360;
  const length = street.length || 0;

  // Offset start 40ft inward (toward end), offset end 40ft inward (toward start)
  const startInset = offsetPoint(startPt.lat, startPt.lng, headingForward, ENDPOINT_OFFSET_FT);
  const endInset   = offsetPoint(endPt.lat, endPt.lng, headingBackward, ENDPOINT_OFFSET_FT);

  const points = [];

  const interval = activeProject?.photoInterval || 200;
  const maxMid = Math.max(1, (activeProject?.maxPhotos || 6) - 2); // subtract start + end

  points.push({ ...startInset, heading: headingForward, label: 'Start (looking in)' });

  const midCount = Math.min(maxMid, Math.floor(length / interval));
  for (let i = 1; i <= midCount; i++) {
    const t = i / (midCount + 1);
    points.push({
      lat: startPt.lat + (endPt.lat - startPt.lat) * t,
      lng: startPt.lng + (endPt.lng - startPt.lng) * t,
      heading: headingForward,
      label: `Mid-point ${i}`
    });
  }

  points.push({ ...endInset, heading: headingBackward, label: 'End (looking in)' });

  return points;
}

// Calculate compass heading from point A to point B
function calcHeading(from, to) {
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const fromLat = from.lat * Math.PI / 180;
  const toLat = to.lat * Math.PI / 180;
  const x = Math.sin(dLng) * Math.cos(toLat);
  const y = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(dLng);
  return ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360;
}

// ─── PHOTO ROAD CHECK ──────────────────────────────────────
// Quick YES/NO check: is road surface clearly visible in this photo?
// Uses gpt-4o-mini (fast + cheap). Falls back to true (assume OK) on error.
async function checkPhotoHasRoad(base64) {
  try {
    const res = await fetch(AI_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        provider: 'openai',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Is road surface (asphalt or concrete pavement) clearly visible and assessable in this image? Answer YES or NO only.' },
            { type: 'image_url', image_url: { url: base64 } }
          ]
        }],
        max_tokens: 5
      })
    });
    if (!res.ok) return true;
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || 'YES').trim().toUpperCase().startsWith('YES');
  } catch { return true; }
}

// ─── STREET VIEW METADATA ──────────────────────────────────
// Free JSON call — tells us panorama location, ID, and availability
// before we spend quota fetching the actual image.
async function fetchSVMetadata(lat, lng) {
  try {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json(); // { status, pano_id, location: {lat,lng}, date }
  } catch { return null; }
}

// Distance in metres between two lat/lng points
function metersApart(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

async function analyzeStreetView(street) {
  if (!AI_PROXY) {
    return analyzeWithPlaceholder(street);
  }

  try {
    // Get candidate sample points along the street
    const samplePoints = getSamplePoints(street);

    // ── SMART PHOTO SELECTION ───────────────────────────────
    // 1. Fetch metadata for all points in parallel (free, fast)
    // 2. Skip points with no Street View coverage
    // 3. Deduplicate by panorama ID (same pano = same photo)
    // 4. Skip if panorama drifted >20m from requested point
    //    (means it snapped to a different street — e.g. the cross street)
    const MAX_DRIFT_M = 20;
    const metadataResults = await Promise.all(
      samplePoints.map(pt => fetchSVMetadata(pt.lat, pt.lng))
    );

    const seenPanoIds = new Set();
    const filteredPoints = [];
    samplePoints.forEach((pt, i) => {
      const meta = metadataResults[i];
      if (!meta || meta.status !== 'OK') return; // no coverage
      if (seenPanoIds.has(meta.pano_id)) return;  // duplicate panorama
      const drift = metersApart({ lat: pt.lat, lng: pt.lng }, meta.location);
      if (drift > MAX_DRIFT_M) return;             // snapped to wrong street
      seenPanoIds.add(meta.pano_id);
      // Carry the imagery date forward — format "YYYY-MM"
      filteredPoints.push({ ...pt, svDate: meta.date || null });
    });

    // Fall back to all points if metadata filtering removed everything
    const pointsToUse = filteredPoints.length > 0 ? filteredPoints : samplePoints;

    // Fetch Street View images for the selected points
    const imagePromises = pointsToUse.map(pt => {
      const url = getStreetViewUrlHD(pt.lat, pt.lng, pt.heading || 0);
      return imageUrlToBase64(url);
    });
    const images = await Promise.all(imagePromises);

    // ── ROAD SURFACE PRE-CHECK ────────────────────────────────
    // For each image, verify road surface is visible before sending to AI.
    // If not visible, try +20° heading as a fallback before dropping entirely.
    const checkedPairs = await Promise.all(
      pointsToUse.map(async (pt, i) => {
        const img = images[i];
        if (!img) return null;
        const hdUrl = getStreetViewUrlHD(pt.lat, pt.lng, pt.heading || 0);
        if (await checkPhotoHasRoad(img)) {
          return { base64: img, hdUrl, label: pt.label, svDate: pt.svDate, lat: pt.lat, lng: pt.lng };
        }
        // Road not visible — try +20° heading once
        const altHeading = ((pt.heading || 0) + 20) % 360;
        const altUrl = getStreetViewUrlHD(pt.lat, pt.lng, altHeading);
        const altImg = await imageUrlToBase64(altUrl);
        if (altImg && await checkPhotoHasRoad(altImg)) {
          return { base64: altImg, hdUrl: altUrl, label: pt.label, svDate: pt.svDate, lat: pt.lat, lng: pt.lng };
        }
        return null; // drop — road not assessable
      })
    );
    const validPairs = checkedPairs.filter(Boolean);

    if (validPairs.length === 0) {
      console.warn('Could not load any Street View images, using placeholder');
      return analyzeWithPlaceholder(street);
    }

    // Build message content — interleave label + image so AI can reference each by name
    const content = [
      {
        type: 'text',
        text: `Assess the pavement condition of: ${street.name}\nStreet length: ${formatNumber(street.length || 0)} ft\n${validPairs.length} photos follow, each labeled. Reference the photo label when describing observations.${validPairs.some(p => p.svDate) ? '\nImagery dates: ' + validPairs.map((p, i) => `Photo ${i + 1}: ${p.svDate || 'unknown'}`).join(', ') + (validPairs.some(p => p.svDate && parseInt(p.svDate) < new Date().getFullYear() - 4) ? ' ⚠ Some imagery may be outdated — note this in your assessment.' : '') : ''}`
      },
      ...validPairs.flatMap((p, i) => ([
        { type: 'text', text: `Photo ${i + 1}: ${p.label}` },
        { type: 'image_url', image_url: { url: p.base64 } }
      ]))
    ];

    const scanModel = activeProject?.scanModel || 'gpt-4o';
    const res = await fetch(AI_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: scanModel,
        provider: getProviderForModel(scanModel),
        messages: [
          {
            role: 'system',
            content: (() => {
  const projType = activeProject?.type || 'crack-seal';
  const isSlurry = projType === 'slurry' || projType === 'both';
  const detectRR = activeProject?.detectRR === true;
  const rrMinSize = activeProject?.rrMinSize || '2x2';
  const crackInstructions = isSlurry
    ? `IMPORTANT — CRACK WIDTH THRESHOLDS (Slurry Seal project):
- Any cracks 0.25 inches (1/4") or wider must be crack sealed before slurry can be applied. Flag these with "⚠ PREP CRACKS DETECTED (0.25"+)".
- Any cracks 1.25 inches or wider require hot-applied mastic treatment (not standard crack sealant) before any other work. Flag these additionally with "⚠ MASTIC REQUIRED (1.25"+)". Mastic is a hot-applied asphalt binder loaded with aggregate, used to fill wide cracks 1.25"–4". Cracks over 4" require saw-cut removal and patching.`
    : `IMPORTANT — CRACK WIDTH (Crack Seal project):
- Any cracks 1.25 inches or wider require hot-applied mastic treatment — not standard crack sealant. Mastic is a hot-applied asphalt binder loaded with aggregate, used to fill wide cracks 1.25"–4". Cracks over 4" require saw-cut removal and patching. Flag with "⚠ MASTIC REQUIRED (1.25"+)".`;

  const wideCrackSection = isSlurry
    ? `3. WIDE CRACKS (two thresholds for slurry projects)
   - 0.25"+ cracks must be crack sealed before slurry can be applied: flag "⚠ PREP CRACKS DETECTED (0.25"+)", reference photo(s)
   - 1.25"+ cracks require hot-applied mastic (not standard sealant): flag "⚠ MASTIC REQUIRED (1.25"+)", reference photo(s)
   - If neither: write "None detected."`
    : `3. WIDE CRACKS
   - 1.25"+ cracks require hot-applied mastic — not standard crack sealant: flag "⚠ MASTIC REQUIRED (1.25"+)", reference photo(s)
   - If none: write "None detected."`;

  const projectLabel = projType === 'slurry' ? 'Slurry Seal' : projType === 'both' ? 'Crack Seal + Slurry Seal' : 'Crack Seal';
  const rrSection = detectRR ? `6. REMOVE & REPLACE
   - Look for: broken-apart pavement, open gaps 4"+, collapsed edges, severe potholes, structural failure
   - Only flag areas that appear to be at least ${rrMinSize} ft in size
   - These areas must be saw-cut, excavated, and patched with HMA before any other treatment
   - If found: flag "⚠ REMOVE & REPLACE NEEDED", describe location + estimated size + photo reference(s)
   - Any street with R&R conditions must be rated Level 4
   - If none visible: write "None detected."` : '';
  const sectionOffset = detectRR ? 1 : 0;

  return `You are a pavement condition assessor working for a pavement contractor.
You are reviewing ${validPairs.length} Street View image(s) of a single street.
Project type: ${projectLabel}

━━━ WHAT TO LOOK FOR ━━━
- Cracks: alligator, longitudinal, transverse
- Potholes, fading, worn patches, surface texture, asphalt color
- Corner and cul-de-sac damage (turning traffic causes the worst wear — pay extra attention)
- Weeds or vegetation growing out of cracks or joints
- Raveling: small stones/aggregate coming loose, leaving a rough, pitted, or frayed surface
- Wide cracks and structural failure (see thresholds below)

━━━ RATING SCALE ━━━
Level 1 — Good: little to no cracking
Level 2 — Light: moderate light cracking, some visible cracks
Level 3 — Heavy: heavy cracking, deep cracks, alligator cracking present
Level 4 — Severe: alligator cracking everywhere, deep cracks every 3–5 ft
Note: Any street with Remove & Replace conditions must be rated Level 4.

━━━ CRACK WIDTH THRESHOLDS ━━━
${crackInstructions}

━━━ RAVELING ━━━
${isSlurry
  ? `Raveling is a primary indicator for slurry seal suitability — flag even light raveling.
Flag with "⚠ RAVELING DETECTED" and describe severity (light / moderate / heavy).`
  : `Flag any raveling with "⚠ RAVELING DETECTED" and describe severity (light / moderate / heavy).`}

━━━ REQUIRED RESPONSE FORMAT ━━━
1. PHOTOS ANALYZED: ${validPairs.length} images covering ${formatNumber(street.length || 0)} ft

2. WHAT I CAN SEE
   - 2–4 bullet points describing pavement condition
   - Every bullet MUST end with the photo reference — e.g. "(Photo 2: Mid-point 1)"
   - Note if condition varies along the street

${wideCrackSection}

4. WEED/GRASS CONTROL
   - If vegetation is growing from cracks or joints: flag "🌿 WEED CONTROL NEEDED", describe extent (light/moderate/heavy), reference photo(s)
   - If none: write "None detected."

5. RAVELING
   - If aggregate loss or rough/pitted surface is visible: flag "⚠ RAVELING DETECTED", describe severity, reference photo(s)
   - If none: write "None detected."

${rrSection}

${6 + sectionOffset}. WHAT I CAN'T SEE
   - 1–2 bullet points about what this assessment cannot confirm from Street View alone

${7 + sectionOffset}. Level: [1/2/3/4]

${8 + sectionOffset}. PHOTO RATINGS
   Rate each photo on one line exactly like this:
   "Photo 1: [1/2/3/4], Photo 2: [1/2/3/4], ..."

━━━ RULES ━━━
- Be honest. Only rate what you can actually see.
- When in doubt, weight toward the worst section of the street.
- Do not guess — if you cannot see something clearly, say so in "What I Can't See."
${detectRR && isSlurry ? '- R&R areas must be patched before slurry seal can be applied to those sections.' : ''}${(() => { const g = getGlobalSettings(); return g.aiNotes ? '\n\n━━━ GLOBAL STANDARDS ━━━\n' + g.aiNotes : ''; })()}${activeProject?.aiNotes?.trim() ? '\n\n━━━ PROJECT INSTRUCTIONS ━━━\n' + activeProject.aiNotes.trim() : ''}${activeProject?.calibrationRules?.length > 0 ? '\n\n━━━ CALIBRATION RULES (learned from past corrections) ━━━\n' + activeProject.calibrationRules.map((r, i) => `${i + 1}. ${r}`).join('\n') : ''}`;
})()
          },
          { role: 'user', content: content }
        ],
        max_tokens: 1500
      })
    });

    // Store scan photos with embedded base64 so they travel with the project on export
    street.photosScanned = validPairs.length;
    street.scanPhotos = validPairs.map(p => {
      _photoCache.set(p.hdUrl, p.base64);
      return { url: p.hdUrl, hdUrl: p.hdUrl, dataUrl: `data:image/jpeg;base64,${p.base64}`, label: p.label, lat: p.lat, lng: p.lng, svDate: p.svDate || null };
    });

    if (!res.ok) throw new Error(`AI proxy ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) {
      console.warn('AI returned empty response:', JSON.stringify(data));
      if (data._geminiDebug) console.warn('Gemini debug:', JSON.stringify(data._geminiDebug));
      showToast('Scan failed — check console for details');
      return analyzeWithPlaceholder(street);
    }
    const rating = extractRating(text);
    const weedAlert = extractWeedAlert(text);
    const weedNotes = extractWeedNotes(text);
    const ravelingAlert = extractRavelingAlert(text);
    const ravelingNotes = extractRavelingNotes(text);
    const rrAlert = extractRRAlert(text);
    const rrNotes = extractRRNotes(text);
    // Store per-photo ratings from AI response
    const photoRatings = extractPhotoRatings(text, validPairs.length);
    photoRatings.forEach((r, i) => { if (street.scanPhotos[i] && r) street.scanPhotos[i].rating = r; });
    return { text, rating, weedAlert, weedNotes, ravelingAlert, ravelingNotes, rrAlert, rrNotes };
  } catch (e) {
    console.error('AI analysis error:', e);
    return analyzeWithPlaceholder(street);
  }
}

// ─── LANE LAYOUT DETECTION ─────────────────────────────────
function isArterialStreet(street) {
  const t = (street.roadType || '').toLowerCase();
  return t.includes('arterial') || t.includes('collector') || t.includes('highway');
}

function getSatelliteImageUrl(street) {
  const center = `${street.lat},${street.lng}`;
  let url = `https://maps.googleapis.com/maps/api/staticmap?center=${center}&zoom=19&size=640x400&maptype=satellite&key=${API_KEY}`;
  if (street.path && street.path.length >= 2) {
    const pathStr = street.path.map(p => `${p.lat},${p.lng}`).join('|');
    url += `&path=color:0xff6600ff|weight:5|${pathStr}`;
  }
  return url;
}

async function analyzeLaneLayout(street) {
  try {
    const satUrl = getSatelliteImageUrl(street);
    const base64 = await imageUrlToBase64(satUrl);
    if (!base64) return null;

    const res = await fetch(AI_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: 'gpt-4o',
        provider: 'openai',
        messages: [
          {
            role: 'system',
            content: `You are analyzing an overhead satellite image of ${street.name} to identify its lane layout.
Return ONLY a valid JSON object — no other text:
{
  "throughLanes": <number of through lanes per direction, or null if unclear>,
  "bikeLane": { "present": <true/false>, "side": "<left/right/both/null>" },
  "leftTurnPockets": <number, 0 if none>,
  "rightLaneDrop": <true/false>,
  "parkingLane": <true/false>,
  "median": <true/false>,
  "notes": "<one sentence summary of the lane layout>"
}
Only report what you can clearly see. Use null for anything unclear.`
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Identify the lane layout of ${street.name} from this satellite image.` },
              { type: 'image_url', image_url: { url: base64 } }
            ]
          }
        ],
        max_tokens: 300
      })
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Lane layout error:', e);
    return null;
  }
}

async function rescanLaneLayout(id) {
  const street = streets.find(s => s.id === id);
  if (!street) return;
  showScanModal('Analyzing lane layout...');
  try {
    const layout = await analyzeLaneLayout(street);
    if (layout) { street.laneLayout = layout; saveStreets(); selectStreet(id); showToast('Lane layout updated'); }
    else showToast('Could not detect lane layout');
  } finally {
    hideScanModal();
  }
}

// Fetch a Street View image via the Cloudflare Worker proxy (avoids browser Referer 403s)
async function imageUrlToBase64(url) {
  try {
    const res = await fetch(`${AI_PROXY}/image?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.dataUrl || null;
  } catch (e) {
    console.warn('imageUrlToBase64 error:', e);
    return null;
  }
}

function extractRating(text) {
  // Handle bracket format "Level: [3]" as well as plain "Level: 3"
  const bracketMatch = text.match(/Level:\s*\[?([1-4])\]?/i);
  if (bracketMatch) return `level-${bracketMatch[1]}`;
  const lower = text.toLowerCase();
  if (lower.includes('level: 4') || lower.includes('level:4') || lower.includes('rating: 4')) return 'level-4';
  if (lower.includes('level: 3') || lower.includes('level:3') || lower.includes('rating: 3')) return 'level-3';
  if (lower.includes('level: 2') || lower.includes('level:2') || lower.includes('rating: 2')) return 'level-2';
  if (lower.includes('level: 1') || lower.includes('level:1') || lower.includes('rating: 1')) return 'level-1';
  // Fallback for old ratings
  if (lower.includes('critical')) return 'level-4';
  if (lower.includes('poor')) return 'level-3';
  if (lower.includes('fair')) return 'level-2';
  if (lower.includes('good')) return 'level-1';
  return 'level-2';
}

function extractPhotoRatings(text, photoCount) {
  const match = text.match(/PHOTO RATINGS[:\s]+(.*)/i);
  if (!match) return [];
  const line = match[1];
  const ratings = [];
  for (let i = 1; i <= photoCount; i++) {
    const m = line.match(new RegExp(`Photo\\s*${i}\\s*:\\s*(\\d)`, 'i'));
    const lvl = m ? parseInt(m[1]) : null;
    ratings.push((lvl >= 1 && lvl <= 4) ? `level-${lvl}` : null);
  }
  return ratings;
}

function recalcRatingFromPhotos(streetId) {
  const street = streets.find(s => s.id === streetId);
  if (!street?.scanPhotos?.length) return;
  const rated = street.scanPhotos.filter(p => p.rating);
  if (!rated.length) return;
  const lvlNum = { 'level-1': 1, 'level-2': 2, 'level-3': 3, 'level-4': 4 };
  const avg = rated.reduce((sum, p) => sum + (lvlNum[p.rating] || 0), 0) / rated.length;
  street.rating = `level-${Math.max(1, Math.min(4, Math.round(avg)))}`;
  saveStreets();
  renderStreetList();
  updateStats();
  placeAllMarkers();
  selectStreet(streetId);
}

function setOnSitePhotoRating(streetId, photoId, rating) {
  const street = streets.find(s => s.id === streetId);
  if (!street?.photos) return;
  const photo = street.photos.find(p => p.id === photoId);
  if (photo) { photo.rating = rating || null; saveStreets(); }
}

function setPhotoRating(streetId, photoIndex, rating) {
  const street = streets.find(s => s.id === streetId);
  if (!street?.scanPhotos?.[photoIndex]) return;
  street.scanPhotos[photoIndex].rating = rating || null;
  recalcRatingFromPhotos(streetId);
}

function getProviderForModel(model) {
  if (model?.startsWith('gemini')) return 'gemini';
  if (model?.startsWith('claude')) return 'claude';
  return 'openai';
}

function extractWeedAlert(text) {
  const lower = text.toLowerCase();
  if (lower.includes('weed control needed')) return true;
  if (lower.includes('vegetation growing') || lower.includes('weeds growing') || lower.includes('grass growing')) return true;
  return false;
}

function extractWeedNotes(text) {
  // Section number varies depending on whether R&R section is present — match any number prefix
  const match = text.match(/\d+\.\s*WEED\/GRASS CONTROL[:\s]+([\s\S]*?)(?=\d+\.\s*RAVELING|\d+\.\s*REMOVE|\d+\.\s*WHAT I CAN'T SEE|\d+\.\s*Level:|$)/i);
  if (match) return match[1].trim();
  const match2 = text.match(/WEED\/GRASS CONTROL[:\s]+([\s\S]*?)(?=RAVELING|REMOVE\s*[&and]+\s*REPLACE|WHAT I CAN'T SEE|Level:|$)/i);
  return match2 ? match2[1].trim() : '';
}

function extractRavelingAlert(text) {
  const lower = text.toLowerCase();
  if (lower.includes('raveling detected')) return true;
  if (lower.includes('raveling present') || lower.includes('aggregate loss') || lower.includes('aggregate coming loose')) return true;
  return false;
}

function extractRavelingNotes(text) {
  // Section number varies — match any number prefix
  const match = text.match(/\d+\.\s*RAVELING[:\s]+([\s\S]*?)(?=\d+\.\s*REMOVE|\d+\.\s*WHAT I CAN'T SEE|\d+\.\s*Level:|$)/i);
  if (match) return match[1].trim();
  const match2 = text.match(/RAVELING[:\s]+([\s\S]*?)(?=REMOVE\s*[&and]+\s*REPLACE|WHAT I CAN'T SEE|Level:|$)/i);
  return match2 ? match2[1].trim() : '';
}

function extractWeedPhotoIndices(weedText) {
  const indices = [];
  const re = /Photo\s+(\d+)/gi;
  let m;
  while ((m = re.exec(weedText)) !== null) {
    const idx = parseInt(m[1]) - 1;
    if (!indices.includes(idx)) indices.push(idx);
  }
  return indices;
}

function extractRRAlert(text) {
  const lower = text.toLowerCase();
  if (lower.includes('remove & replace needed') || lower.includes('remove and replace needed')) return true;
  if (lower.includes('remove & replace') || lower.includes('r&r needed')) return true;
  return false;
}

function extractRRNotes(text) {
  const match = text.match(/6\.\s*REMOVE\s*[&and]+\s*REPLACE[:\s]+([\s\S]*?)(?=7\.\s*WHAT I CAN'T SEE|8\.\s*Level:|$)/i);
  if (match) return match[1].trim();
  const match2 = text.match(/REMOVE\s*[&and]+\s*REPLACE[:\s]+([\s\S]*?)(?=WHAT I CAN'T SEE|Level:|$)/i);
  return match2 ? match2[1].trim() : '';
}

function ratingLabel(rating) {
  switch (rating) {
    case 'level-1': case 'good': return 'LVL 1';
    case 'level-2': case 'fair': return 'LVL 2';
    case 'level-3': case 'poor': return 'LVL 3';
    case 'level-4': case 'critical': return 'LVL 4';
    default: return (rating || 'PENDING').toUpperCase();
  }
}

function ratingDescription(rating) {
  switch (rating) {
    case 'level-1': case 'good': return 'Zero to little cracks';
    case 'level-2': case 'fair': return 'Moderate light amount of cracks';
    case 'level-3': case 'poor': return 'Moderate heavy, deep cracks & alligator';
    case 'level-4': case 'critical': return 'Alligator everywhere, deep cracks every 3-5 ft';
    default: return '';
  }
}

// ─── TREATMENT RECOMMENDATION ──────────────────────────────
// Returns treatment label + color based on rating + project type
function getTreatment(rating, projectType) {
  const type = projectType || 'crack-seal';
  if (type === 'crack-seal') {
    switch (rating) {
      case 'level-1': return { label: 'Low priority',       color: '#22c55e' };
      case 'level-2': return { label: 'CS candidate',       color: '#eab308' };
      case 'level-3': return { label: 'Priority crack seal', color: '#f97316' };
      case 'level-4': return { label: 'Severe damage',      color: '#ef4444' };
      default:        return { label: '—',                  color: '#94a3b8' };
    }
  }
  // slurry or both
  switch (rating) {
    case 'level-1': return { label: 'Slurry Seal',               color: '#22c55e' };
    case 'level-2': return { label: 'Slurry Seal (CS may be needed)', color: '#eab308' };
    case 'level-3': return { label: 'Slurry + CS needed',        color: '#f97316' };
    case 'level-4': return { label: 'Severe damage',             color: '#ef4444' };
    default:        return { label: '—',                         color: '#94a3b8' };
  }
}

// Placeholder analysis when AI proxy isn't connected yet
function analyzeWithPlaceholder(street) {
  const levels = ['level-1', 'level-2', 'level-3', 'level-4'];
  const rating = levels[Math.floor(Math.random() * levels.length)];

  const analyses = {
    'level-1': `Street View Assessment — ${street.name}\n\n• Pavement appears to be in good overall condition\n• Zero to little cracking visible\n• Surface color and texture appear consistent\n\nNote: This is an automated scan from Street View.\n\nLevel: 1`,
    'level-2': `Street View Assessment — ${street.name}\n\n• Some visible surface wear and minor cracking detected\n• Moderate light amount of cracks\n• Pavement color suggests some aging\n\nNote: This is an automated scan from Street View.\n\nLevel: 2`,
    'level-3': `Street View Assessment — ${street.name}\n\n• Significant pavement deterioration visible\n• Moderate heavy cracking with deep cracks and alligator patterns\n• Surface appears rough and uneven in areas\n\nNote: This is an automated scan from Street View.\n\nLevel: 3`,
    'level-4': `Street View Assessment — ${street.name}\n\n• Severe pavement distress visible\n• Alligator cracking everywhere\n• Deep cracks and heavy cracking every 3-5 feet\n\nNote: This is an automated scan from Street View.\n\nLevel: 4`
  };

  return { text: analyses[rating], rating };
}

// ─── MAP MARKERS ───────────────────────────────────────────
function placeAllMarkers() {
  // Clear existing markers
  markers.forEach(m => removeFromMap(m));
  markers = [];

  streets.forEach(street => {
    const hasLine = street.path && street.path.length >= 2;
    const isStart = street.id === activeProject.startStreetId;
    const marker = makeMarker({
      position: { lat: street.lat, lng: street.lng },
      map: map,
      title: street.name,
      content: isStart
        ? (() => { const el = document.createElement('div'); el.style.cssText = 'width:26px;height:26px;border-radius:50%;background:#f59e0b;border:2px solid #fff;box-shadow:0 0 10px rgba(245,158,11,0.8);display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1'; el.textContent = '★'; return el; })()
        : makeDotContent(ratingColor(street.rating), hasLine ? 12 : 16, '#fff', hasLine ? 0 : 1)
    });

    marker.addEventListener('gmp-click', () => selectStreet(street.id));
    markers.push(marker);
  });
}

function fitMapToMarkers() {
  if (markers.length === 0) return;
  if (markers.length === 1) {
    map.setCenter(markers[0].getPosition());
    map.setZoom(15);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  markers.forEach(m => bounds.extend(m.getPosition()));
  map.fitBounds(bounds, 60);
}

function getStreetDirection(street) {
  const path = street.path;
  if (!path || path.length < 2) return null;
  const heading = calcHeading(path[0], path[path.length - 1]);
  if (heading >= 315 || heading < 45)  return 'NB';
  if (heading >= 45  && heading < 135) return 'EB';
  if (heading >= 135 && heading < 225) return 'SB';
  return 'WB';
}

function ratingColor(rating) {
  switch (rating) {
    case 'level-1': case 'good': return '#22c55e';
    case 'level-2': case 'fair': return '#eab308';
    case 'level-3': case 'poor': return '#f97316';
    case 'level-4': case 'critical': return '#ef4444';
    default: return '#94a3b8';
  }
}

// ─── STREET LIST ───────────────────────────────────────────
function isStreetViewOpen() {
  return streetViewPano && !document.getElementById('streetview-panel').classList.contains('hidden');
}

function renderStreetList() {
  const container = document.getElementById('street-list');

  if (streets.length === 0) {
    container.innerHTML = '<div class="empty-state">No streets added yet.<br>Click <strong>+ Add Street</strong> to begin.</div>';
    return;
  }

  // When Street View is open and a street is selected, only show that street
  const svOpen = isStreetViewOpen();

  // Sort: completed streets always at bottom, then by order
  const sortedStreets = [...streets].sort((a, b) => {
    if (a.completed && !b.completed) return 1;
    if (!a.completed && b.completed) return -1;
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return 0;
  });

  const visibleStreets = (svOpen && activeStreetId) ? sortedStreets.filter(s => s.id === activeStreetId) : sortedStreets;

  // Show a "back to all" link when filtered
  const backLink = (svOpen && activeStreetId && streets.length > 1) ?
    `<div class="street-list-back" onclick="closeDetailPanel();updateStats()">← Show all ${streets.length} streets</div>` : '';

  container.innerHTML = backLink + visibleStreets.map(s => {
    const d = formatDueDateBadge(s.dueDate);
    const dueBadge = d ? '<span class="due-badge due-badge-' + d.cls + '">' + d.label + '</span>' : '';
    const orderBadge = s.order != null ? '<span class="order-badge">#' + s.order + '</span>' : '';
    const doneBadge = s.completed ? '<span style="color:#22c55e;font-size:10px;font-weight:700;margin-right:4px">&#10003; DONE</span>' : '';
    const activeClass = s.id === activeStreetId ? ' active' : '';
    const warningClass = s.crossesBoundary ? ' street-card-warning' : '';
    const doneClass = s.completed ? ' street-card-done' : '';
    const dueBadgeHtml = dueBadge ? '<div>' + dueBadge + '</div>' : '';
    const cityHtml = s.city
      ? '<div class="street-card-city">' + escHtml(s.city) + (s.county ? ', ' + escHtml(s.county) : '') + (s.roadType ? ' &middot; ' + escHtml(s.roadType) : '') + '</div>'
      : (s.roadType ? '<div class="street-card-city">' + escHtml(s.roadType) + '</div>' : '');
    const boundaryHtml = s.crossesBoundary ? '<div class="street-card-boundary">&#9888; ' + escHtml(s.boundaryNote) + '</div>' : '';
    const weedHtml = s.weedAlert ? '<div class="street-card-weed">&#127807; Weed control needed</div>' : '';
    const ravelingHtml = s.ravelingAlert ? '<div class="street-card-weed" style="color:#f59e0b">&#9888; Raveling detected</div>' : '';
    const rrHtml = s.rrAlert ? '<div class="street-card-weed" style="color:#ef4444">&#128308; Remove &amp; Replace needed</div>' : '';
    const sqftText = s.sqft
      ? (activeProject.type === 'slurry' ? formatNumber(Math.round(s.sqft / 9)) + ' SY'
        : activeProject.type === 'both' ? formatNumber(s.sqft) + ' SF &middot; ' + formatNumber(Math.round(s.sqft / 9)) + ' SY'
        : formatNumber(s.sqft) + ' sq FT')
      : 'No dimensions';
    const treatment = (s.rating && s.rating !== 'pending') ? getTreatment(s.rating, activeProject.type) : null;
    const treatmentHtml = treatment ? '<div class="street-card-treatment" style="color:' + treatment.color + '">' + treatment.label + '</div>' : '';
    return `
    <div class="street-card${activeClass}${warningClass} street-card-${s.rating}${doneClass}" onclick="selectStreet('${s.id}')">
      <button class="street-card-delete" onclick="event.stopPropagation(); deleteStreet('${s.id}')" title="Delete">&times;</button>
      <div class="street-card-name" title="${escHtml(s.name)}">${orderBadge}${doneBadge}${escHtml(s.name)}</div>
      ${dueBadgeHtml}${cityHtml}${boundaryHtml}${weedHtml}${ravelingHtml}${rrHtml}
      <div class="street-card-meta">
        <span class="street-card-sqft">${sqftText}</span>
        <span class="rating-badge rating-${s.rating}" title="${ratingDescription(s.rating)}">${ratingLabel(s.rating)}</span>
      </div>
      ${treatmentHtml}
    </div>
  `}).join('');
}

// ─── SELECT STREET (detail panel) ──────────────────────────
let lastDrawnActiveId = null;
function switchDetailTab(tab) {
  window._detailTab = tab;
  document.querySelectorAll('.detail-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-tab-content]').forEach(el => el.classList.toggle('hidden', el.dataset.tabContent !== tab));
}

function selectStreet(id) {
  const isNewStreet = activeStreetId !== id;
  if (isNewStreet) window._detailTab = 'overview';
  activeStreetId = id;
  const street = streets.find(s => s.id === id);
  if (!street) return;

  // Redraw highlights if active street changed (for thickness)
  if (lastDrawnActiveId !== id) {
    lastDrawnActiveId = id;
    drawAllHighlights();
  }

  // Highlight card
  renderStreetList();

  // Zoom into the street
  map.panTo({ lat: street.lat, lng: street.lng });
  map.setZoom(18);

  // If Street View is open and a DIFFERENT street was selected, move to it
  const svOpen = streetViewPano && !document.getElementById('streetview-panel').classList.contains('hidden');
  if (svOpen && street.id !== window._svLastStreetId) {
    window._svLastStreetId = street.id;
    streetViewPano.setPosition({ lat: street.lat, lng: street.lng });
  }

  // Show detail panel
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  const activeTab = window._detailTab || 'overview';
  const totalPhotos = (street.photos||[]).length + (street.rrPhotos||[]).length + (street.scanPhotos||[]).length;

  document.getElementById('detail-content').innerHTML = `
    <!-- Always-visible header -->
    <div class="detail-header">
      <div class="detail-name-row" id="detail-name-display-${street.id}">
        <h3 class="detail-name-text" onclick="startInlineRename('${street.id}')" title="Click to rename">${escHtml(street.name)}</h3>
        <button class="btn-edit-analysis" onclick="startInlineRename('${street.id}')" style="font-size:11px;padding:2px 8px">Rename</button>
      </div>
      <div class="detail-name-row hidden" id="detail-name-edit-${street.id}">
        <input class="detail-name-input" id="detail-name-input-${street.id}" value="${escHtml(street.name)}" onkeydown="if(event.key==='Enter')saveInlineRename('${street.id}');if(event.key==='Escape')cancelInlineRename('${street.id}')">
        <button class="btn-primary" style="font-size:11px;padding:2px 10px;white-space:nowrap" onclick="saveInlineRename('${street.id}')">Save</button>
        <button class="btn-secondary" style="font-size:11px;padding:2px 8px" onclick="cancelInlineRename('${street.id}')">✕</button>
      </div>
      <div class="detail-header-meta">
        ${(() => { const dir = getStreetDirection(street); return dir ? `<span class="detail-dir-badge">${dir}</span>` : ''; })()}
        ${street.city ? `<span class="detail-jurisdiction">${escHtml(street.city)}${street.county ? ' — ' + escHtml(street.county) : ''}</span>` : ''}
      </div>
    </div>

    <!-- Tab bar -->
    <div class="detail-tabs">
      <button class="detail-tab ${activeTab==='overview'?'active':''}" data-tab="overview" onclick="switchDetailTab('overview')">Overview</button>
      <button class="detail-tab ${activeTab==='photos'?'active':''}" data-tab="photos" onclick="switchDetailTab('photos')">Photos${totalPhotos > 0 ? ` <span class="tab-count">${totalPhotos}</span>` : ''}</button>
      <button class="detail-tab ${activeTab==='analysis'?'active':''}" data-tab="analysis" onclick="switchDetailTab('analysis')">Analysis</button>
    </div>

    <!-- ── OVERVIEW TAB ── -->
    <div data-tab-content="overview" ${activeTab!=='overview'?'class="hidden"':''}>
      ${street.crossesBoundary ? `<div class="detail-boundary-warn">⚠ ${escHtml(street.boundaryNote)}</div>` : ''}
      ${street.weedAlert ? `<div class="detail-weed-warn">
        🌿 Weed/grass control may be needed
        ${street.weedNotes ? `<div class="weed-notes">${escHtml(street.weedNotes)}</div>` : ''}
        ${(street.weedNotes && street.scanPhotos?.length) ? (() => {
          const indices = extractWeedPhotoIndices(street.weedNotes);
          const photos = indices.map(i => street.scanPhotos[i]).filter(p => p?.lat);
          if (!photos.length) return '';
          return `<div class="weed-locations">${photos.map((p, pi) => {
            const photoIdx = indices[pi];
            return `<button class="weed-jump-btn" onclick="map.panTo({lat:${p.lat},lng:${p.lng}});map.setZoom(19);openLightbox(streets.find(s=>s.id==='${street.id}').scanPhotos,${photoIdx},'${street.id}')" title="Jump to photo location">${escHtml(p.label)}</button>`;
          }).join('')}</div>`;
        })() : ''}
      </div>` : ''}
      ${street.ravelingAlert ? `<div class="detail-weed-warn" style="border-color:rgba(245,158,11,0.3);background:rgba(245,158,11,0.08)">
        ⚠ Raveling detected
        ${street.ravelingNotes ? `<div class="weed-notes">${escHtml(street.ravelingNotes)}</div>` : ''}
        ${(street.ravelingNotes && street.scanPhotos?.length) ? (() => {
          const indices = extractWeedPhotoIndices(street.ravelingNotes);
          const photos = indices.map(i => street.scanPhotos[i]).filter(p => p?.lat);
          if (!photos.length) return '';
          return `<div class="weed-locations">${photos.map((p, pi) => {
            const photoIdx = indices[pi];
            return `<button class="weed-jump-btn" style="background:rgba(245,158,11,0.15);border-color:rgba(245,158,11,0.4);color:#f59e0b" onclick="map.panTo({lat:${p.lat},lng:${p.lng}});map.setZoom(19);openLightbox(streets.find(s=>s.id==='${street.id}').scanPhotos,${photoIdx},'${street.id}')" title="Jump to photo location">${escHtml(p.label)}</button>`;
          }).join('')}</div>`;
        })() : ''}
      </div>` : ''}
      ${street.rrAlert ? `<div class="detail-weed-warn" style="border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.08)">
        🔴 Remove &amp; Replace needed
        ${street.rrNotes ? `<div class="weed-notes">${escHtml(street.rrNotes)}</div>` : ''}
      </div>` : ''}
      ${isArterialStreet(street) && street.laneLayout ? `<div class="detail-lane-layout">
        <div class="lane-layout-title">🛣 Lane Layout</div>
        <div class="lane-layout-grid">
          ${street.laneLayout.throughLanes != null ? `<div class="lane-item"><span class="lane-label">Through Lanes</span><span class="lane-value">${street.laneLayout.throughLanes} per direction</span></div>` : ''}
          ${street.laneLayout.bikeLane?.present ? `<div class="lane-item"><span class="lane-label">Bike Lane</span><span class="lane-value">${street.laneLayout.bikeLane.side ? street.laneLayout.bikeLane.side + ' side' : 'Yes'}</span></div>` : ''}
          ${street.laneLayout.leftTurnPockets ? `<div class="lane-item"><span class="lane-label">Left Turn Pockets</span><span class="lane-value">${street.laneLayout.leftTurnPockets}</span></div>` : ''}
          ${street.laneLayout.rightLaneDrop ? `<div class="lane-item"><span class="lane-label">Right Lane Drop</span><span class="lane-value">Yes</span></div>` : ''}
          ${street.laneLayout.median ? `<div class="lane-item"><span class="lane-label">Median</span><span class="lane-value">Yes</span></div>` : ''}
        </div>
        ${street.laneLayout.notes ? `<div class="lane-notes">${escHtml(street.laneLayout.notes)}</div>` : ''}
        <button class="btn-secondary" style="margin-top:6px;font-size:11px;width:100%" onclick="rescanLaneLayout('${street.id}')">Re-analyze Lanes</button>
      </div>` : ''}

      <div class="detail-stats">
        <div class="detail-stat">
          <div class="detail-stat-label">Sq Ft</div>
          <div class="detail-stat-value">${street.sqft ? formatNumber(street.sqft) : '—'}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Sq Yards</div>
          <div class="detail-stat-value">${street.sqft ? formatNumber(Math.round(street.sqft / 9)) : '—'}</div>
        </div>
        <div class="detail-stat rating-card-${street.rating}">
          <div class="detail-stat-label">Rating</div>
          <div class="detail-stat-value"><span class="rating-badge rating-${street.rating}">${ratingLabel(street.rating)}</span></div>
          <select class="rating-select rating-${street.rating}" onchange="setRating('${street.id}', this.value)">
            <option value="level-1" ${street.rating === 'level-1' ? 'selected' : ''}>LVL 1</option>
            <option value="level-2" ${street.rating === 'level-2' ? 'selected' : ''}>LVL 2</option>
            <option value="level-3" ${street.rating === 'level-3' ? 'selected' : ''}>LVL 3</option>
            <option value="level-4" ${street.rating === 'level-4' ? 'selected' : ''}>LVL 4</option>
          </select>
        </div>
      </div>
      <div id="calibration-reason-prompt" class="hidden"></div>
      <div class="detail-stats">
        ${street.rating && street.rating !== 'pending' ? `
        <div class="detail-stat">
          <div class="detail-stat-label">Treatment</div>
          <div class="detail-stat-value" style="font-size:11px;color:${getTreatment(street.rating, activeProject.type).color};font-weight:600">${getTreatment(street.rating, activeProject.type).label}</div>
        </div>` : ''}
        <div class="detail-stat">
          <div class="detail-stat-label">Length</div>
          <div class="detail-stat-value">${street.length ? street.length + ' ft' : '—'}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Width</div>
          <div class="detail-stat-value">${street.width ? street.width + ' ft' : '—'}</div>
          ${street.roadType ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">${escHtml(street.roadType)}</div>` : ''}
        </div>
      </div>

      <div class="detail-section" style="margin-top:12px">
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Scheduling</div>
        <div class="detail-stats">
          <div class="detail-stat">
            <div class="detail-stat-label">Due Date</div>
            <input type="date" value="${street.dueDate || ''}" onchange="setStreetDueDate('${street.id}', this.value)" style="margin-top:4px;width:100%;background:var(--bg-dark);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;padding:4px 6px;outline:none;cursor:pointer">
            ${street.dueDate ? `<button onclick="setStreetDueDate('${street.id}','')" style="font-size:9px;color:var(--text-dim);background:none;border:none;cursor:pointer;margin-top:2px;padding:0">Clear date</button>` : ''}
          </div>
          <div class="detail-stat">
            <div class="detail-stat-label">Route Stop #</div>
            <input type="number" min="1" value="${street.order != null ? street.order : ''}" placeholder="—" onchange="setStreetOrder('${street.id}', this.value)" style="margin-top:4px;width:100%;background:var(--bg-dark);border:1px solid var(--border);border-radius:4px;color:var(--accent);font-size:16px;font-weight:700;padding:4px 6px;text-align:center;outline:none">
            ${street.order != null ? `<button onclick="setStreetOrder('${street.id}','')" style="font-size:9px;color:var(--text-dim);background:none;border:none;cursor:pointer;margin-top:2px;padding:0">Clear</button>` : ''}
          </div>
        </div>
      </div>

      <div class="detail-actions">
        ${activeProject.aiEnabled !== false ? `<button class="btn-rescan" onclick="rescanStreet('${street.id}')">Re-scan</button>` : ''}
        <button class="btn-rescan" onclick="toggleStreetDone('${street.id}')" style="border-color:#22c55e;color:#22c55e">${street.completed ? '&#8629; Incomplete' : '&#10003; Mark Done'}</button>
        <button class="btn-rescan" onclick="setStartStreet('${street.id}')" style="${activeProject.startStreetId === street.id ? 'border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,0.12)' : 'border-color:rgba(245,158,11,0.4);color:#9ca3af'}" title="Set as starting point for route optimization">${activeProject.startStreetId === street.id ? '&#9733; Start' : '&#9734; Set Start'}</button>
        <button class="btn-danger" onclick="deleteStreet('${street.id}')">Delete</button>
      </div>
    </div>

    <!-- ── PHOTOS TAB ── -->
    <div data-tab-content="photos" ${activeTab!=='photos'?'class="hidden"':''}>
      <div class="detail-section">
        <h4>Street View</h4>
        <img class="streetview-img" src="${street.svImage}" alt="Street View" onclick="openStreetViewAt(${street.lat}, ${street.lng})" style="cursor:pointer" title="Click to open interactive Street View" onerror="loadSvThumbnailViaProxy(this, '${street.svImage}')">
      </div>

      <div class="detail-section">
        <h4>On-Site Photos (${(street.photos || []).length})</h4>
        <button class="btn-photo" onclick="openPhotoCapture('${street.id}')">Take Photo</button>
        ${(street.photos || []).length > 0 ? `
          <div class="scan-photo-grid" style="margin-top:8px">
            ${street.photos.map((p, i) => `
              <div class="scan-photo-card scan-photo-rated-${p.rating || 'none'}" onclick="openLightbox(streets.find(s=>s.id==='${street.id}').photos, ${i}, '${street.id}')" title="Click to view photo">
                <button class="scan-photo-delete" onclick="event.stopPropagation();deletePhoto('${street.id}','${p.id}')" title="Delete">&times;</button>
                <span class="scan-photo-icon">&#128247;</span>
                <span class="scan-photo-label">${escHtml(street.name.split(',')[0])} (${i + 1})</span>
                <select class="photo-rating-select photo-rating-${p.rating || ''}" onclick="event.stopPropagation()" onchange="setOnSitePhotoRating('${street.id}','${p.id}',this.value)">
                  <option value="">—</option>
                  <option value="level-1" ${p.rating === 'level-1' ? 'selected' : ''}>LVL 1</option>
                  <option value="level-2" ${p.rating === 'level-2' ? 'selected' : ''}>LVL 2</option>
                  <option value="level-3" ${p.rating === 'level-3' ? 'selected' : ''}>LVL 3</option>
                  <option value="level-4" ${p.rating === 'level-4' ? 'selected' : ''}>LVL 4</option>
                </select>
              </div>
            `).join('')}
          </div>
        ` : '<p class="text-dim">No photos yet</p>'}
      </div>

      ${activeProject.detectRR ? `
      <div class="detail-section" style="border-color:rgba(239,68,68,0.3)">
        <h4 style="color:#ef4444">R&amp;R Photos (${(street.rrPhotos || []).length})</h4>
        <button class="btn-photo" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.4);color:#ef4444" onclick="openRRPhotoCapture('${street.id}')">Take R&amp;R Photo</button>
        ${(street.rrPhotos || []).length > 0 ? `
          <div class="photo-grid" style="margin-top:8px">
            ${(street.rrPhotos || []).map((p, i) => `
              <div class="photo-card" onclick="openAllRRLightbox('${p.id}')" style="cursor:pointer;border-color:rgba(239,68,68,0.3)">
                <img src="${p.dataUrl}" alt="R&R photo" class="photo-thumb">
                <div class="photo-info">
                  <div class="photo-info-top">
                    <span class="photo-info-addr" style="color:#ef4444">R&amp;R — ${p.address ? escHtml(p.address.split(',')[0]) : 'GPS tagged'}</span>
                    ${p.lat ? `<button class="btn-photo-jump" onclick="event.stopPropagation();map.panTo({lat:${p.lat},lng:${p.lng}});map.setZoom(19)">&#128205;</button>` : ''}
                  </div>
                  <span class="photo-info-date">${new Date(p.takenAt).toLocaleDateString()}</span>
                  ${p.note ? `<span class="photo-note">${escHtml(p.note)}</span>` : ''}
                </div>
                <button class="photo-delete" onclick="event.stopPropagation();deleteRRPhoto('${street.id}','${p.id}')">&times;</button>
              </div>
            `).join('')}
          </div>
        ` : '<p class="text-dim" style="margin-top:6px">No R&R photos yet</p>'}
      </div>` : ''}

      ${(street.scanPhotos && street.scanPhotos.length > 0) ? `
      <div class="detail-section">
        <h4>AI Scan Photos (${street.scanPhotos.length})
          <button class="btn-clear-scan-photos" onclick="clearScanPhotos('${street.id}')">Clear All</button>
        </h4>
        <div class="scan-photo-grid">
          ${street.scanPhotos.map((p, i) => `
            <div class="scan-photo-card scan-photo-rated-${p.rating || 'none'}" onclick="openLightbox(streets.find(s=>s.id==='${street.id}').scanPhotos, ${i}, '${street.id}')">
              <button class="scan-photo-delete" onclick="event.stopPropagation();deleteScanPhoto('${street.id}', ${i})">&times;</button>
              <span class="scan-photo-icon">&#128247;</span>
              <span class="scan-photo-label">${escHtml(p.label)}</span>
              ${p.svDate ? `<span class="scan-photo-date${parseInt(p.svDate) < new Date().getFullYear() - 4 ? ' scan-photo-date-old' : ''}">${p.svDate.slice(0,4)}</span>` : ''}
              <button class="scan-photo-retake" onclick="event.stopPropagation();retakeScanPhoto('${street.id}', ${i})">&#8635;</button>
              <select class="photo-rating-select photo-rating-${p.rating || ''}" onclick="event.stopPropagation()" onchange="setPhotoRating('${street.id}', ${i}, this.value)">
                <option value="">—</option>
                <option value="level-1" ${p.rating === 'level-1' ? 'selected' : ''}>LVL 1</option>
                <option value="level-2" ${p.rating === 'level-2' ? 'selected' : ''}>LVL 2</option>
                <option value="level-3" ${p.rating === 'level-3' ? 'selected' : ''}>LVL 3</option>
                <option value="level-4" ${p.rating === 'level-4' ? 'selected' : ''}>LVL 4</option>
              </select>
            </div>
          `).join('')}
        </div>
      </div>` : ''}
    </div>

    <!-- ── ANALYSIS TAB ── -->
    <div data-tab-content="analysis" ${activeTab!=='analysis'?'class="hidden"':''}>
      ${activeProject.aiEnabled !== false ? `
      <div class="detail-section analysis-section-${street.rating}">
        <h4>AI Pavement Analysis ${street.photosScanned ? `(${street.photosScanned} photo${street.photosScanned > 1 ? 's' : ''})` : ''}
          <button class="btn-edit-analysis" onclick="toggleEditAnalysis('${street.id}')" id="edit-analysis-btn">Edit</button>
        </h4>
        <div class="analysis-rating-summary">${ratingLabel(street.rating)} — ${ratingDescription(street.rating)}</div>
        <div class="ai-analysis" id="analysis-display">${formatAnalysis(street.analysis)}</div>
        <div class="analysis-edit-area hidden" id="analysis-edit">
          <textarea id="analysis-textarea" class="analysis-textarea">${escHtml(street.analysis || '')}</textarea>
          <div class="analysis-edit-actions">
            <button class="btn-save-analysis" onclick="saveAnalysis('${street.id}')">Save</button>
            <button class="btn-secondary btn-cancel-analysis" onclick="cancelEditAnalysis()">Cancel</button>
          </div>
        </div>
      </div>` : `<div class="detail-section"><div class="ai-off-notice">AI analysis is off for this project</div></div>`}

      <div class="detail-section">
        <h4>Admin Notes
          <button class="btn-edit-analysis" onclick="toggleEditNotes('${street.id}')" id="edit-notes-btn">${street.adminNotes ? 'Edit' : 'Add'}</button>
        </h4>
        ${street.adminNotes ? `<div class="admin-notes" id="notes-display">${escHtml(street.adminNotes)}</div>` : `<p class="text-dim" id="notes-display">No notes yet</p>`}
        <div class="analysis-edit-area hidden" id="notes-edit">
          <textarea id="notes-textarea" class="analysis-textarea" placeholder="Add your own notes...">${escHtml(street.adminNotes || '')}</textarea>
          <div class="analysis-edit-actions">
            <button class="btn-save-analysis" onclick="saveAdminNotes('${street.id}')">Save</button>
            <button class="btn-secondary btn-cancel-analysis" onclick="cancelEditNotes()">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // If Street View is open, add mini map at the top of the detail panel
  if (svOpen) {
    const miniMapDiv = document.createElement('div');
    miniMapDiv.innerHTML = `
      <div class="detail-section">
        <h4>Your Position</h4>
        <div id="mini-map" style="width:100%;height:200px;border-radius:8px;border:1px solid var(--border);margin-bottom:6px;"></div>
        <div id="mini-map-address" class="detail-jurisdiction" style="font-size:11px;">Loading location...</div>
      </div>
    `;
    const detailContent = document.getElementById('detail-content');
    detailContent.insertBefore(miniMapDiv, detailContent.children[1]);

    // Build mini map — clean up old one first, debounce rapid calls
    if (_miniMapTimer) clearTimeout(_miniMapTimer);
    _miniMapTimer = setTimeout(() => {
      if (svPositionListener) { google.maps.event.removeListener(svPositionListener); svPositionListener = null; }
      if (miniMapMarker) { removeFromMap(miniMapMarker); miniMapMarker = null; }
      miniMapLines.forEach(l => removeFromMap(l));
      miniMapLines = [];
      miniMap = new google.maps.Map(document.getElementById('mini-map'), {
        center: { lat: street.lat, lng: street.lng },
        zoom: 17,
        mapTypeId: 'roadmap',
        mapId: 'f2e86140855a96ecc6c0576f',
        colorScheme: 'DARK',
        disableDefaultUI: true,
        zoomControl: true
      });

      miniMapMarker = makeMarker({
        position: { lat: street.lat, lng: street.lng },
        map: miniMap,
        content: makeDotContent('#f59e0b', 20, '#fff')
      });

      // Draw highlighted streets on mini map
      miniMapLines = [];
      streets.forEach(s => {
        const pts = s.path;
        if (!pts || pts.length < 2) return;
        const line = new google.maps.Polyline({ path: pts, strokeColor: ratingColor(s.rating), strokeOpacity: 0.9, strokeWeight: 5, map: miniMap });
        miniMapLines.push(line);
      });

      // Track position changes
      let svGeoTimer = null;
      let svSwitchCandidate = null;
      let svSwitchCount = 0;

      if (streetViewPano) {
        svPositionListener = streetViewPano.addListener('position_changed', () => {
          const pos = streetViewPano.getPosition();
          if (miniMapMarker) { miniMapMarker.position = { lat: pos.lat(), lng: pos.lng() }; miniMap.setCenter(pos); }

          // Debounced address update (once per 2 sec, not every step)
          clearTimeout(svGeoTimer);
          svGeoTimer = setTimeout(() => {
            const geocoder = new google.maps.Geocoder();
            geocoder.geocode({ location: { lat: pos.lat(), lng: pos.lng() } }, (results, status) => {
              const el = document.getElementById('mini-map-address');
              if (el && status === 'OK' && results.length > 0) el.textContent = results[0].formatted_address;
            });
          }, 2000);

          // Auto-switch: only if you're very close AND stay near it for 3+ steps
          if (streets.length > 1) {
            const pLat = pos.lat(), pLng = pos.lng();
            let nearest = null, minDist = Infinity;
            streets.forEach(s => {
              const d = Math.sqrt(Math.pow(s.lat - pLat, 2) + Math.pow(s.lng - pLng, 2));
              if (d < minDist) { minDist = d; nearest = s; }
            });
            // ~0.0005 degrees ≈ 180 ft — must be very close
            if (nearest && nearest.id !== activeStreetId && minDist < 0.0005) {
              if (svSwitchCandidate === nearest.id) {
                svSwitchCount++;
                if (svSwitchCount >= 3) {
                  selectStreet(nearest.id);
                  svSwitchCount = 0;
                }
              } else {
                svSwitchCandidate = nearest.id;
                svSwitchCount = 1;
              }
            } else {
              svSwitchCandidate = null;
              svSwitchCount = 0;
            }
          }
        });
      }
    }, 100);
  }
}

function closeDetailPanel() {
  document.getElementById('detail-panel').classList.add('hidden');
  activeStreetId = null;
  renderStreetList();
}

// ─── SET RATING ───────────────────────────────────────────
function setRating(id, rating) {
  const street = streets.find(s => s.id === id);
  if (!street) return;

  // Detect calibration correction — only log if AI had rated this street differently
  if (street.aiRating && street.aiRating !== rating) {
    logCalibrationCorrection(street, street.aiRating, rating);
  }

  street.rating = rating;
  saveStreets();
  updateStats();
  placeAllMarkers();
  lastDrawnActiveId = null; // force highlight redraw
  selectStreet(id);
  showToast(`Rating set to ${ratingLabel(rating)}`);
}

// ─── CALIBRATION LEARNING ─────────────────────────────────
let _pendingCorrection = null; // last logged correction waiting for a reason

function logCalibrationCorrection(street, aiRating, calRating) {
  if (!activeProject.calibrationLog) activeProject.calibrationLog = [];
  const entry = {
    streetId: street.id,
    streetName: street.name,
    aiRating,
    calRating,
    reason: '',
    timestamp: new Date().toISOString()
  };
  activeProject.calibrationLog.push(entry);
  // Cap at 50 entries — remove oldest
  if (activeProject.calibrationLog.length > 50) activeProject.calibrationLog.shift();
  saveProjects();
  _pendingCorrection = entry;

  // Show reason prompt after detail panel re-renders (slight delay)
  setTimeout(showReasonPrompt, 300);
}

function showReasonPrompt() {
  if (!_pendingCorrection) return;
  // Use lightbox container if lightbox is open, otherwise detail panel
  const lightbox = document.getElementById('photo-lightbox');
  const lightboxOpen = lightbox && !lightbox.classList.contains('hidden');
  const containerId = lightboxOpen ? 'lightbox-calibration-reason' : 'calibration-reason-prompt';
  const container = document.getElementById(containerId);
  if (!container) return;
  const { aiRating, calRating } = _pendingCorrection;
  container.innerHTML = `
    <div class="calib-reason-box" id="calib-reason-box">
      <span class="calib-reason-label">AI said ${ratingLabel(aiRating)} → you changed to ${ratingLabel(calRating)}</span>
      <textarea class="calib-reason-input" id="calib-reason-input" placeholder="Why? (optional — helps AI learn your standard)" rows="2"></textarea>
      <div class="calib-reason-actions">
        <button class="btn-primary" style="font-size:11px;padding:5px 12px" onclick="saveCalibrationReason()">Save Reason</button>
        <button class="btn-secondary" style="font-size:11px;padding:5px 12px" onclick="dismissReasonPrompt()">Skip</button>
      </div>
    </div>
  `;
  container.classList.remove('hidden');

  // Auto-dismiss after 12 seconds if ignored
  setTimeout(() => dismissReasonPrompt(), 12000);
}

function dismissReasonPrompt() {
  _pendingCorrection = null;
  ['calibration-reason-prompt', 'lightbox-calibration-reason'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
  });
}

function saveCalibrationReason() {
  const input = document.getElementById('calib-reason-input');
  const reason = input ? input.value.trim() : '';
  if (_pendingCorrection && reason) {
    _pendingCorrection.reason = reason;
    saveProjects();
  }
  dismissReasonPrompt();
  if (reason) showToast('Reason saved');
}

async function openRefineAIModal() {
  const log = activeProject.calibrationLog || [];
  if (log.length === 0) { showToast('No corrections logged yet'); return; }

  document.getElementById('refine-ai-overlay').classList.remove('hidden');
  document.getElementById('refine-ai-loading').classList.remove('hidden');
  document.getElementById('refine-ai-rules').classList.add('hidden');

  try {
    const summary = log.map((e, i) =>
      `${i + 1}. Street: ${e.streetName} — AI rated ${ratingLabel(e.aiRating)}, Cal changed to ${ratingLabel(e.calRating)}${e.reason ? ` — Reason: "${e.reason}"` : ''}`
    ).join('\n');

    const res = await fetch(AI_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: 'gpt-4o',
        provider: 'openai',
        messages: [
          {
            role: 'system',
            content: `You are helping calibrate a pavement rating AI. Based on the corrections below, write 3–6 clear, concise rules that describe how this user rates pavement differently from the default. Each rule should be one sentence, actionable, and specific. Output ONLY a numbered list — no intro text, no explanation.`
          },
          { role: 'user', content: summary }
        ],
        max_tokens: 400
      })
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const rules = text.split('\n').map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);

    document.getElementById('refine-ai-loading').classList.add('hidden');
    const rulesContainer = document.getElementById('refine-ai-rules');
    rulesContainer.classList.remove('hidden');
    rulesContainer.innerHTML = `
      <p class="refine-ai-subtitle">Review these rules — approve, edit, or delete before applying.</p>
      <div id="refine-rules-list">
        ${rules.map((r, i) => `
          <div class="refine-rule-row" id="refine-rule-${i}">
            <input class="refine-rule-input" value="${escHtml(r)}" id="refine-rule-input-${i}">
            <button class="refine-rule-delete" onclick="document.getElementById('refine-rule-${i}').remove()" title="Remove">✕</button>
          </div>
        `).join('')}
      </div>
      <div class="refine-ai-actions">
        <button class="btn-primary" onclick="applyCalibrationRules()">Apply Rules</button>
        <button class="btn-secondary" onclick="closeRefineAIModal()">Cancel</button>
      </div>
    `;
  } catch (e) {
    console.error('Refine AI error:', e);
    document.getElementById('refine-ai-loading').innerHTML = '<p style="color:#ef4444">Failed to generate rules — try again.</p>';
  }
}

function applyCalibrationRules() {
  const inputs = document.querySelectorAll('.refine-rule-input');
  const rules = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
  if (rules.length === 0) { showToast('No rules to apply'); return; }
  activeProject.calibrationRules = rules;
  activeProject.calibrationLog = []; // clear log after rules applied
  saveProjects();
  closeRefineAIModal();
  renderProjectSelector();
  showToast(`${rules.length} calibration rule${rules.length > 1 ? 's' : ''} applied`);
}

function closeRefineAIModal(e) {
  if (e && e.target !== document.getElementById('refine-ai-overlay')) return;
  document.getElementById('refine-ai-overlay').classList.add('hidden');
}

function clearCalibrationRules() {
  if (!confirm('Clear all calibration rules?')) return;
  activeProject.calibrationRules = [];
  activeProject.calibrationLog = [];
  saveProjects();
  renderProjectSelector();
  showToast('Calibration cleared');
}

// ─── EDIT ANALYSIS & ADMIN NOTES ──────────────────────────
function toggleEditAnalysis(id) {
  const display = document.getElementById('analysis-display');
  const edit = document.getElementById('analysis-edit');
  const btn = document.getElementById('edit-analysis-btn');
  if (edit.classList.contains('hidden')) {
    edit.classList.remove('hidden');
    display.classList.add('hidden');
    btn.textContent = 'Cancel';
    document.getElementById('analysis-textarea').focus();
  } else {
    cancelEditAnalysis();
  }
}

function cancelEditAnalysis() {
  document.getElementById('analysis-edit').classList.add('hidden');
  document.getElementById('analysis-display').classList.remove('hidden');
  document.getElementById('edit-analysis-btn').textContent = 'Edit';
}

function saveAnalysis(id) {
  const street = streets.find(s => s.id === id);
  if (!street) return;
  const text = document.getElementById('analysis-textarea').value.trim();
  street.analysis = text;
  street.rating = extractRating(text);
  street.weedAlert = extractWeedAlert(text);
  street.weedNotes = extractWeedNotes(text);
  street.ravelingAlert = extractRavelingAlert(text);
  street.ravelingNotes = extractRavelingNotes(text);
  street.rrAlert = extractRRAlert(text);
  street.rrNotes = extractRRNotes(text);
  saveStreets();
  renderStreetList();
  updateStats();
  placeAllMarkers();
  selectStreet(id);
  showToast('Analysis updated');
}

function toggleEditNotes(id) {
  const display = document.getElementById('notes-display');
  const edit = document.getElementById('notes-edit');
  const btn = document.getElementById('edit-notes-btn');
  if (edit.classList.contains('hidden')) {
    edit.classList.remove('hidden');
    display.classList.add('hidden');
    btn.textContent = 'Cancel';
    document.getElementById('notes-textarea').focus();
  } else {
    cancelEditNotes();
  }
}

function cancelEditNotes() {
  document.getElementById('notes-edit').classList.add('hidden');
  document.getElementById('notes-display').classList.remove('hidden');
  const street = streets.find(s => s.id === activeStreetId);
  document.getElementById('edit-notes-btn').textContent = street?.adminNotes ? 'Edit' : 'Add';
}

function saveAdminNotes(id) {
  const street = streets.find(s => s.id === id);
  if (!street) return;
  street.adminNotes = document.getElementById('notes-textarea').value.trim();
  saveStreets();
  selectStreet(id);
  showToast('Notes saved');
}

// ─── RESCAN STREET ─────────────────────────────────────────
let _rescanning = false;
async function rescanStreet(id) {
  if (_rescanning) return;
  if (activeProject.aiEnabled === false) {
    showToast('AI is off — turn it on to re-scan');
    return;
  }
  const street = streets.find(s => s.id === id);
  if (!street) return;

  _rescanning = true;
  showScanModal('Re-scanning pavement condition...');
  try {
    const analysis = await analyzeStreetView(street);
    street.analysis = analysis.text;
    street.rating = analysis.rating;
    street.aiRating = analysis.rating;
    street.weedAlert = analysis.weedAlert || false;
    street.weedNotes = analysis.weedNotes || '';
    street.ravelingAlert = analysis.ravelingAlert || false;
    street.ravelingNotes = analysis.ravelingNotes || '';
    street.rrAlert = analysis.rrAlert || false;
    street.rrNotes = analysis.rrNotes || '';
    street.scannedAt = new Date().toISOString();
    if (activeProject.detectLaneLayout && isArterialStreet(street)) {
      showScanModal('Analyzing lane layout...');
      const layout = await analyzeLaneLayout(street);
      if (layout) street.laneLayout = layout;
    }

    saveStreets();
    drawAllHighlights();
    placeAllMarkers();
    updateStats();
    selectStreet(id);
    showToast('Street re-scanned');
  } finally {
    _rescanning = false;
    hideScanModal();
  }
}

// ─── DELETE STREET ─────────────────────────────────────────
function deleteStreet(id) {
  // Toggle off if already showing
  const existing = document.getElementById('delete-confirm-' + id);
  if (existing) { existing.remove(); return; }

  // Remove any other open confirms
  document.querySelectorAll('.delete-confirm').forEach(el => el.remove());

  // Try to find the card in sidebar
  const cards = document.querySelectorAll('.street-card');
  let targetCard = null;
  cards.forEach(c => { if (c.getAttribute('onclick')?.includes(id)) targetCard = c; });

  // If found in sidebar, insert after card. Otherwise insert in detail panel actions.
  const confirmEl = document.createElement('div');
  confirmEl.id = 'delete-confirm-' + id;
  confirmEl.className = 'delete-confirm';
  confirmEl.innerHTML = `
    <span>Delete this street?</span>
    <div class="delete-confirm-btns">
      <button class="dc-yes" onclick="event.stopPropagation(); confirmDelete('${id}')">Yes, delete</button>
      <button class="dc-no" onclick="event.stopPropagation(); this.parentElement.parentElement.remove()">Cancel</button>
    </div>
  `;

  if (targetCard) {
    targetCard.after(confirmEl);
  } else {
    // Insert in detail panel
    const actions = document.querySelector('.detail-actions');
    if (actions) actions.after(confirmEl);
  }
}

function confirmDelete(id) {
  streets = streets.filter(s => s.id !== id);
  activeProject.streets = streets;
  saveStreets();
  closeDetailPanel();
  renderStreetList();
  placeAllMarkers();
  placePhotoMarkers();
  drawAllHighlights();
  updateStats();
  showToast('Street removed');
}

// ─── UPDATE STATS ──────────────────────────────────────────
function updateStats() {
  const svOpen = isStreetViewOpen();
  const activeStreet = activeStreetId ? streets.find(s => s.id === activeStreetId) : null;

  // When viewing a single street in Street View, show that street's stats
  if (svOpen && activeStreet) {
    document.getElementById('stat-streets').querySelector('.stat-label').textContent = 'Viewing';
    document.getElementById('total-streets').textContent = '1 / ' + streets.length;
    document.getElementById('stat-sqft').querySelector('.stat-label').textContent = 'Sq Ft';
    document.getElementById('total-sqft').textContent = formatNumber(activeStreet.sqft || 0);
    document.getElementById('total-sy').textContent = formatNumber(Math.round((activeStreet.sqft || 0) / 9));
    document.getElementById('stat-rating').querySelector('.stat-label').textContent = 'Rating';
    document.getElementById('avg-rating').textContent = ratingLabel(activeStreet.rating);
    return;
  }

  // Project-wide stats
  document.getElementById('stat-streets').querySelector('.stat-label').textContent = 'Streets';
  document.getElementById('total-streets').textContent = streets.length;
  document.getElementById('stat-sqft').querySelector('.stat-label').textContent = 'Total Sq Ft';
  const totalSqft = streets.reduce((sum, s) => sum + (s.sqft || 0), 0);
  document.getElementById('total-sqft').textContent = formatNumber(totalSqft);
  document.getElementById('total-sy').textContent = formatNumber(Math.round(totalSqft / 9));

  // Average rating (Level 1-4)
  document.getElementById('stat-rating').querySelector('.stat-label').textContent = 'Avg Rating';
  const ratingValues = { 'level-1': 1, 'level-2': 2, 'level-3': 3, 'level-4': 4, good: 1, fair: 2, poor: 3, critical: 4, pending: 0 };
  const rated = streets.filter(s => s.rating !== 'pending');
  if (rated.length > 0) {
    const avg = rated.reduce((sum, s) => sum + (ratingValues[s.rating] || 0), 0) / rated.length;
    document.getElementById('avg-rating').textContent = 'LVL ' + Math.round(avg);
  } else {
    document.getElementById('avg-rating').textContent = '—';
  }
}

// ─── PHOTO LIGHTBOX ────────────────────────────────────────
// _lbPhotoArray: 'photos' | 'rrPhotos' | 'scanPhotos'
// _lbRRMap: photoId → streetId (used when R&R photos span multiple streets)
let _lbPhotos = [], _lbIdx = 0, _lbStreetId = null, _lbPhotoArray = 'photos', _lbRRMap = {};

function openLightbox(photos, idx, streetId, arrayName, rrMap) {
  _lbPhotos = photos;
  _lbIdx = idx;
  _lbStreetId = streetId || null;
  _lbRRMap = rrMap || {};
  if (arrayName) {
    _lbPhotoArray = arrayName;
  } else if (photos.length > 0 && photos[0].hdUrl) {
    _lbPhotoArray = 'scanPhotos';
  } else {
    const street = streets.find(s => s.id === streetId);
    if (street && street.rrPhotos === photos) {
      _lbPhotoArray = 'rrPhotos';
    } else {
      _lbPhotoArray = 'photos';
    }
  }
  _renderLightbox();
  document.getElementById('photo-lightbox').classList.remove('hidden');
}

function _lbGetStreetId() {
  // For combined R&R view, resolve the street from the current photo's id
  if (_lbPhotoArray === 'rrPhotos' && Object.keys(_lbRRMap).length > 0) {
    const p = _lbPhotos[_lbIdx];
    return p ? (_lbRRMap[p.id] || _lbStreetId) : _lbStreetId;
  }
  return _lbStreetId;
}

function lightboxSetRating(value) {
  const streetId = _lbGetStreetId();
  if (!streetId) return;
  const p = _lbPhotos[_lbIdx];
  if (!p) return;
  const oldRating = p.rating; // capture before overwrite
  p.rating = value || null;
  if (_lbPhotoArray === 'scanPhotos') {
    setPhotoRating(streetId, _lbIdx, value);
    if (value) {
      const street = streets.find(s => s.id === streetId);
      if (street && oldRating && oldRating !== value) {
        logCalibrationCorrection(street, oldRating, value);
        showReasonPrompt();
      }
      if (street) {
        street.rating = value;
        saveStreets();
        updateStats();
        placeAllMarkers();
        lastDrawnActiveId = null;
      }
    }
  } else {
    saveStreets();
  }
}

function lightboxSetNote(value) {
  const p = _lbPhotos[_lbIdx];
  if (!p) return;
  p.note = value;
  saveStreets();
}

function lightboxSaveNote() {
  const value = document.getElementById('lightbox-note-input')?.value || '';
  lightboxSetNote(value);
  showToast('Note saved');
}

function lightboxDeletePhoto() {
  const p = _lbPhotos[_lbIdx];
  if (!p?.id) return;
  const streetId = _lbGetStreetId();
  if (!streetId) return;
  if (_lbPhotoArray === 'rrPhotos') {
    deleteRRPhoto(streetId, p.id);
  } else {
    deletePhoto(streetId, p.id);
  }
  closeLightbox();
}

function closeLightbox() {
  document.getElementById('photo-lightbox').classList.add('hidden');
}

function lightboxRetakePhoto() {
  if (_lbPhotoArray !== 'scanPhotos') return;
  const streetId = _lbGetStreetId();
  if (!streetId) return;
  closeLightbox();
  retakeScanPhoto(streetId, _lbIdx);
}

function lightboxNav(dir) {
  if (_lbPhotos.length === 0) return;
  _lbIdx = (_lbIdx + dir + _lbPhotos.length) % _lbPhotos.length;
  _renderLightbox();
}

async function _renderLightbox() {
  const p = _lbPhotos[_lbIdx];
  const img = document.getElementById('lightbox-img');
  const label = document.getElementById('lightbox-label');
  const count = document.getElementById('lightbox-count');
  const sel = document.getElementById('lightbox-rating-select');
  const delBtn = document.getElementById('lightbox-delete');
  const noteRow = document.getElementById('lightbox-note-row');
  const noteInput = document.getElementById('lightbox-note-input');

  // Label: scan photos use p.label, on-site photos use address
  const isOnsite = _lbPhotoArray === 'photos' || _lbPhotoArray === 'rrPhotos';
  let labelText = p.label || (p.address ? p.address.split(',')[0] : 'On-site photo');
  if (_lbPhotoArray === 'rrPhotos') {
    const streetId = _lbRRMap[p.id] || _lbStreetId;
    const streetName = streets.find(s => s.id === streetId)?.name?.split(',')[0] || '';
    labelText = `R&R — ${streetName || (p.address ? p.address.split(',')[0] : 'On-site')}`;
  }
  label.textContent = labelText;
  count.textContent = `${_lbIdx + 1} / ${_lbPhotos.length}`;
  if (sel) sel.value = p.rating || '';

  // Show note editor for on-site and R&R photos (not scan photos)
  if (noteRow && noteInput) {
    noteRow.classList.toggle('hidden', !isOnsite);
    if (isOnsite) noteInput.value = p.note || '';
  }

  // Show delete button for on-site and R&R photos (they have id)
  if (delBtn) delBtn.classList.toggle('hidden', !p.id);

  // Show retake button only for scan photos that have a location
  const retakeBtn = document.getElementById('lightbox-retake');
  if (retakeBtn) retakeBtn.classList.toggle('hidden', !(_lbPhotoArray === 'scanPhotos' && p.lat && p.lng));

  // On-site photos have dataUrl stored directly — no proxy needed
  if (p.dataUrl) {
    img.src = p.dataUrl;
    img.alt = '';
    return;
  }

  // Scan photos: use embedded base64 first, then memory cache, then fetch on-demand
  if (p.dataUrl) { img.src = p.dataUrl; return; }
  const cacheKey = p.hdUrl || p.url;
  const cached = cacheKey ? _photoCache.get(cacheKey) : null;
  if (cached) {
    img.src = cached;
  } else {
    img.src = '';
    img.alt = 'Loading...';
    const dataUrl = await imageUrlToBase64(cacheKey);
    if (dataUrl) {
      if (cacheKey) _photoCache.set(cacheKey, dataUrl);
      img.src = dataUrl;
      img.alt = '';
    } else {
      img.alt = 'Photo not available';
    }
  }
}

// ─── HELPERS ───────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatAnalysis(text) {
  if (!text) return '<span class="text-dim">No analysis available</span>';

  const lines = text.split('\n');
  let html = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { html += '<div class="analysis-spacer"></div>'; continue; }

    // Level line — skip it, rating is already shown at the top of the panel
    if (line.match(/Level:\s*\[?([1-4])\]?/i) || line.match(/^Level\s*[1-4]\s*[—\-]/i)) continue;

    // Numbered section header — e.g. "1. PHOTOS ANALYZED" or "2. WHAT I CAN SEE"
    const sectionMatch = line.match(/^(\d+)\.\s+([A-Z][A-Z\s\/&']+)(:.*)?$/);
    if (sectionMatch) {
      const title = sectionMatch[2].trim();
      const rest = sectionMatch[3] ? escHtml(sectionMatch[3].slice(1).trim()) : '';
      html += `<div class="analysis-section-header">${escHtml(title)}${rest ? `<span class="analysis-section-value">${rest}</span>` : ''}</div>`;
      continue;
    }

    // Photo ratings line — render as colored badges
    if (/^Photo\s+\d+:\s+\[?\d/.test(line)) {
      const badges = [];
      const matches = [...line.matchAll(/Photo\s+(\d+):\s*\[?([1-4])\]?/g)];
      matches.forEach(m => {
        const num = m[1], lvl = m[2];
        const colors = { '1':'#22c55e','2':'#eab308','3':'#f97316','4':'#ef4444' };
        badges.push(`<span style="display:inline-flex;align-items:center;gap:3px;background:rgba(255,255,255,0.05);border:1px solid ${colors[lvl]}33;border-radius:4px;padding:2px 6px;font-size:10px"><span style="color:var(--text-dim)">Photo ${num}</span><span style="color:${colors[lvl]};font-weight:700">LVL ${lvl}</span></span>`);
      });
      if (badges.length) {
        html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:2px">${badges.join('')}</div>`;
        continue;
      }
    }

    // Flag lines — ⚠, 🌿, 🔴
    if (line.includes('⚠') || line.includes('🌿') || line.includes('🔴')) {
      const flagColor = line.includes('🌿') ? '#22c55e' : line.includes('🔴') ? '#ef4444' : '#f59e0b';
      html += `<div class="analysis-flag" style="color:${flagColor}">${escHtml(line)}</div>`;
      continue;
    }

    // Bullet point — starts with - or •
    if (/^[-•]/.test(line)) {
      html += `<div class="analysis-bullet">${escHtml(line.replace(/^[-•]\s*/, ''))}</div>`;
      continue;
    }

    // "None detected." or plain result line
    if (/^none detected/i.test(line)) {
      html += `<div class="analysis-none">${escHtml(line)}</div>`;
      continue;
    }

    // Default — plain line
    html += `<div class="analysis-line">${escHtml(line)}</div>`;
  }

  return html;
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return '0';
  return n.toLocaleString('en-US');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function showToast(msg, duration = 2500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = 'background:#222;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;opacity:0;transition:opacity 0.3s;pointer-events:auto;';
  container.appendChild(toast);
  requestAnimationFrame(() => toast.style.opacity = '1');
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── SEARCH LOCATION ───────────────────────────────────────
async function searchLocation() {
  const input = document.getElementById('search-input');
  const query = input.value.trim();
  if (!query) return;

  showToast('Searching...');
  const geo = await geocodeAddress(query);
  if (!geo) {
    showToast('Could not find that location — try adding a city name');
    return;
  }

  // Zoom based on precision: rooftop/interpolated = street level, otherwise back out a bit
  const zoom = (geo.locationType === 'ROOFTOP' || geo.locationType === 'RANGE_INTERPOLATED') ? 21 : 17;
  map.setCenter({ lat: geo.lat, lng: geo.lng });
  map.setZoom(zoom);
  input.value = '';
  showToast(`Found: ${geo.formatted}`);
}

// ─── NEAR ME (GPS) ─────────────────────────────────────────
function goToMyLocation() {
  if (!navigator.geolocation) {
    showToast('GPS not available on this device');
    return;
  }

  showToast('Getting your location...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      map.setCenter({ lat, lng });
      map.setZoom(18);

      // Drop a blue "You" marker
      if (window._myLocationMarker) removeFromMap(window._myLocationMarker);
      window._myLocationMarker = makeMarker({
        position: { lat, lng },
        map: map,
        title: 'You are here',
        content: makeDotContent('#3b82f6', 20, '#fff')
      });
      showToast('Centered on your location');
    },
    (err) => {
      showToast('Could not get your location — check GPS permissions');
      console.error('Geolocation error:', err);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ─── ON-SITE PHOTO CAPTURE ─────────────────────────────────
function openPhotoCapture(streetId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment'; // opens camera on mobile
  input.onchange = (e) => handlePhotoCapture(e, streetId);
  input.click();
}

async function handlePhotoCapture(e, streetId) {
  const file = e.target.files[0];
  if (!file) return;

  const street = streets.find(s => s.id === streetId);
  if (!street) return;
  if (!street.photos) street.photos = [];

  showToast('Processing photo...');

  // Compress image
  const dataUrl = await compressPhoto(file, 800, 0.7);

  // Get GPS from photo or fallback to device GPS
  const photoLocation = await getPhotoGPS();

  const photo = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    dataUrl: dataUrl,
    lat: photoLocation?.lat || street.lat,
    lng: photoLocation?.lng || street.lng,
    address: '',
    note: '',
    takenAt: new Date().toISOString()
  };

  // Reverse geocode to get address
  if (photo.lat && photo.lng) {
    try {
      const geocoder = new google.maps.Geocoder();
      const result = await new Promise((resolve) => {
        geocoder.geocode({ location: { lat: photo.lat, lng: photo.lng } }, (results, status) => {
          resolve(status === 'OK' && results.length > 0 ? results[0].formatted_address : '');
        });
      });
      photo.address = result;
    } catch (e) { /* skip */ }
  }

  street.photos.push(photo);
  saveStreets();
  placePhotoMarkers();
  selectStreet(streetId);
  showToast('Photo added with GPS location');
}

function getPhotoGPS() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });
}

function compressPhoto(file, maxPx, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = h * maxPx / w; w = maxPx; }
          else { w = w * maxPx / h; h = maxPx; }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function deletePhoto(streetId, photoId) {
  const street = streets.find(s => s.id === streetId);
  if (!street || !street.photos) return;
  street.photos = street.photos.filter(p => p.id !== photoId);
  saveStreets();
  placePhotoMarkers();
  selectStreet(streetId);
  showToast('Photo removed');
}

// ─── R&R PHOTO CAPTURE ─────────────────────────────────────
function openRRPhotoCapture(streetId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = (e) => handleRRPhotoCapture(e, streetId);
  input.click();
}

async function handleRRPhotoCapture(e, streetId) {
  const file = e.target.files[0];
  if (!file) return;

  const street = streets.find(s => s.id === streetId);
  if (!street) return;
  if (!street.rrPhotos) street.rrPhotos = [];

  showToast('Processing R&R photo...');

  const dataUrl = await compressPhoto(file, 800, 0.7);
  const photoLocation = await getPhotoGPS();

  const photo = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    dataUrl: dataUrl,
    lat: photoLocation?.lat || street.lat,
    lng: photoLocation?.lng || street.lng,
    address: '',
    note: '',
    takenAt: new Date().toISOString()
  };

  if (photo.lat && photo.lng) {
    try {
      const geocoder = new google.maps.Geocoder();
      const result = await new Promise((resolve) => {
        geocoder.geocode({ location: { lat: photo.lat, lng: photo.lng } }, (results, status) => {
          resolve(status === 'OK' && results.length > 0 ? results[0].formatted_address : '');
        });
      });
      photo.address = result;
    } catch (e) { /* skip */ }
  }

  street.rrPhotos.push(photo);
  saveStreets();
  placePhotoMarkers();
  selectStreet(streetId);
  showToast('R&R photo added with GPS location');
}

function deleteRRPhoto(streetId, photoId) {
  const street = streets.find(s => s.id === streetId);
  if (!street || !street.rrPhotos) return;
  street.rrPhotos = street.rrPhotos.filter(p => p.id !== photoId);
  saveStreets();
  placePhotoMarkers();
  selectStreet(streetId);
  showToast('R&R photo removed');
}

function deleteScanPhoto(streetId, index) {
  const street = streets.find(s => s.id === streetId);
  if (!street?.scanPhotos) return;
  street.scanPhotos.splice(index, 1);
  // recalcRatingFromPhotos calls saveStreets + selectStreet internally
  if (street.scanPhotos.length > 0) {
    recalcRatingFromPhotos(streetId);
  } else {
    saveStreets();
    selectStreet(streetId);
  }
  showToast('Scan photo removed');
}

function clearScanPhotos(streetId) {
  const street = streets.find(s => s.id === streetId);
  if (!street) return;
  street.scanPhotos = [];
  saveStreets();
  selectStreet(streetId);
  showToast('All scan photos cleared');
}

// ─── RETAKE SCAN PHOTO ─────────────────────────────────────
// Opens Street View at the photo's location — user looks around,
// picks the angle they want, then taps "Replace Photo" to save it.
let _retakeMode = null; // { streetId, photoIndex, label } when active

function retakeScanPhoto(streetId, photoIndex) {
  const street = streets.find(s => s.id === streetId);
  if (!street?.scanPhotos?.[photoIndex]) return;
  const photo = street.scanPhotos[photoIndex];
  if (!photo.lat || !photo.lng) { showToast('No location data for this photo'); return; }

  _retakeMode = { streetId, photoIndex, label: photo.label };

  // Switch toolbar to retake mode
  const snapBtns = document.getElementById('sv-snap-btns');
  const replaceBtn = document.getElementById('btn-sv-replace');
  if (snapBtns) snapBtns.classList.add('hidden');
  if (replaceBtn) {
    replaceBtn.classList.remove('hidden');
    replaceBtn.textContent = `\u8617 Replace "${photo.label}"`;
  }

  // Open Street View at this photo's location
  // Face down the road using the street's heading as a starting point
  const path = street.path || [];
  const roadHeading = path.length >= 2 ? calcHeading(path[0], path[path.length - 1]) : 0;
  openStreetViewAt(photo.lat, photo.lng, roadHeading);
  showToast(`Look around — tap Replace when ready`);
}

async function snapRetake() {
  if (!_retakeMode || !streetViewPano) return;
  const { streetId, photoIndex } = _retakeMode;

  const pos = streetViewPano.getPosition();
  const pov = streetViewPano.getPov();
  const lat = pos.lat(), lng = pos.lng();
  const heading = Math.round(pov.heading || 0);
  const pitch = Math.round(pov.pitch || -25);

  showToast('Saving...');

  const hdUrl = getStreetViewUrlHD(lat, lng, heading);
  const img = await imageUrlToBase64(hdUrl);
  if (!img) { showToast('Could not fetch image — try again'); return; }

  const street = streets.find(s => s.id === streetId);
  if (!street?.scanPhotos?.[photoIndex]) { showToast('Photo slot no longer exists'); return; }

  _photoCache.set(hdUrl, img);
  street.scanPhotos[photoIndex] = { ...street.scanPhotos[photoIndex], url: hdUrl, hdUrl, lat, lng };
  saveStreets();

  clearRetakeMode();
  closeStreetViewPanel();
  selectStreet(streetId);
  showToast('Photo replaced');
}

function clearRetakeMode() {
  _retakeMode = null;
  const snapBtns = document.getElementById('sv-snap-btns');
  const replaceBtn = document.getElementById('btn-sv-replace');
  if (snapBtns) snapBtns.classList.remove('hidden');
  if (replaceBtn) replaceBtn.classList.add('hidden');
}

// ─── PHOTO MARKERS ON MAP ──────────────────────────────────
let photoMarkers = [];
let _activeInfoWindow = null;

function placePhotoMarkers() {
  photoMarkers.forEach(m => removeFromMap(m));
  photoMarkers = [];

  // Build combined R&R array + streetId map across all streets
  const allRRPhotos = [];
  const rrMap = {};
  streets.forEach(street => {
    (street.rrPhotos || []).forEach(photo => {
      allRRPhotos.push(photo); // reference — mutations persist to original
      rrMap[photo.id] = street.id;
    });
  });

  streets.forEach(street => {
    // Purple pins — on-site photos (per street)
    (street.photos || []).forEach(photo => {
      if (!photo.lat || !photo.lng) return;
      const dotEl = makeDotContent('#a855f7', 14, '#fff');
      const marker = makeMarker({
        position: { lat: photo.lat, lng: photo.lng },
        map: map,
        title: `Photo — ${photo.address || 'On-site'}`,
        content: dotEl,
        gmpClickable: true
      });

      const photoIndex = street.photos.indexOf(photo);
      const openInfo = () => {
        openLightbox(street.photos, photoIndex, street.id);
      };
      marker.addEventListener('gmp-click', openInfo);
      dotEl.addEventListener('click', openInfo);
      photoMarkers.push(marker);
    });

    // Red pins — R&R photos (open combined view across ALL streets)
    (street.rrPhotos || []).forEach(photo => {
      if (!photo.lat || !photo.lng) return;
      const dotEl = makeDotContent('#ef4444', 14, '#fff');
      const marker = makeMarker({
        position: { lat: photo.lat, lng: photo.lng },
        map: map,
        title: `R&R Photo — ${photo.address || 'On-site'}`,
        content: dotEl,
        gmpClickable: true
      });

      const globalIdx = allRRPhotos.indexOf(photo);
      const openInfo = () => {
        openLightbox(allRRPhotos, globalIdx, null, 'rrPhotos', rrMap);
      };
      marker.addEventListener('gmp-click', openInfo);
      dotEl.addEventListener('click', openInfo);
      photoMarkers.push(marker);
    });
  });
}

// Opens combined R&R lightbox starting at a specific photo id
function openAllRRLightbox(photoId) {
  const allRRPhotos = [];
  const rrMap = {};
  streets.forEach(street => {
    (street.rrPhotos || []).forEach(photo => {
      allRRPhotos.push(photo);
      rrMap[photo.id] = street.id;
    });
  });
  const idx = allRRPhotos.findIndex(p => p.id === photoId);
  openLightbox(allRRPhotos, idx >= 0 ? idx : 0, null, 'rrPhotos', rrMap);
}

// ─── STREET VIEW MODE ──────────────────────────────────────
let streetViewMode = false;
let streetViewPano = null;
let _workerDragging = false;
let _workerGhost = null;

function initWorkerDrag() {
  const worker = document.getElementById('sv-worker');
  if (!worker) return;

  worker.addEventListener('mousedown', (e) => {
    e.preventDefault();
    _workerDragging = true;
    worker.style.opacity = '0.4';

    // Ghost figure that follows the cursor, feet at cursor tip
    _workerGhost = document.createElement('div');
    _workerGhost.id = 'worker-ghost';
    _workerGhost.innerHTML = `<div class="worker-ghost-inner"><svg width="44" height="64" viewBox="0 0 22 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="11" cy="9" r="3.5" fill="#fde68a"/>
      <rect x="2" y="13.5" width="6" height="2.5" rx="1.25" fill="#f97316" transform="rotate(20,7.5,14.75)"/>
      <rect x="14" y="13.5" width="6" height="2.5" rx="1.25" fill="#f97316" transform="rotate(-20,14.5,14.75)"/>
      <rect x="7.5" y="13" width="7" height="7" rx="2" fill="#f97316"/>
      <rect x="7.5" y="19.5" width="3" height="7.5" rx="1.5" fill="#374151"/>
      <rect x="11.5" y="19.5" width="3" height="7.5" rx="1.5" fill="#374151"/>
    </svg></div>`;
    Object.assign(_workerGhost.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '99999',
      transform: 'translate(-50%, -100%)',
      left: e.clientX + 'px',
      top: e.clientY + 'px',
      filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.6))'
    });
    document.body.appendChild(_workerGhost);

    document.addEventListener('mousemove', _onWorkerDrag);
    document.addEventListener('mouseup', _onWorkerDrop);
  });
}

function _onWorkerDrag(e) {
  if (!_workerDragging || !_workerGhost) return;
  _workerGhost.style.left = e.clientX + 'px';
  _workerGhost.style.top = e.clientY + 'px';

  // Orange glow on map edge when hovering over it
  const mapEl = document.getElementById('map');
  const r = mapEl.getBoundingClientRect();
  const overMap = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  mapEl.style.outline = overMap ? '2px solid #f97316' : '';
}

function _onWorkerDrop(e) {
  if (!_workerDragging) return;
  _workerDragging = false;

  document.removeEventListener('mousemove', _onWorkerDrag);
  document.removeEventListener('mouseup', _onWorkerDrop);

  if (_workerGhost) { _workerGhost.remove(); _workerGhost = null; }
  const worker = document.getElementById('sv-worker');
  if (worker) worker.style.opacity = '';
  document.getElementById('map').style.outline = '';

  // Only open SV if dropped on the map
  const mapEl = document.getElementById('map');
  const r = mapEl.getBoundingClientRect();
  const overMap = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;

  if (overMap && window._workerHoverLatLng) {
    if (drawingMode) stopDrawingMode();
    streetViewMode = true;
    const workerEl = document.getElementById('sv-worker');
    if (workerEl) workerEl.classList.add('qa-active');
    openStreetViewAt(window._workerHoverLatLng.lat(), window._workerHoverLatLng.lng());
  }
}

let miniMap = null;
let miniMapMarker = null;
let miniMapLines = [];
let svPositionListener = null;
let _miniMapTimer = null;

function openStreetViewAt(lat, lng, startHeading = 0) {
  const panel = document.getElementById('streetview-panel');
  panel.classList.remove('hidden');

  if (streetViewPano) {
    // Reuse existing panorama — clean up old position listener first, then move
    if (svPositionListener) { google.maps.event.removeListener(svPositionListener); svPositionListener = null; }
    streetViewPano.setPosition({ lat, lng });
    streetViewPano.setPov({ heading: startHeading, pitch: -5 });
  } else {
    // First open — create the panorama
    if (svPositionListener) { google.maps.event.removeListener(svPositionListener); svPositionListener = null; }
    streetViewPano = new google.maps.StreetViewPanorama(
      document.getElementById('streetview-pano'), {
        position: { lat, lng },
        pov: { heading: startHeading, pitch: -5 },
        zoom: 0,
        motionTracking: false,
        motionTrackingControl: false,
        addressControl: true,
        fullscreenControl: false,
        clickToGo: true,
        linksControl: true
      }
    );
  }

  // If a street is selected, refresh the detail panel to include mini map
  if (activeStreetId) {
    window._svLastStreetId = activeStreetId;
    selectStreet(activeStreetId);
  } else {
    // No street selected — show standalone mini map panel
    showFreeMiniMap(lat, lng);
  }
}

function showFreeMiniMap(lat, lng) {
  const detailPanel = document.getElementById('detail-panel');
  const detailContent = document.getElementById('detail-content');

  detailContent.innerHTML = `
    <div class="detail-section" style="margin-top:8px">
      <h4 style="margin-bottom:8px">Your Position</h4>
      <div id="mini-map" style="width:100%;height:260px;border-radius:8px;border:1px solid var(--border);margin-bottom:6px;"></div>
      <div id="mini-map-address" class="detail-jurisdiction" style="font-size:11px;">Loading location...</div>
    </div>
    <div class="detail-section" style="color:var(--text-dim);font-size:12px;text-align:center;padding:16px 0">
      No street selected.<br>Click a street card to open its detail.
    </div>
  `;
  detailPanel.classList.remove('hidden');

  if (_miniMapTimer) clearTimeout(_miniMapTimer);
  _miniMapTimer = setTimeout(() => {
    if (svPositionListener) { google.maps.event.removeListener(svPositionListener); svPositionListener = null; }
    if (miniMapMarker) { removeFromMap(miniMapMarker); miniMapMarker = null; }
    miniMapLines.forEach(l => removeFromMap(l));
    miniMapLines = [];

    miniMap = new google.maps.Map(document.getElementById('mini-map'), {
      center: { lat, lng },
      zoom: 17,
      mapTypeId: 'roadmap',
      mapId: 'f2e86140855a96ecc6c0576f',
      colorScheme: 'DARK',
      disableDefaultUI: true,
      zoomControl: true
    });

    miniMapMarker = makeMarker({
      position: { lat, lng },
      map: miniMap,
      content: makeDotContent('#f59e0b', 20, '#fff')
    });

    // Draw all project streets as colored lines
    streets.forEach(s => {
      if (!s.path || s.path.length < 2) return;
      const line = new google.maps.Polyline({ path: s.path, strokeColor: ratingColor(s.rating), strokeOpacity: 0.9, strokeWeight: 5, map: miniMap });
      miniMapLines.push(line);
    });

    // Track position as user walks around in Street View
    let svGeoTimer = null;
    if (streetViewPano) {
      svPositionListener = streetViewPano.addListener('position_changed', () => {
        const pos = streetViewPano.getPosition();
        if (miniMapMarker) { miniMapMarker.position = { lat: pos.lat(), lng: pos.lng() }; miniMap.setCenter(pos); }

        clearTimeout(svGeoTimer);
        svGeoTimer = setTimeout(() => {
          const geocoder = new google.maps.Geocoder();
          geocoder.geocode({ location: { lat: pos.lat(), lng: pos.lng() } }, (results, status) => {
            const el = document.getElementById('mini-map-address');
            if (el && status === 'OK' && results.length > 0) el.textContent = results[0].formatted_address;
          });
        }, 2000);
      });
    }
  }, 50);
}

// ─── STREET VIEW SNAP ──────────────────────────────────────
let _snapData = null; // { dataUrl, lat, lng, heading }

let _snapIsRR = false;

async function snapStreetView(isRR = false) {
  if (!streetViewPano) return;
  const pos = streetViewPano.getPosition();
  const pov = streetViewPano.getPov();
  const lat = pos.lat(), lng = pos.lng();
  const heading = Math.round(pov.heading || 0);
  const pitch = Math.round(pov.pitch || -5);

  showToast('Fetching snap...');
  const url = `${SV_BASE}?size=640x400&location=${lat},${lng}&heading=${heading}&pitch=${pitch}&fov=80&key=${API_KEY}`;
  const dataUrl = await imageUrlToBase64(url);
  if (!dataUrl) { showToast('Could not fetch Street View image'); return; }

  _snapIsRR = isRR;
  _snapData = { dataUrl, lat, lng, heading };
  document.getElementById('snap-preview').src = dataUrl;
  document.getElementById('snap-rating').value = '';
  document.getElementById('snap-note').value = '';
  document.getElementById('snap-modal-title').textContent = isRR ? 'Snap R&R Photo' : 'Snap Photo';
  document.getElementById('snap-save-btn').textContent = isRR ? 'Save as R&R' : 'Save to Street';
  document.getElementById('snap-save-btn').style.background = isRR ? '#ef4444' : '';
  document.getElementById('snap-overlay').classList.remove('hidden');
}

function closeSnapModal(e) {
  if (e && e.target !== document.getElementById('snap-overlay')) return;
  document.getElementById('snap-overlay').classList.add('hidden');
  _snapData = null;
  _snapIsRR = false;
}

function saveSnap() {
  if (!_snapData || !activeStreetId) return;
  const street = streets.find(s => s.id === activeStreetId);
  if (!street) return;

  const rating = document.getElementById('snap-rating').value;
  const note = document.getElementById('snap-note').value.trim();

  const photo = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    dataUrl: _snapData.dataUrl,
    lat: _snapData.lat,
    lng: _snapData.lng,
    address: '',
    note: note || '',
    rating: rating || null,
    source: 'streetview',
    takenAt: new Date().toISOString()
  };

  if (_snapIsRR) {
    // Save as R&R photo — red pin
    if (!street.rrPhotos) street.rrPhotos = [];
    street.rrPhotos.push(photo);
  } else {
    // Save as regular on-site photo — purple pin
    if (!street.photos) street.photos = [];
    street.photos.push(photo);

    // If a rating was set, factor it into the street rating
    if (rating) {
      const manualRatings = street.photos.filter(p => p.rating);
      const counts = {};
      manualRatings.forEach(p => { counts[p.rating] = (counts[p.rating] || 0) + 1; });
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (best) { street.rating = best[0]; }
    }
  }

  saveStreets();
  placePhotoMarkers();
  placeAllMarkers();
  selectStreet(activeStreetId);
  document.getElementById('snap-overlay').classList.add('hidden');
  _snapData = null;
  const _wasRR = _snapIsRR;
  _snapIsRR = false;
  showToast(_wasRR ? 'R&R photo saved' : 'Photo saved to street');
}

function closeStreetViewPanel() {
  clearRetakeMode();
  if (_miniMapTimer) { clearTimeout(_miniMapTimer); _miniMapTimer = null; }
  if (_animInterval) { clearInterval(_animInterval); _animInterval = null; }
  document.getElementById('streetview-panel').classList.add('hidden');
  document.getElementById('detail-panel').classList.add('hidden');
  if (svPositionListener) { google.maps.event.removeListener(svPositionListener); svPositionListener = null; }
  streetViewPano = null;
  window._svLastStreetId = null;
  if (miniMapMarker) { removeFromMap(miniMapMarker); miniMapMarker = null; }
  miniMap = null;
  miniMapLines.forEach(l => removeFromMap(l));
  miniMapLines = [];
  streetViewMode = false;
  const workerEl = document.getElementById('sv-worker');
  if (workerEl) workerEl.classList.remove('qa-active');
  renderStreetList(); // show all streets again
  updateStats(); // restore project-wide stats
}

// ─── FREE HIGHLIGHT (continuous multi-point drawing) ───────
let drawingMode = false;
let drawCount = 0;

function setMapCursor(cursorClass) {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  mapEl.classList.remove('cursor-pin-start', 'cursor-pin-end');
  if (cursorClass) mapEl.classList.add(cursorClass);
  // Force cursor onto Google Maps' internal canvas and div layers
  const cursors = { 'cursor-pin-start': mapEl.style.getPropertyValue('--pin-start-cur') || 'crosshair', 'cursor-pin-end': 'crosshair' };
  const svgGreen = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='6' stroke='%2322c55e' stroke-width='1.5' fill='none'/%3E%3Cline x1='10' y1='1' x2='10' y2='5' stroke='%2322c55e' stroke-width='1.5'/%3E%3Cline x1='10' y1='15' x2='10' y2='19' stroke='%2322c55e' stroke-width='1.5'/%3E%3Cline x1='1' y1='10' x2='5' y2='10' stroke='%2322c55e' stroke-width='1.5'/%3E%3Cline x1='15' y1='10' x2='19' y2='10' stroke='%2322c55e' stroke-width='1.5'/%3E%3C/svg%3E") 10 10, crosshair`;
  const svgRed = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='6' stroke='%23ef4444' stroke-width='1.5' fill='none'/%3E%3Cline x1='10' y1='1' x2='10' y2='5' stroke='%23ef4444' stroke-width='1.5'/%3E%3Cline x1='10' y1='15' x2='10' y2='19' stroke='%23ef4444' stroke-width='1.5'/%3E%3Cline x1='1' y1='10' x2='5' y2='10' stroke='%23ef4444' stroke-width='1.5'/%3E%3Cline x1='15' y1='10' x2='19' y2='10' stroke='%23ef4444' stroke-width='1.5'/%3E%3C/svg%3E") 10 10, crosshair`;
  const cur = cursorClass === 'cursor-pin-start' ? svgGreen : cursorClass === 'cursor-pin-end' ? svgRed : '';
  mapEl.querySelectorAll('canvas, div[draggable], div[style]').forEach(el => { el.style.cursor = cur; });
  mapEl.style.cursor = cur;
}

function startFreeHighlight() {
  if (drawingMode) { stopDrawingMode(); return; }
  if (streetViewMode) closeStreetViewPanel(); // turn off street view
  drawingMode = true;
  highlightMode = 'drawing';
  tempPath = [];
  clearTempMarkers();
  clearTempPolyline();
  window._drawStart = null;
  document.getElementById('highlight-bar').classList.remove('hidden');
  document.getElementById('highlight-bar-text').textContent = 'Click the START of a street';
  document.getElementById('detail-panel').classList.add('hidden');
  document.querySelector('.qa-highlight').classList.add('qa-active');
  setMapCursor('cursor-pin-start');
}

function cancelHighlight() {
  stopDrawingMode();
}

function stopDrawingMode() {
  drawingMode = false;
  highlightMode = null;
  highlightStreetId = null;
  tempPath = [];
  window._drawStart = null;
  clearTempMarkers();
  clearTempPolyline();
  document.getElementById('highlight-bar').classList.add('hidden');
  document.querySelector('.qa-highlight').classList.remove('qa-active');
  drawCount = 0;
  const pinLabel = document.getElementById('btn-pin-label');
  if (pinLabel) pinLabel.textContent = 'Pin.Start';
  setMapCursor(null);
}

function clearTempPolyline() {
  if (tempPolyline) { tempPolyline.setMap(null); tempPolyline = null; }
}

// ─── FREE PHOTO (from sidebar, assigns to nearest street or creates one) ──
function startFreePhoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    showToast('Processing photo...');
    const dataUrl = await compressPhoto(file, 800, 0.7);
    const photoLocation = await getPhotoGPS();

    const lat = photoLocation?.lat || map.getCenter().lat();
    const lng = photoLocation?.lng || map.getCenter().lng();

    // Find nearest street or create one
    let street = findNearestStreet(lat, lng);
    if (!street) {
      // Auto-create a street from GPS location
      let address = 'Unknown location';
      try {
        const geocoder = new google.maps.Geocoder();
        const result = await new Promise((resolve) => {
          geocoder.geocode({ location: { lat, lng } }, (results, status) => {
            resolve(status === 'OK' && results.length > 0 ? results[0].formatted_address : '');
          });
        });
        if (result) address = result;
      } catch (e) { /* skip */ }

      street = {
        id: crypto.randomUUID?.() || Date.now().toString(36),
        name: address,
        lat: lat,
        lng: lng,
        length: 0,
        width: 24,
        sqft: 0,
        roadType: 'Residential',
        rating: 'pending',
        notes: 'Auto-created from photo',
        analysis: '',
        adminNotes: '',
        weedAlert: false,
        weedNotes: '',
        ravelingAlert: false,
        ravelingNotes: '',
        rrAlert: false,
        rrNotes: '',
        svImage: getStreetViewUrl(lat, lng),
        photos: [],
        rrPhotos: [],
        scanPhotos: [],
        scannedAt: null,
        createdAt: new Date().toISOString()
      };
      streets.push(street);
    }

    if (!street.photos) street.photos = [];
    street.photos.push({
      id: crypto.randomUUID?.() || Date.now().toString(36),
      dataUrl: dataUrl,
      lat: lat,
      lng: lng,
      address: street.name,
      note: '',
      takenAt: new Date().toISOString()
    });

    saveStreets();
    renderStreetList();
    placeAllMarkers();
    placePhotoMarkers();
    updateStats();
    selectStreet(street.id);
    showToast('Photo added with GPS location');
  };
  input.click();
}

function findNearestStreet(lat, lng) {
  if (streets.length === 0) return null;
  let nearest = null;
  let minDist = Infinity;
  streets.forEach(s => {
    const dist = calcDistanceFt({ lat, lng }, { lat: s.lat, lng: s.lng });
    if (dist < minDist) { minDist = dist; nearest = s; }
  });
  // Only match if within 500 feet
  return minDist < 500 ? nearest : null;
}


function handleMapClick(latLng) {
  if (highlightMode !== 'drawing') return;

  if (!window._drawStart) {
    // Click 1 = START of street
    window._drawStart = { lat: latLng.lat(), lng: latLng.lng() };
    clearTempMarkers();
    clearTempPolyline();
    addTempMarker(latLng, 'S', '#22c55e');
    document.getElementById('highlight-bar-text').textContent = 'Now click the END of this street';
    const pinLabel = document.getElementById('btn-pin-label');
    if (pinLabel) pinLabel.textContent = 'Pin.End';
    setMapCursor('cursor-pin-end');
  } else {
    // Click 2 = END of street → auto-save
    const startPt = window._drawStart;
    const endPt = { lat: latLng.lat(), lng: latLng.lng() };
    addTempMarker(latLng, 'E', '#ef4444');

    // Draw preview line
    tempPolyline = new google.maps.Polyline({
      path: [startPt, endPt],
      strokeColor: '#3b82f6',
      strokeOpacity: 0.8,
      strokeWeight: 5,
      map: map
    });

    // Save street
    saveHighlightedStreet(startPt, endPt);
  }
}

async function saveHighlightedStreet(startPt, endPt) {
  showScanModal('Saving street...');
  // Get actual road path from Directions API
  let roadPath = [startPt, endPt];
  let roadLengthFt = Math.round(calcDistanceFt(startPt, endPt));

  try {
    const directions = new google.maps.DirectionsService();
    const result = await new Promise((resolve, reject) => {
      directions.route({
        origin: new google.maps.LatLng(startPt.lat, startPt.lng),
        destination: new google.maps.LatLng(endPt.lat, endPt.lng),
        travelMode: google.maps.TravelMode.DRIVING
      }, (res, status) => {
        if (status === 'OK') resolve(res);
        else reject(status);
      });
    });

    // Extract the road geometry points + street name from the dominant step
    const leg = result.routes[0].legs[0];
    roadLengthFt = Math.round(leg.distance.value * 3.28084); // meters to feet
    roadPath = [];
    // Find the step covering the most distance — that's the main street
    let dominantStep = leg.steps[0];
    leg.steps.forEach(step => {
      step.path.forEach(p => roadPath.push({ lat: p.lat(), lng: p.lng() }));
      if (step.distance.value > (dominantStep?.distance?.value || 0)) dominantStep = step;
    });
    // Extract street name from the dominant step's HTML instructions e.g. "Head <b>north</b> on <b>W Judith Ln</b>"
    // Skip pure direction words — grab the last bold segment that isn't a cardinal direction
    if (dominantStep?.instructions) {
      const DIRECTIONS = new Set(['north','south','east','west','northeast','northwest','southeast','southwest']);
      const matches = [...dominantStep.instructions.matchAll(/<b>([^<]+)<\/b>/gi)];
      const name = matches.map(m => m[1].trim()).filter(t => !DIRECTIONS.has(t.toLowerCase())).pop();
      if (name) window._directionsStreetName = name;
    }
  } catch (e) {
    console.warn('Directions API fallback to straight line:', e);
  }

  const midIdx = Math.floor(roadPath.length / 2);
  const midPt = roadPath[midIdx] || startPt;

  const [startGeo, endGeo, midGeo, roadInfo] = await Promise.all([
    geocodeDetails(startPt),
    geocodeDetails(endPt),
    geocodeDetails(midPt),
    detectRoadType(midPt.lat, midPt.lng)
  ]);

  const width = roadInfo.width;

  const street = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    name: midGeo.route || startGeo.route || endGeo.route || 'Unknown location',
    lat: startPt.lat,
    lng: startPt.lng,
    length: roadLengthFt,
    width: width,
    sqft: roadLengthFt * width,
    roadType: roadInfo.label,
    rating: 'pending',
    notes: '',
    analysis: '',
    svImage: getStreetViewUrl(startPt.lat, startPt.lng),
    path: roadPath,
    city: startGeo.city,
    county: startGeo.county,
    state: startGeo.state,
    endCity: endGeo.city,
    endCounty: endGeo.county,
    crossesBoundary: (startGeo.city && endGeo.city && startGeo.city !== endGeo.city) || (startGeo.county && endGeo.county && startGeo.county !== endGeo.county),
    boundaryNote: '',
    adminNotes: '',
    weedAlert: false,
    weedNotes: '',
    ravelingAlert: false,
    ravelingNotes: '',
    rrAlert: false,
    rrNotes: '',
    photos: [],
    rrPhotos: [],
    scanPhotos: [],
    scannedAt: null,
    createdAt: new Date().toISOString()
  };

  if (startGeo.city && endGeo.city && startGeo.city !== endGeo.city) {
    street.boundaryNote = `Crosses city line: ${startGeo.city} → ${endGeo.city}`;
  } else if (startGeo.county && endGeo.county && startGeo.county !== endGeo.county) {
    street.boundaryNote = `Crosses county line: ${startGeo.county} → ${endGeo.county}`;
  }

  // Find exact boundary crossing point via binary search
  if (street.crossesBoundary && roadPath.length >= 2) {
    street.boundaryPoint = roadPath[Math.floor(roadPath.length / 2)]; // temp estimate
    findExactBoundaryPoint(street).then(exact => {
      if (exact) {
        street.boundaryPoint = exact;
        street.boundaryPointExact = true;
        saveStreets();
        drawAllHighlights();
      }
    }).catch(() => {});
  }

  hideScanModal();

  // Show name confirmation prompt before saving
  window._pendingStreet = { street, roadLengthFt };
  const input = document.getElementById('name-prompt-input');
  const overlay = document.getElementById('name-prompt-overlay');
  if (input) input.value = street.name;
  if (overlay) overlay.classList.remove('hidden');
  setTimeout(() => { if (input) input.select(); }, 50);

  if (street.crossesBoundary) {
    setTimeout(() => showToast(`⚠ ${street.boundaryNote}`, 5000), 1500);
  }
}

function addTempMarker(latLng, label, color) {
  const el = document.createElement('div');
  el.style.cssText = `width:24px;height:24px;background:${color};border:2px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;cursor:pointer;`;
  el.textContent = label;
  const marker = makeMarker({ position: latLng, map: map, content: el });
  highlightMarkers.push(marker);
}

function clearTempMarkers() {
  highlightMarkers.forEach(m => removeFromMap(m));
  highlightMarkers = [];
}

function drawAllHighlights() {
  if (_animInterval) { clearInterval(_animInterval); _animInterval = null; }
  polylines.forEach(p => removeFromMap(p));
  polylines = [];

  // Collect all endpoints for snapping
  const SNAP_THRESHOLD = 0.00015; // ~50 ft
  const allPaths = [];

  streets.forEach(street => {
    let pathPoints = street.path;
    if (!pathPoints && street.highlightStart && street.highlightEnd) {
      pathPoints = [street.highlightStart, street.highlightEnd];
    }
    if (!pathPoints || pathPoints.length < 2) return;
    // Deep copy so we don't mutate stored data
    allPaths.push({ street, points: pathPoints.map(p => ({ lat: p.lat, lng: p.lng })) });
  });

  // Snap nearby endpoints together so lines connect cleanly
  for (let i = 0; i < allPaths.length; i++) {
    for (let j = i + 1; j < allPaths.length; j++) {
      const a = allPaths[i].points;
      const b = allPaths[j].points;
      // Check all 4 endpoint pairs (start-start, start-end, end-start, end-end)
      const pairs = [
        [0, 0], [0, b.length - 1], [a.length - 1, 0], [a.length - 1, b.length - 1]
      ];
      for (const [ai, bi] of pairs) {
        const dist = Math.sqrt(Math.pow(a[ai].lat - b[bi].lat, 2) + Math.pow(a[ai].lng - b[bi].lng, 2));
        if (dist < SNAP_THRESHOLD && dist > 0) {
          // Snap to midpoint
          const mid = { lat: (a[ai].lat + b[bi].lat) / 2, lng: (a[ai].lng + b[bi].lng) / 2 };
          a[ai] = mid;
          b[bi] = mid;
        }
      }
    }
  }

  // Draw lines
  allPaths.forEach(({ street, points }) => {
    const color = ratingColor(street.rating);
    const isActive = street.id === activeStreetId;

    // Glow outline (non-active: subtle; active: handled separately below)
    if (!isActive) {
      const glow = new google.maps.Polyline({
        path: points,
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.08,
        strokeWeight: 12,
        map: map
      });
      glow.addListener('click', () => selectStreet(street.id));
      polylines.push(glow);
    }

    // Main line
    const line = new google.maps.Polyline({
      path: points,
      geodesic: true,
      strokeColor: color,
      strokeOpacity: isActive ? 0.35 : 0.32,
      strokeWeight: isActive ? 6 : 5,
      map: map,
      zIndex: isActive ? 20 : 5
    });
    line.addListener('click', () => selectStreet(street.id));
    polylines.push(line);

    // Order number label on map
    if (street.order != null && points.length >= 2) {
      const midIdx = Math.floor(points.length / 2);
      const midPt = points[midIdx];
      const orderEl = document.createElement('div');
      orderEl.style.cssText = 'display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#f59e0b;color:#000;font-size:10px;font-weight:800;box-shadow:0 1px 4px rgba(0,0,0,0.6);cursor:pointer;';
      orderEl.textContent = street.order;
      const orderMarker = makeMarker({ position: { lat: midPt.lat, lng: midPt.lng }, map, content: orderEl, zIndex: 20, title: `Stop #${street.order}: ${street.name}` });
      orderMarker.addEventListener('gmp-click', () => selectStreet(street.id));
      polylines.push(orderMarker);
    }

    // Boundary crossing marker + city labels on each side
    if (street.crossesBoundary && street.boundaryPoint) {
      const path = street.path;
      const startCity = street.city || 'Start';
      const endCity   = street.endCity || 'End';

      // Dashed perpendicular line across the street at boundary point
      const streetHeading = calcHeading(path[0], path[path.length - 1]);
      const perpHeading   = (streetHeading + 90) % 360;
      const lineA = offsetPoint(street.boundaryPoint.lat, street.boundaryPoint.lng, perpHeading, 200);
      const lineB = offsetPoint(street.boundaryPoint.lat, street.boundaryPoint.lng, (perpHeading + 180) % 360, 200);
      const boundaryLine = new google.maps.Polyline({
        path: [lineA, lineB],
        geodesic: true,
        strokeColor: '#f97316',
        strokeOpacity: 0,
        strokeWeight: 3,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeWeight: 3, scale: 6 }, offset: '0', repeat: '20px' }],
        map: map,
        zIndex: 11
      });
      boundaryLine.addListener('click', () => selectStreet(street.id));
      polylines.push(boundaryLine);

      // Find boundary fraction along path then place labels on each side
      let boundaryT = 0.5;
      let minDist = Infinity;
      path.forEach((pt, idx) => {
        const d = Math.sqrt(Math.pow(pt.lat - street.boundaryPoint.lat, 2) + Math.pow(pt.lng - street.boundaryPoint.lng, 2));
        if (d < minDist) { minDist = d; boundaryT = idx / (path.length - 1); }
      });

      const startLabelMid = getPathPointAt(path, boundaryT / 2);
      const endLabelMid   = getPathPointAt(path, boundaryT + (1 - boundaryT) / 2);
      const perpUp = (streetHeading + 270) % 360;
      const startLabelPos = offsetPoint(startLabelMid.lat, startLabelMid.lng, perpUp, 120);
      const endLabelPos   = offsetPoint(endLabelMid.lat,   endLabelMid.lng,   perpUp, 120);

      const startEl = document.createElement('div');
      startEl.style.cssText = 'color:#f97316;font-size:11px;font-weight:bold;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.8);cursor:pointer;';
      startEl.textContent = startCity;
      const startLabel = makeMarker({ position: startLabelPos, map: map, title: startCity, content: startEl, zIndex: 9 });
      startLabel.addEventListener('gmp-click', () => selectStreet(street.id));
      polylines.push(startLabel);

      const endEl = document.createElement('div');
      endEl.style.cssText = 'color:#f97316;font-size:11px;font-weight:bold;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.8);cursor:pointer;';
      endEl.textContent = endCity;
      const endLabel = makeMarker({ position: endLabelPos, map: map, title: endCity, content: endEl, zIndex: 9 });
      endLabel.addEventListener('gmp-click', () => selectStreet(street.id));
      polylines.push(endLabel);
    }
  });

  // Pulsing glow on the selected street
  if (activeStreetId) {
    const active = streets.find(s => s.id === activeStreetId);
    if (active?.path?.length > 1) {
      const color = ratingColor(active.rating);

      // Outer wide glow — rating color
      const outerGlow = new google.maps.Polyline({
        path: active.path,
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.1,
        strokeWeight: 20,
        map: map,
        zIndex: 17
      });
      outerGlow.addListener('click', () => selectStreet(active.id));
      polylines.push(outerGlow);

      // Inner glow — white
      const innerGlow = new google.maps.Polyline({
        path: active.path,
        geodesic: true,
        strokeColor: '#ffffff',
        strokeOpacity: 0.15,
        strokeWeight: 12,
        map: map,
        zIndex: 18
      });
      innerGlow.addListener('click', () => selectStreet(active.id));
      polylines.push(innerGlow);

      // Animate both layers with a sine wave
      let _pulseT = 0;
      _animInterval = setInterval(() => {
        _pulseT += 0.0225;
        const pulse = (Math.sin(_pulseT) + 1) / 2; // smooth 0 → 1
        outerGlow.setOptions({ strokeOpacity: 0.08 + pulse * 0.52 });
        innerGlow.setOptions({ strokeOpacity: 0.1  + pulse * 0.5  });
      }, 16);
    }
  }
}

let _snapping = false;
async function snapToRoad(id) {
  if (_snapping) return;
  const street = streets.find(s => s.id === id);
  if (!street) return;

  const path = street.path;
  if (!path || path.length < 2) { showToast('No highlight to snap'); return; }

  const startPt = path[0];
  const endPt = path[path.length - 1];

  _snapping = true;
  showToast('Snapping to road...');

  try {
    const directions = new google.maps.DirectionsService();
    const result = await new Promise((resolve, reject) => {
      directions.route({
        origin: new google.maps.LatLng(startPt.lat, startPt.lng),
        destination: new google.maps.LatLng(endPt.lat, endPt.lng),
        travelMode: google.maps.TravelMode.DRIVING
      }, (res, status) => {
        if (status === 'OK') resolve(res);
        else reject(status);
      });
    });

    const leg = result.routes[0].legs[0];
    const roadPath = [];
    leg.steps.forEach(step => {
      step.path.forEach(p => roadPath.push({ lat: p.lat(), lng: p.lng() }));
    });

    street.path = roadPath;
    street.length = Math.round(leg.distance.value * 3.28084);
    street.sqft = street.length * (street.width || 32);
    saveStreets();
    drawAllHighlights();
    placeAllMarkers();
    updateStats();
    selectStreet(id);
    showToast('Snapped to road');
  } catch (e) {
    console.error('Snap to road error:', e);
    showToast('Could not snap — road not found between endpoints');
  } finally {
    _snapping = false;
  }
}

function removeHighlight(id) {
  const street = streets.find(s => s.id === id);
  if (!street) return;
  delete street.path;
  delete street.highlightStart;
  delete street.highlightEnd;
  saveStreets();
  placeAllMarkers();
  drawAllHighlights();
  selectStreet(id);
  showToast('Highlight removed');
}

function calcDistanceFt(p1, p2) {
  // Haversine formula — returns distance in feet
  const R = 20902231; // Earth radius in feet
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── PROJECT REPORT ────────────────────────────────────────
let _reportGenerating = false;
async function generateProjectReport() {
  if (_reportGenerating) return;
  if (streets.length === 0) {
    showToast('Add some streets first');
    return;
  }
  _reportGenerating = true;

  // Show modal with loading
  document.getElementById('report-overlay').classList.remove('hidden');
  document.getElementById('report-overlay').style.display = 'flex';
  document.getElementById('report-title').textContent = `${activeProject.name} — Report`;
  document.getElementById('report-content').innerHTML = '<div class="scan-spinner" style="margin:20px auto;"></div><p style="text-align:center;color:var(--text-dim);">AI is analyzing the full project...</p>';

  // Build stats
  const totalStreets = streets.length;
  const totalSqft = streets.reduce((s, st) => s + (st.sqft || 0), 0);
  const totalLength = streets.reduce((s, st) => s + (st.length || 0), 0);
  const ratingCounts = { 'level-1': 0, 'level-2': 0, 'level-3': 0, 'level-4': 0, 'pending': 0 };
  streets.forEach(s => {
    let r = s.rating || 'pending';
    if (r === 'good') r = 'level-1';
    if (r === 'fair') r = 'level-2';
    if (r === 'poor') r = 'level-3';
    if (r === 'critical') r = 'level-4';
    ratingCounts[r] = (ratingCounts[r] || 0) + 1;
  });
  const totalSY = Math.round(totalSqft / 9);
  const cities = [...new Set(streets.map(s => s.city).filter(Boolean))];
  const boundaryStreets = streets.filter(s => s.crossesBoundary);
  const weedStreets = streets.filter(s => s.weedAlert);
  const ravelingStreets = streets.filter(s => s.ravelingAlert);
  const rrStreets = streets.filter(s => s.rrAlert);
  const projectTypeLabel = activeProject.type === 'slurry' ? 'Slurry Seal' : activeProject.type === 'both' ? 'Crack Seal + Slurry Seal' : 'Crack Seal';

  // Treatment breakdown — only rated streets (skip pending)
  const treatmentCounts = {};
  streets.filter(s => s.rating && s.rating !== 'pending').forEach(s => {
    const t = getTreatment(s.rating, activeProject.type).label;
    treatmentCounts[t] = (treatmentCounts[t] || 0) + 1;
  });

  // Build street summary for AI
  const streetSummary = streets.map(s =>
    `- ${s.name}: ${formatNumber(s.length || 0)} ft, ${formatNumber(s.sqft || 0)} sq ft, Rating: ${s.rating}, City: ${s.city || 'Unknown'}${s.weedAlert ? ', ⚠ WEED CONTROL NEEDED' : ''}${s.ravelingAlert ? ', ⚠ RAVELING DETECTED' : ''}${s.rrAlert ? ', 🔴 REMOVE & REPLACE NEEDED' : ''}${s.adminNotes ? ', Admin notes: ' + s.adminNotes : ''}`
  ).join('\n');

  // Get AI project summary
  let aiSummary = '';
  if (AI_PROXY) {
    try {
      const reportModel = activeProject?.scanModel || 'gpt-4o';
      const res = await fetch(AI_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          model: reportModel,
          provider: getProviderForModel(reportModel),
          messages: [
            {
              role: 'system',
              content: `You are a pavement assessment expert writing a project summary for a pavement contractor. Be concise and professional. The project type is: ${projectTypeLabel}. Include: overall project condition, priority streets that need immediate attention, treatment recommendations based on the project type, any concerns about boundary crossings, and if any streets have weed/grass control alerts, note which streets may need vegetation removal before work begins. Format with bullet points.`
            },
            {
              role: 'user',
              content: `Project: ${activeProject.name}\nProject type: ${projectTypeLabel}\nTotal streets: ${totalStreets}\nTotal sq ft: ${formatNumber(totalSqft)}\nTotal sq yards: ${formatNumber(totalSY)}\nTotal linear ft: ${formatNumber(totalLength)}\nCities: ${cities.join(', ') || 'Unknown'}\nBoundary crossings: ${boundaryStreets.length}\nStreets needing weed control: ${weedStreets.length}\n\nStreet breakdown:\n${streetSummary}\n\nProvide a project summary with overall condition assessment, priority recommendations, treatment scope notes, and weed control recommendations if applicable.`
            }
          ],
          max_tokens: 600
        })
      });
      if (!res.ok) throw new Error(`AI proxy ${res.status}`);
      const data = await res.json();
      aiSummary = data.choices?.[0]?.message?.content || 'AI analysis unavailable';
    } catch (e) {
      aiSummary = 'AI analysis unavailable — check connection';
    }
  } else {
    aiSummary = 'Connect AI proxy for project analysis';
  }

  // Build report HTML
  document.getElementById('report-content').innerHTML = `
    <div style="margin-bottom:10px;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em">Project Type: <span style="color:var(--accent);font-weight:700">${projectTypeLabel}</span></div>

    <div class="report-stats-grid">
      <div class="report-section">
        <div class="report-label">Streets</div>
        <div class="report-value">${totalStreets}</div>
      </div>
      <div class="report-section">
        <div class="report-label">Total Sq Ft</div>
        <div class="report-value">${formatNumber(totalSqft)}</div>
      </div>
      <div class="report-section">
        <div class="report-label">Total Sq Yards</div>
        <div class="report-value">${formatNumber(totalSY)}</div>
      </div>
      <div class="report-section">
        <div class="report-label">Linear Ft</div>
        <div class="report-value">${formatNumber(totalLength)}</div>
      </div>
    </div>

    <div class="report-stats-grid" style="grid-template-columns:1fr 1fr 1fr 1fr">
      <div class="report-section">
        <div class="report-label">LVL 1</div>
        <div class="report-value" style="color:#22c55e">${ratingCounts['level-1']}</div>
        <div style="font-size:9px;color:var(--text-dim)">Little cracks</div>
      </div>
      <div class="report-section">
        <div class="report-label">LVL 2</div>
        <div class="report-value" style="color:#eab308">${ratingCounts['level-2']}</div>
        <div style="font-size:9px;color:var(--text-dim)">Light cracks</div>
      </div>
      <div class="report-section">
        <div class="report-label">LVL 3</div>
        <div class="report-value" style="color:#f97316">${ratingCounts['level-3']}</div>
        <div style="font-size:9px;color:var(--text-dim)">Deep + alligator</div>
      </div>
      <div class="report-section">
        <div class="report-label">LVL 4</div>
        <div class="report-value" style="color:#ef4444">${ratingCounts['level-4']}</div>
        <div style="font-size:9px;color:var(--text-dim)">Severe</div>
      </div>
    </div>

    <div class="report-section">
      <div class="report-label">Treatment Breakdown</div>
      <div class="report-treatment-grid">
        ${Object.entries(treatmentCounts).map(([label, count]) => {
          const color = streets.find(s => getTreatment(s.rating, activeProject.type).label === label)
            ? getTreatment(streets.find(s => getTreatment(s.rating, activeProject.type).label === label).rating, activeProject.type).color
            : '#94a3b8';
          return `<div class="report-treatment-row"><span style="color:${color};font-weight:600">${label}</span><span class="report-treatment-count">${count} street${count !== 1 ? 's' : ''}</span></div>`;
        }).join('')}
      </div>
    </div>

    ${cities.length > 0 ? `<div class="report-section"><div class="report-label">Jurisdictions</div><div>${cities.join(', ')}</div></div>` : ''}

    ${boundaryStreets.length > 0 ? `<div class="report-section" style="border-color:rgba(249,115,22,0.3)"><div class="report-label" style="color:var(--orange)">⚠ Boundary Crossings (${boundaryStreets.length})</div><div style="font-size:12px">${boundaryStreets.map(s => escHtml(s.boundaryNote)).join('<br>')}</div></div>` : ''}

    ${weedStreets.length > 0 ? `<div class="report-section" style="border-color:rgba(34,197,94,0.3)"><div class="report-label" style="color:#22c55e">🌿 Weed/Grass Control (${weedStreets.length} street${weedStreets.length > 1 ? 's' : ''})</div><div style="font-size:12px">${weedStreets.map(s => escHtml(s.name?.split(',')[0] || 'Unknown')).join('<br>')}</div></div>` : ''}

    ${ravelingStreets.length > 0 ? `<div class="report-section" style="border-color:rgba(245,158,11,0.3)"><div class="report-label" style="color:#f59e0b">⚠ Raveling Detected (${ravelingStreets.length} street${ravelingStreets.length > 1 ? 's' : ''})</div><div style="font-size:12px">${ravelingStreets.map(s => escHtml(s.name?.split(',')[0] || 'Unknown')).join('<br>')}</div></div>` : ''}

    ${rrStreets.length > 0 ? `<div class="report-section" style="border-color:rgba(239,68,68,0.4)"><div class="report-label" style="color:#ef4444">🔴 Remove &amp; Replace Needed (${rrStreets.length} street${rrStreets.length > 1 ? 's' : ''})</div><div style="font-size:12px">${rrStreets.map(s => escHtml(s.name?.split(',')[0] || 'Unknown')).join('<br>')}</div></div>` : ''}

    <div class="report-section">
      <div class="report-label">Street Breakdown</div>
      ${streets.map(s => `
        <div class="report-street-row">
          <span>${escHtml(s.name?.split(',')[0] || 'Unknown')}${s.weedAlert ? ' 🌿' : ''}${s.ravelingAlert ? ' ⚠' : ''}${s.rrAlert ? ' 🔴' : ''}</span>
          <span>${formatNumber(s.sqft || 0)} sq ft · ${formatNumber(Math.round((s.sqft || 0) / 9))} SY</span>
          <span class="rating-badge rating-${s.rating}" title="${ratingDescription(s.rating)}">${ratingLabel(s.rating)}</span>
        </div>
        ${s.rating && s.rating !== 'pending' ? `<div style="font-size:11px;color:${getTreatment(s.rating, activeProject.type).color};padding:0 0 4px 4px">${getTreatment(s.rating, activeProject.type).label}</div>` : ''}
        ${s.rrPhotos && s.rrPhotos.length > 0 ? `<div style="font-size:11px;color:#ef4444;padding:0 0 4px 4px">📷 ${s.rrPhotos.length} R&amp;R field photo${s.rrPhotos.length > 1 ? 's' : ''}</div>` : ''}
        ${s.adminNotes ? `<div class="report-admin-note">📝 ${escHtml(s.adminNotes)}</div>` : ''}
      `).join('')}
    </div>

    <div class="report-section">
      <div class="report-label">AI Project Summary</div>
      <div class="report-ai">${escHtml(aiSummary)}</div>
    </div>
  `;
  _reportGenerating = false;
}

function closeReport(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('report-overlay').classList.add('hidden');
  document.getElementById('report-overlay').style.display = 'none';
}

// ─── GET MAP KEY (from script tag) ─────────────────────────
function getMapKey() {
  const script = document.querySelector('script[src*="maps.googleapis.com"]');
  if (!script) return '';
  const match = script.src.match(/key=([^&]+)/);
  return match ? match[1] : '';
}

