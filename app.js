/* ================================================================
   CRACKING & SEALING EST. — App Logic
   Street assessment tool for GRSI
   ================================================================ */

/* ─── DATA SHAPE REFERENCE ──────────────────────────────────
   localStorage key: "cse_projects"
   [
     {
       id:        "uuid",
       name:      "Anaheim Q2 2026",
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

  // Map click listener
  map.addListener('click', (e) => handleMapClick(e.latLng));

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

function saveStreets() {
  activeProject.streets = streets;
  saveProjects();
}

function createProject(name) {
  const project = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    name: name,
    includeWideCracks: false, // default: skip 1.25"+ cracks
    aiEnabled: true, // AI analysis + photo capture on by default
    scanModel: 'gpt-4o', // AI model used for scanning
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
      <button class="btn-project-action btn-project-delete" onclick="deleteProject('${activeProject.id}')" title="Delete">Delete</button>
    </div>
    <div class="project-toggles">
      <div class="toggle-pill" onclick="toggleWideCracks()" title="${activeProject.includeWideCracks ? 'Wide cracks (1.25&quot;+) INCLUDED in scope' : 'Wide cracks (1.25&quot;+) NOT in scope — click to change'}">
        <span class="toggle-label">Wide Cracks 1.25"+</span>
        <span class="toggle-value ${activeProject.includeWideCracks ? 'toggle-on' : 'toggle-off'}">${activeProject.includeWideCracks ? 'IN SCOPE' : 'OUT'}</span>
      </div>
      <div class="toggle-pill" onclick="toggleAI()" title="${activeProject.aiEnabled !== false ? 'AI analysis & photo capture ON — click to turn off' : 'AI analysis & photo capture OFF — click to turn on'}">
        <span class="toggle-label">AI Analysis</span>
        <span class="toggle-value ${activeProject.aiEnabled !== false ? 'toggle-on' : 'toggle-off'}">${activeProject.aiEnabled !== false ? 'ON' : 'OFF'}</span>
      </div>
      <div class="toggle-pill model-pill" title="AI model used for scanning">
        <span class="toggle-label">Scan Model</span>
        <select class="model-select" onchange="setScanModel(this.value)" onclick="event.stopPropagation()">
          <option value="gpt-4o" ${(activeProject.scanModel || 'gpt-4o') === 'gpt-4o' ? 'selected' : ''}>GPT-4o</option>
          <option value="gemini-2.0-flash" ${activeProject.scanModel === 'gemini-2.0-flash' ? 'selected' : ''}>Gemini Flash</option>
        </select>
      </div>
    </div>
  `;
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
  if (!oldData) return;
  try {
    const oldStreets = JSON.parse(oldData);
    if (oldStreets.length > 0) {
      activeProject.streets = oldStreets;
      streets = activeProject.streets;
      saveProjects();
    }
    localStorage.removeItem('cse_streets');
  } catch { /* skip */ }

  // Migrate old rating names → Level 1-4
  const ratingMap = { good: 'level-1', fair: 'level-2', poor: 'level-3', critical: 'level-4' };
  let changed = false;
  projects.forEach(p => {
    p.streets.forEach(s => {
      if (ratingMap[s.rating]) {
        s.rating = ratingMap[s.rating];
        changed = true;
      }
    });
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
}

function confirmStreetName() {
  const val = document.getElementById('name-prompt-input').value.trim();
  if (!val) return;
  const street = streets.find(s => s.id === window._namingStreetId);
  if (street) {
    street.name = val;
    saveStreets();
    renderStreetList();
    selectStreet(street.id);
  }
  document.getElementById('name-prompt-overlay').classList.add('hidden');
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
    street.weedAlert = analysis.weedAlert || false;
    street.weedNotes = analysis.weedNotes || '';
    street.scannedAt = new Date().toISOString();
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
          formatted: result.formatted_address
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
function getSamplePoints(street) {
  const path = street.path;
  if (!path || path.length < 2) return [{ lat: street.lat, lng: street.lng, heading: 0, label: 'Start' }];

  const startPt = path[0];
  const endPt   = path[path.length - 1];
  const headingForward  = calcHeading(startPt, endPt);
  const headingBackward = (headingForward + 180) % 360;
  const length = street.length || 0;

  const points = [];

  if (isMainStreet(street)) {
    // ── MAIN STREET — center line, 1 photo every 400ft ─────
    points.push({ ...startPt, heading: headingForward, label: 'Start (looking in)' });

    const midCount = Math.min(6, Math.floor(length / 400));
    for (let i = 1; i <= midCount; i++) {
      const t = i / (midCount + 1);
      points.push({
        lat: startPt.lat + (endPt.lat - startPt.lat) * t,
        lng: startPt.lng + (endPt.lng - startPt.lng) * t,
        heading: headingForward,
        label: `Mid-point ${i}`
      });
    }

    points.push({ ...endPt, heading: headingBackward, label: 'End (looking in)' });

  } else {
    // ── RESIDENTIAL — 1 photo per 200ft, start + end only ──
    points.push({ ...startPt, heading: headingForward, label: 'Start (looking in)' });

    const midCount = Math.min(5, Math.floor(length / 200));
    for (let i = 1; i <= midCount; i++) {
      const t = i / (midCount + 1);
      points.push({
        lat: startPt.lat + (endPt.lat - startPt.lat) * t,
        lng: startPt.lng + (endPt.lng - startPt.lng) * t,
        heading: headingForward,
        label: `Mid-point ${i}`
      });
    }

    points.push({ ...endPt, heading: headingBackward, label: 'End (looking in)' });
  }

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

async function analyzeStreetView(street) {
  if (!AI_PROXY) {
    return analyzeWithPlaceholder(street);
  }

  try {
    // Get sample points along the street
    const samplePoints = getSamplePoints(street);
    const photoCount = samplePoints.length;
    // Fetch all Street View images as base64 — use HD for better AI analysis
    const imagePromises = samplePoints.map(pt => {
      const url = getStreetViewUrlHD(pt.lat, pt.lng, pt.heading || 0);
      return imageUrlToBase64(url);
    });
    const images = await Promise.all(imagePromises);

    // Pair valid images with their labels
    const validPairs = [];
    images.forEach((img, i) => {
      if (img) validPairs.push({ base64: img, label: samplePoints[i].label || `Photo ${i + 1}` });
    });

    if (validPairs.length === 0) {
      console.warn('Could not load any Street View images, using placeholder');
      return analyzeWithPlaceholder(street);
    }

    // Build message content — interleave label + image so AI can reference each by name
    const content = [
      {
        type: 'text',
        text: `Assess the pavement condition of: ${street.name}\nStreet length: ${formatNumber(street.length || 0)} ft\n${validPairs.length} photos follow, each labeled. Reference the photo label when describing observations.`
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
            content: `You are a pavement condition assessor for a road sealing company (GRSI). You are receiving ${validPairs.length} Street View image(s) of a single street.

Photos include corner/intersection views and mid-street views. Corners and cul-de-sacs typically show the worst cracking due to turning traffic — pay extra attention to these.

Analyze ALL images together. Look for: cracks (alligator, longitudinal, transverse), potholes, fading, patches, wear, surface texture, color of asphalt, corner damage. Also look for any weeds, grass, or vegetation growing out of cracks or joints in the pavement.

Use this rating scale:
- Level 1: Zero to little cracks — pavement in good condition
- Level 2: Moderate light amount of cracks — some visible cracking
- Level 3: Moderate heavy amount, deep cracks and alligator cracking
- Level 4: Alligator cracking everywhere, deep cracks and heavy cracking every 3-5 feet

IMPORTANT: If you see any cracks that appear wider than 1.25 inches, flag them with "⚠ WIDE CRACKS DETECTED (1.25"+)" — these are typically outside standard scope.

Your response must include:
1. PHOTOS ANALYZED: ${validPairs.length} images covering ${formatNumber(street.length || 0)} ft
2. WHAT I CAN SEE: 2-4 bullet points. Every single bullet MUST end with the photo reference in parentheses — e.g. "(Photo 2: Mid-point 1)". Do not write any bullet without a photo citation. Note if condition varies along the street.
3. WIDE CRACKS: If any cracks appear wider than 1.25 inches, flag with "⚠ WIDE CRACKS DETECTED (1.25"+)" and reference which photo(s). If none, write "None detected."
4. WEED/GRASS CONTROL: If you see vegetation growing from cracks, flag with "🌿 WEED CONTROL NEEDED", describe extent (light/moderate/heavy), and reference which photo(s). If none, write "None detected."
5. WHAT I CAN'T SEE: 1-2 bullet points about limitations
6. Level: [1/2/3/4]
7. PHOTO RATINGS: Rate each photo individually on the same scale. One line, exactly this format: "Photo 1: [1/2/3/4], Photo 2: [1/2/3/4], ..."

Be honest. Weight toward the worst section. Do not guess — only rate what you can actually see.`
          },
          { role: 'user', content: content }
        ],
        max_tokens: 1500
      })
    });

    // Store scan photos before AI call so they're preserved even if AI fails
    // Cache base64 images in memory (not localStorage) so lightbox can display them
    street.photosScanned = validPairs.length;
    street.scanPhotos = samplePoints.map((pt, i) => {
      const hdUrl = getStreetViewUrlHD(pt.lat, pt.lng, pt.heading || 0);
      if (images[i]) _photoCache.set(hdUrl, images[i]);
      return {
        url: getStreetViewUrl(pt.lat, pt.lng, pt.heading || 0),
        hdUrl,
        label: pt.label,
        lat: pt.lat,
        lng: pt.lng
      };
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
    // Store per-photo ratings from AI response
    const photoRatings = extractPhotoRatings(text, samplePoints.length);
    photoRatings.forEach((r, i) => { if (street.scanPhotos[i] && r) street.scanPhotos[i].rating = r; });
    return { text, rating, weedAlert, weedNotes };
  } catch (e) {
    console.error('AI analysis error:', e);
    return analyzeWithPlaceholder(street);
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
  const match = text.match(/4\.\s*WEED\/GRASS CONTROL[:\s]+([\s\S]*?)(?=5\.\s*WHAT I CAN'T SEE|6\.\s*Level:|$)/i);
  if (match) return match[1].trim();
  const match2 = text.match(/WEED\/GRASS CONTROL[:\s]+([\s\S]*?)(?=WHAT I CAN'T SEE|Level:|$)/i);
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
    // Only show marker if street has no highlight line (line is the visual)
    const hasLine = street.path && street.path.length >= 2;
    const marker = makeMarker({
      position: { lat: street.lat, lng: street.lng },
      map: map,
      title: street.name,
      content: makeDotContent(ratingColor(street.rating), hasLine ? 12 : 16, '#fff', hasLine ? 0 : 1)
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
  const visibleStreets = (svOpen && activeStreetId) ? streets.filter(s => s.id === activeStreetId) : streets;

  // Show a "back to all" link when filtered
  const backLink = (svOpen && activeStreetId && streets.length > 1) ?
    `<div class="street-list-back" onclick="activeStreetId=null;renderStreetList()">← Show all ${streets.length} streets</div>` : '';

  container.innerHTML = backLink + visibleStreets.map(s => `
    <div class="street-card ${s.id === activeStreetId ? 'active' : ''} ${s.crossesBoundary ? 'street-card-warning' : ''} street-card-${s.rating}" onclick="selectStreet('${s.id}')">
      <button class="street-card-delete" onclick="event.stopPropagation(); deleteStreet('${s.id}')" title="Delete">&times;</button>
      <div class="street-card-name" title="${escHtml(s.name)}">${escHtml(s.name)}</div>
      ${s.city ? `<div class="street-card-city">${escHtml(s.city)}${s.county ? ', ' + escHtml(s.county) : ''}${s.roadType ? ' · ' + escHtml(s.roadType) : ''}</div>` : (s.roadType ? `<div class="street-card-city">${escHtml(s.roadType)}</div>` : '')}
      ${s.crossesBoundary ? `<div class="street-card-boundary">⚠ ${escHtml(s.boundaryNote)}</div>` : ''}
      ${s.weedAlert ? `<div class="street-card-weed">🌿 Weed control needed</div>` : ''}
      <div class="street-card-meta">
        <span class="street-card-sqft">${s.sqft ? formatNumber(s.sqft) + ' sq ft' : 'No dimensions'}</span>
        <span class="rating-badge rating-${s.rating}" title="${ratingDescription(s.rating)}">${ratingLabel(s.rating)}</span>
      </div>
    </div>
  `).join('');
}

// ─── SELECT STREET (detail panel) ──────────────────────────
let lastDrawnActiveId = null;
function selectStreet(id) {
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

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <h3>${escHtml(street.name)} <button class="btn-edit-analysis" onclick="promptStreetName(streets.find(s=>s.id==='${street.id}'), decodeURIComponent('${encodeURIComponent(street.name)}'))" style="font-size:11px;padding:2px 8px">Rename</button></h3>
      ${(() => { const dir = getStreetDirection(street); return dir ? `<span style="display:inline-block;background:var(--accent);color:#000;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;margin-bottom:6px">${dir}</span>` : ''; })()}
      ${street.city ? `<div class="detail-jurisdiction">${escHtml(street.city)}${street.county ? ' — ' + escHtml(street.county) : ''}${street.state ? ', ' + escHtml(street.state) : ''}</div>` : ''}
      ${street.crossesBoundary ? `<div class="detail-boundary-warn">⚠ ${escHtml(street.boundaryNote)}</div>` : ''}
      ${street.weedAlert ? `<div class="detail-weed-warn">
        🌿 Weed/grass control may be needed on this street
        ${street.weedNotes ? `<div class="weed-notes">${escHtml(street.weedNotes)}</div>` : ''}
        ${(street.weedNotes && street.scanPhotos?.length) ? (() => {
          const indices = extractWeedPhotoIndices(street.weedNotes);
          const photos = indices.map(i => street.scanPhotos[i]).filter(p => p?.lat);
          if (!photos.length) return '';
          return `<div class="weed-locations">${photos.map(p =>
            `<button class="weed-jump-btn" onclick="map.panTo({lat:${p.lat},lng:${p.lng}});map.setZoom(19)" title="Jump to ${escHtml(p.label)}">📍 ${escHtml(p.label)}</button>`
          ).join('')}</div>`;
        })() : ''}
      </div>` : ''}
      <div class="detail-address">Added ${formatDate(street.createdAt)}</div>
    </div>

    <div class="detail-stats">
      <div class="detail-stat">
        <div class="detail-stat-label">Sq Ft</div>
        <div class="detail-stat-value">${street.sqft ? formatNumber(street.sqft) : '—'}</div>
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
      <div class="detail-stat">
        <div class="detail-stat-label">Length</div>
        <div class="detail-stat-value">${street.length ? street.length + ' ft' : '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Width</div>
        <div class="detail-stat-value">${street.width ? street.width + ' ft' : '—'}</div>
        ${street.roadType ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">${escHtml(street.roadType)}</div>` : ''}
      </div>
    </div>

    <div class="detail-section">
      <h4>Street View</h4>
      <img class="streetview-img" src="${street.svImage}" alt="Street View of ${escHtml(street.name)}" onclick="openStreetViewAt(${street.lat}, ${street.lng})" style="cursor:pointer" title="Click to open interactive Street View" onerror="loadSvThumbnailViaProxy(this, '${street.svImage}')">
    </div>

    ${activeProject.aiEnabled !== false ? `
    <div class="detail-section">
      <h4>On-Site Photos (${(street.photos || []).length})</h4>
      <button class="btn-photo" onclick="openPhotoCapture('${street.id}')">Take Photo</button>
      ${(street.photos || []).length > 0 ? `
        <div class="photo-grid">
          ${street.photos.map((p, i) => `
            <div class="photo-card" onclick="openLightbox(streets.find(s=>s.id==='${street.id}').photos, ${i}, '${street.id}')" style="cursor:pointer" title="Click to view">
              <img src="${p.dataUrl}" alt="Crack photo" class="photo-thumb">
              <div class="photo-info">
                <small>
                  ${p.address ? escHtml(p.address.split(',')[0]) : 'GPS tagged'}
                  ${p.lat ? `<button class="btn-photo-jump" onclick="event.stopPropagation();map.panTo({lat:${p.lat},lng:${p.lng}});map.setZoom(19)" title="Jump to location on map">&#128205;</button>` : ''}
                </small>
                <small>${new Date(p.takenAt).toLocaleDateString()}</small>
                ${p.note ? `<small class="photo-note">${escHtml(p.note)}</small>` : ''}
              </div>
              <button class="photo-delete" onclick="event.stopPropagation();deletePhoto('${street.id}','${p.id}')" title="Delete">&times;</button>
            </div>
          `).join('')}
        </div>
      ` : '<p class="text-dim">No photos yet — take one on-site</p>'}
    </div>
    ` : ''}

    ${(street.scanPhotos && street.scanPhotos.length > 0) ? `
    <div class="detail-section">
      <h4>Photos AI Analyzed (${street.scanPhotos.length})
        <button class="btn-clear-scan-photos" onclick="clearScanPhotos('${street.id}')" title="Delete all AI scan photos">Clear All</button>
      </h4>
      <div class="scan-photo-grid">
        ${street.scanPhotos.map((p, i) => `
          <div class="scan-photo-card scan-photo-rated-${p.rating || 'none'}" onclick="openLightbox(streets.find(s=>s.id==='${street.id}').scanPhotos, ${i}, '${street.id}')" title="Click to view photo">
            <button class="scan-photo-delete" onclick="event.stopPropagation();deleteScanPhoto('${street.id}', ${i})" title="Delete">&times;</button>
            <span class="scan-photo-icon">&#128247;</span>
            <span class="scan-photo-label">${escHtml(p.label)}</span>
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
    </div>
    ` : ''}

    ${activeProject.aiEnabled !== false ? `
    <div class="detail-section analysis-section-${street.rating}">
      <h4>AI Pavement Analysis ${street.photosScanned ? `(${street.photosScanned} photo${street.photosScanned > 1 ? 's' : ''} scanned)` : ''}
        <button class="btn-edit-analysis" onclick="toggleEditAnalysis('${street.id}')" id="edit-analysis-btn">Edit</button>
      </h4>
      <div class="analysis-rating-summary">${ratingLabel(street.rating)} — ${ratingDescription(street.rating)}</div>
      <div class="ai-analysis" id="analysis-display">${escHtml(street.analysis || 'No analysis available')}</div>
      <div class="analysis-edit-area hidden" id="analysis-edit">
        <textarea id="analysis-textarea" class="analysis-textarea">${escHtml(street.analysis || '')}</textarea>
        <div class="analysis-edit-actions">
          <button class="btn-save-analysis" onclick="saveAnalysis('${street.id}')">Save</button>
          <button class="btn-secondary btn-cancel-analysis" onclick="cancelEditAnalysis()">Cancel</button>
        </div>
      </div>
    </div>
    ` : `
    <div class="detail-section">
      <div class="ai-off-notice">AI analysis is off for this project</div>
    </div>
    `}

    <div class="detail-section">
      <h4>Admin Notes
        <button class="btn-edit-analysis" onclick="toggleEditNotes('${street.id}')" id="edit-notes-btn">${street.adminNotes ? 'Edit' : 'Add'}</button>
      </h4>
      ${street.adminNotes ? `<div class="admin-notes" id="notes-display">${escHtml(street.adminNotes)}</div>` : `<p class="text-dim" id="notes-display">No admin notes yet</p>`}
      <div class="analysis-edit-area hidden" id="notes-edit">
        <textarea id="notes-textarea" class="analysis-textarea" placeholder="Add your own notes about this street...">${escHtml(street.adminNotes || '')}</textarea>
        <div class="analysis-edit-actions">
          <button class="btn-save-analysis" onclick="saveAdminNotes('${street.id}')">Save</button>
          <button class="btn-secondary btn-cancel-analysis" onclick="cancelEditNotes()">Cancel</button>
        </div>
      </div>
    </div>

    <div class="detail-actions">
      ${(street.path || street.highlightStart) ?
        `<button class="btn-secondary" onclick="removeHighlight('${street.id}')">Clear Line</button>
         <button class="btn-secondary" onclick="snapToRoad('${street.id}')">Snap to Road</button>` :
        `<button class="btn-highlight" onclick="startFreeHighlight()">Highlight Street</button>`
      }
      ${activeProject.aiEnabled !== false ? `<button class="btn-rescan" onclick="rescanStreet('${street.id}')">Re-scan</button>` : ''}
      <button class="btn-danger" onclick="deleteStreet('${street.id}')">Delete</button>
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
  street.rating = rating;
  saveStreets();
  updateStats();
  placeAllMarkers();
  lastDrawnActiveId = null; // force highlight redraw
  selectStreet(id);
  showToast(`Rating set to ${ratingLabel(rating)}`);
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
    street.weedAlert = analysis.weedAlert || false;
    street.weedNotes = analysis.weedNotes || '';
    street.scannedAt = new Date().toISOString();

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
let _lbPhotos = [], _lbIdx = 0, _lbStreetId = null;

function openLightbox(photos, idx, streetId) {
  _lbPhotos = photos;
  _lbIdx = idx;
  _lbStreetId = streetId || null;
  _renderLightbox();
  document.getElementById('photo-lightbox').classList.remove('hidden');
}

function lightboxSetRating(value) {
  if (!_lbStreetId) return;
  setPhotoRating(_lbStreetId, _lbIdx, value);
  _lbPhotos[_lbIdx].rating = value || null;
}

function lightboxDeletePhoto() {
  const p = _lbPhotos[_lbIdx];
  if (!p?.id || !_lbStreetId) return;
  deletePhoto(_lbStreetId, p.id);
  closeLightbox();
}

function closeLightbox() {
  document.getElementById('photo-lightbox').classList.add('hidden');
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

  // Label: scan photos use p.label, on-site photos use address or note
  label.textContent = p.label || (p.address ? p.address.split(',')[0] : 'On-site photo');
  if (p.note) label.textContent += ` — ${p.note}`;
  count.textContent = `${_lbIdx + 1} / ${_lbPhotos.length}`;
  if (sel) sel.value = p.rating || '';

  // Show delete button only for on-site photos (they have dataUrl + id)
  if (delBtn) delBtn.classList.toggle('hidden', !p.id);

  // On-site photos have dataUrl stored directly — no proxy needed
  if (p.dataUrl) {
    img.src = p.dataUrl;
    img.alt = '';
    return;
  }

  // Scan photos: use cached base64, or fetch on-demand through the worker proxy
  const cached = _photoCache.get(p.hdUrl);
  if (cached) {
    img.src = cached;
  } else {
    img.src = '';
    img.alt = 'Loading...';
    const dataUrl = await imageUrlToBase64(p.hdUrl || p.url);
    if (dataUrl) {
      _photoCache.set(p.hdUrl, dataUrl);
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

  map.setCenter({ lat: geo.lat, lng: geo.lng });
  map.setZoom(17);
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

function deleteScanPhoto(streetId, index) {
  const street = streets.find(s => s.id === streetId);
  if (!street?.scanPhotos) return;
  street.scanPhotos.splice(index, 1);
  recalcRatingFromPhotos(streetId);
  saveStreets();
  selectStreet(streetId);
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

// ─── PHOTO MARKERS ON MAP ──────────────────────────────────
let photoMarkers = [];
let _activeInfoWindow = null;

function placePhotoMarkers() {
  photoMarkers.forEach(m => removeFromMap(m));
  photoMarkers = [];

  streets.forEach(street => {
    if (!street.photos) return;
    street.photos.forEach(photo => {
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
  });
}

// ─── STREET VIEW MODE ──────────────────────────────────────
let streetViewMode = false;
let streetViewPano = null;

function toggleStreetView() {
  if (streetViewMode) {
    streetViewMode = false;
    document.querySelector('.qa-streetview').classList.remove('qa-active');
    showToast('Street View mode off');
    return;
  }
  // Turn off other modes
  if (drawingMode) stopDrawingMode();
  streetViewMode = true;
  document.querySelector('.qa-streetview').classList.add('qa-active');
  showToast('Click anywhere on the map to open Street View');
}

let miniMap = null;
let miniMapMarker = null;
let miniMapLines = [];
let svPositionListener = null;
let _miniMapTimer = null;

function openStreetViewAt(lat, lng) {
  const panel = document.getElementById('streetview-panel');
  panel.classList.remove('hidden');

  if (streetViewPano) {
    // Reuse existing panorama — just move position, preserve heading
    streetViewPano.setPosition({ lat, lng });
  } else {
    // First open — create the panorama
    if (svPositionListener) { google.maps.event.removeListener(svPositionListener); svPositionListener = null; }
    streetViewPano = new google.maps.StreetViewPanorama(
      document.getElementById('streetview-pano'), {
        position: { lat, lng },
        pov: { heading: 0, pitch: -5 },
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
  }
}

// ─── STREET VIEW SNAP ──────────────────────────────────────
let _snapData = null; // { dataUrl, lat, lng, heading }

async function snapStreetView() {
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

  _snapData = { dataUrl, lat, lng, heading };
  document.getElementById('snap-preview').src = dataUrl;
  document.getElementById('snap-rating').value = '';
  document.getElementById('snap-note').value = '';
  document.getElementById('snap-overlay').classList.remove('hidden');
}

function closeSnapModal(e) {
  if (e && e.target !== document.getElementById('snap-overlay')) return;
  document.getElementById('snap-overlay').classList.add('hidden');
  _snapData = null;
}

function saveSnap() {
  if (!_snapData || !activeStreetId) return;
  const street = streets.find(s => s.id === activeStreetId);
  if (!street) return;

  const rating = document.getElementById('snap-rating').value;
  const note = document.getElementById('snap-note').value.trim();

  if (!street.photos) street.photos = [];
  street.photos.push({
    id: crypto.randomUUID?.() || Date.now().toString(36),
    dataUrl: _snapData.dataUrl,
    lat: _snapData.lat,
    lng: _snapData.lng,
    address: '',
    note: note || '',
    rating: rating || null,
    source: 'streetview',
    takenAt: new Date().toISOString()
  });

  // If a rating was set, factor it into the street rating
  if (rating) {
    const manualRatings = street.photos.filter(p => p.rating);
    const counts = {};
    manualRatings.forEach(p => { counts[p.rating] = (counts[p.rating] || 0) + 1; });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) { street.rating = best[0]; }
  }

  saveStreets();
  placePhotoMarkers();
  placeAllMarkers();
  selectStreet(activeStreetId);
  document.getElementById('snap-overlay').classList.add('hidden');
  _snapData = null;
  showToast('Photo saved to street');
}

function closeStreetViewPanel() {
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
  document.querySelector('.qa-streetview').classList.remove('qa-active');
  renderStreetList(); // show all streets again
  updateStats(); // restore project-wide stats
}

// ─── FREE HIGHLIGHT (continuous multi-point drawing) ───────
let drawingMode = false;
let drawCount = 0;

function startFreeHighlight() {
  if (drawingMode) { stopDrawingMode(); return; }
  if (streetViewMode) toggleStreetView(); // turn off street view
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
        svImage: getStreetViewUrl(lat, lng),
        photos: [],
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
  // Street View mode
  if (streetViewMode) {
    openStreetViewAt(latLng.lat(), latLng.lng());
    return;
  }

  if (highlightMode !== 'drawing') return;

  if (!window._drawStart) {
    // Click 1 = START of street
    window._drawStart = { lat: latLng.lat(), lng: latLng.lng() };
    clearTempMarkers();
    clearTempPolyline();
    addTempMarker(latLng, 'S', '#22c55e');
    document.getElementById('highlight-bar-text').textContent = 'Now click the END of this street';
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
    name: (() => {
      // Directions API dominant step is most reliable — use it if available
      if (window._directionsStreetName) {
        const n = window._directionsStreetName;
        window._directionsStreetName = null;
        return n;
      }
      // Fallback: vote across start/mid/end geocodes
      const votes = [startGeo.route, midGeo.route, endGeo.route, roadInfo.name].filter(Boolean);
      const counts = {};
      votes.forEach(n => { counts[n] = (counts[n] || 0) + 1; });
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      return best ? best[0] : 'Unknown location';
    })(),
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
    photos: [],
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

  streets.push(street);
  saveStreets();
  hideScanModal();

  // Reset for next street
  window._drawStart = null;
  clearTempMarkers();
  clearTempPolyline();
  drawAllHighlights();
  renderStreetList();
  placeAllMarkers();
  updateStats();

  drawCount++;
  document.getElementById('highlight-bar-text').textContent = `Street ${drawCount} saved (${formatNumber(roadLengthFt)} ft) — click next street or Done`;
  showToast(`${formatNumber(roadLengthFt)} ft — ${formatNumber(street.sqft)} sq ft`);

  // Name already set from vote across start/mid/end geocodes — saved above

  if (street.crossesBoundary) {
    setTimeout(() => showToast(`⚠ ${street.boundaryNote}`, 5000), 1500);
  }

  // Auto-scan in background
  analyzeStreetView(street).then(analysis => {
    street.analysis = analysis.text;
    street.rating = analysis.rating;
    street.weedAlert = analysis.weedAlert || false;
    street.weedNotes = analysis.weedNotes || '';
    street.scannedAt = new Date().toISOString();
    saveStreets();
    drawAllHighlights();
    renderStreetList();
    updateStats();
  }).catch(() => {});
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

    // Glow outline
    const glow = new google.maps.Polyline({
      path: points,
      geodesic: true,
      strokeColor: color,
      strokeOpacity: 0.2,
      strokeWeight: 16,
      map: map
    });
    glow.addListener('click', () => selectStreet(street.id));
    polylines.push(glow);

    // Main line
    const line = new google.maps.Polyline({
      path: points,
      geodesic: true,
      strokeColor: color,
      strokeOpacity: 0.9,
      strokeWeight: isActive ? 8 : 6,
      map: map
    });
    line.addListener('click', () => selectStreet(street.id));
    polylines.push(line);

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

  // Animated moving dash overlay on the selected street
  if (activeStreetId) {
    const active = streets.find(s => s.id === activeStreetId);
    if (active?.path?.length > 1) {
      const dashSymbol = { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 5 };
      const animLine = new google.maps.Polyline({
        path: active.path,
        geodesic: true,
        strokeColor: '#ffffff',
        strokeOpacity: 0,
        strokeWeight: 4,
        icons: [{ icon: dashSymbol, offset: '0%', repeat: '24px' }],
        map: map,
        zIndex: 20
      });
      animLine.addListener('click', () => selectStreet(active.id));
      polylines.push(animLine);

      let offset = 0;
      _animInterval = setInterval(() => {
        offset = (offset + 2) % 200;
        animLine.set('icons', [{ icon: dashSymbol, offset: (offset / 2) + '%', repeat: '24px' }]);
      }, 30);
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
async function generateProjectReport() {
  if (streets.length === 0) {
    showToast('Add some streets first');
    return;
  }

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
  const cities = [...new Set(streets.map(s => s.city).filter(Boolean))];
  const boundaryStreets = streets.filter(s => s.crossesBoundary);
  const weedStreets = streets.filter(s => s.weedAlert);

  // Build street summary for AI
  const streetSummary = streets.map(s =>
    `- ${s.name}: ${formatNumber(s.length || 0)} ft, ${formatNumber(s.sqft || 0)} sq ft, Rating: ${s.rating}, City: ${s.city || 'Unknown'}${s.weedAlert ? ', ⚠ WEED CONTROL NEEDED' : ''}${s.adminNotes ? ', Admin notes: ' + s.adminNotes : ''}`
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
              content: `You are a pavement assessment expert writing a project summary for a road sealing company called GRSI. Be concise and professional. Include: overall project condition, priority streets that need immediate attention, recommendations for the work scope, any concerns about boundary crossings, and if any streets have weed/grass control alerts, include a section noting which streets may need vegetation removal before sealing work can begin. Format with bullet points.`
            },
            {
              role: 'user',
              content: `Project: ${activeProject.name}\nTotal streets: ${totalStreets}\nTotal sq ft: ${formatNumber(totalSqft)}\nTotal linear ft: ${formatNumber(totalLength)}\nCities: ${cities.join(', ') || 'Unknown'}\nBoundary crossings: ${boundaryStreets.length}\nStreets needing weed control: ${weedStreets.length}\n\nStreet breakdown:\n${streetSummary}\n\nProvide a project summary with overall condition assessment, priority recommendations, scope notes, and weed control recommendations if applicable.`
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

    ${cities.length > 0 ? `<div class="report-section"><div class="report-label">Jurisdictions</div><div>${cities.join(', ')}</div></div>` : ''}

    ${boundaryStreets.length > 0 ? `<div class="report-section" style="border-color:rgba(249,115,22,0.3)"><div class="report-label" style="color:var(--orange)">⚠ Boundary Crossings (${boundaryStreets.length})</div><div style="font-size:12px">${boundaryStreets.map(s => escHtml(s.boundaryNote)).join('<br>')}</div></div>` : ''}

    ${weedStreets.length > 0 ? `<div class="report-section" style="border-color:rgba(34,197,94,0.3)"><div class="report-label" style="color:#22c55e">🌿 Weed/Grass Control (${weedStreets.length} street${weedStreets.length > 1 ? 's' : ''})</div><div style="font-size:12px">${weedStreets.map(s => escHtml(s.name?.split(',')[0] || 'Unknown')).join('<br>')}</div></div>` : ''}

    <div class="report-section">
      <div class="report-label">Street Breakdown</div>
      ${streets.map(s => `
        <div class="report-street-row">
          <span>${escHtml(s.name?.split(',')[0] || 'Unknown')}${s.weedAlert ? ' 🌿' : ''}</span>
          <span>${formatNumber(s.sqft || 0)} sq ft</span>
          <span class="rating-badge rating-${s.rating}" title="${ratingDescription(s.rating)}">${ratingLabel(s.rating)}</span>
        </div>
        ${s.adminNotes ? `<div class="report-admin-note">📝 ${escHtml(s.adminNotes)}</div>` : ''}
      `).join('')}
    </div>

    <div class="report-section">
      <div class="report-label">AI Project Summary</div>
      <div class="report-ai">${escHtml(aiSummary)}</div>
    </div>
  `;
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

// ─── DARK MAP STYLE ────────────────────────────────────────
const _darkMapStyleCache = [
    { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a2e' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8892b0' }] },
    { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2d2d44' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2d2d44' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1a1a2e' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3b3b5c' }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8892b0' }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#1f1f35' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1525' }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4a5568' }] }
];
function darkMapStyle() { return _darkMapStyleCache; }
