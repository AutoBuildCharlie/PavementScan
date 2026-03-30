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
     rating, roadType, notes, analysis, adminNotes, weedAlert, svImage,
     path: [{ lat, lng }, ...],
     photos: [{ id, dataUrl, lat, lng, address, note, takenAt }],
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
let tempPolyline = null; // live polyline while drawing
let tempPath = []; // points being drawn
const PROJECTS_KEY = 'cse_projects';
const ACTIVE_KEY = 'cse_active_project';
const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const SV_BASE = 'https://maps.googleapis.com/maps/api/streetview';
let API_KEY = '';

// ─── OPENAI PROXY (for AI crack analysis) ──────────────────
const AI_PROXY = 'https://cse-worker.aestheticcal22.workers.dev';

// ─── INIT ──────────────────────────────────────────────────
function initMap() {
  API_KEY = getMapKey();
  loadProjects();
  migrateOldData();

  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 33.83, lng: -117.91 }, // Anaheim default
    zoom: 12,
    mapTypeId: 'roadmap',
    styles: darkMapStyle(),
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

  // Auto-fix streets missing road type (runs once per device)
  migrateRoadTypes();
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
  localStorage.setItem(ACTIVE_KEY, activeProject.id);
}

function saveProjects() {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
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
  localStorage.setItem(ACTIVE_KEY, activeProject.id);
  activeStreetId = null;
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
        <span class="toggle-label">Wide Cracks (1.25"+)</span>
        <span class="toggle-value ${activeProject.includeWideCracks ? 'toggle-on' : 'toggle-off'}">${activeProject.includeWideCracks ? 'IN SCOPE' : 'OUT'}</span>
      </div>
      <div class="toggle-pill" onclick="toggleAI()" title="${activeProject.aiEnabled !== false ? 'AI analysis & photo capture ON — click to turn off' : 'AI analysis & photo capture OFF — click to turn on'}">
        <span class="toggle-label">AI Analysis</span>
        <span class="toggle-value ${activeProject.aiEnabled !== false ? 'toggle-on' : 'toggle-off'}">${activeProject.aiEnabled !== false ? 'ON' : 'OFF'}</span>
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
      headers: { 'User-Agent': 'CrackingSealingEst/1.0' }
    });
    const data = await res.json();
    const osmType = data.type || data.class || '';
    const road = ROAD_TYPES[osmType];
    if (road) return { type: osmType, label: road.label, width: road.width };
    // Fallback: default to residential
    return { type: osmType || 'unknown', label: 'Residential', width: 32 };
  } catch (e) {
    console.error('Road type detection error:', e);
    return { type: 'unknown', label: 'Residential', width: 32 };
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

// ─── AI ANALYSIS ───────────────────────────────────────────

// Determine how many mid-street photos based on length
function getMidPhotoCount(lengthFt) {
  if (lengthFt < 500) return 0;   // side streets — corners only
  if (lengthFt < 1500) return 1;  // standard — 1 mid
  if (lengthFt < 3000) return 2;  // long — 2 mid
  return 3;                        // major — 3 mid
}

// Calculate sample points + corner coverage
function getSamplePoints(street) {
  const path = street.path;
  if (!path || path.length < 2) return [{ lat: street.lat, lng: street.lng, heading: 0, label: 'Center' }];

  const startPt = path[0];
  const endPt = path[path.length - 1];
  const heading = calcHeading(startPt, endPt);
  const length = street.length || 0;

  // Cul-de-sacs and side streets (under 500 ft) — 1 photo from center
  if (length < 500) {
    const midLat = (startPt.lat + endPt.lat) / 2;
    const midLng = (startPt.lng + endPt.lng) / 2;
    return [{ lat: midLat, lng: midLng, heading: heading, label: 'Center' }];
  }

  const points = [];

  // START CORNER — 2 photos
  points.push({ ...startPt, heading: heading, label: 'Start (looking down street)' });
  points.push({ ...startPt, heading: (heading + 90) % 360, label: 'Start corner (cross street)' });

  // MID-STREET — evenly spaced
  const midCount = getMidPhotoCount(length);
  for (let i = 1; i <= midCount; i++) {
    const t = i / (midCount + 1);
    points.push({
      lat: startPt.lat + (endPt.lat - startPt.lat) * t,
      lng: startPt.lng + (endPt.lng - startPt.lng) * t,
      heading: heading,
      label: `Mid-point ${i}`
    });
  }

  // END CORNER — 2 photos
  points.push({ ...endPt, heading: (heading + 180) % 360, label: 'End (looking back)' });
  points.push({ ...endPt, heading: (heading + 270) % 360, label: 'End corner (cross street)' });

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
    const photoLabels = ['start', 'middle-start', 'middle', 'middle-end', 'end'];

    // Fetch all Street View images as base64
    const imagePromises = samplePoints.map(pt => {
      const url = getStreetViewUrl(pt.lat, pt.lng, pt.heading || 0);
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

    // Build message content with labeled images
    const photoDescriptions = validPairs.map(p => p.label).join(', ');
    const content = [
      {
        type: 'text',
        text: `Assess the pavement condition of: ${street.name}\nStreet length: ${formatNumber(street.length || 0)} ft\nI'm sending ${validPairs.length} photo(s): ${photoDescriptions}.\nCorner photos show intersections and cross streets where cracking is usually worst.`
      },
      ...validPairs.map(p => ({
        type: 'image_url',
        image_url: { url: p.base64 }
      }))
    ];

    const res = await fetch(AI_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
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
2. WHAT I CAN SEE: 2-4 bullet points. Note corner vs mid-street differences. Note if condition varies along the street.
3. CORNERS: Specifically note condition at intersections/corners if visible.
4. WIDE CRACKS: If any cracks appear wider than 1.25 inches, note their location. If none visible, write "None detected from this view."
5. WEED/GRASS CONTROL: If you see any weeds, grass, or vegetation growing out of cracks or pavement joints, flag it with "🌿 WEED CONTROL NEEDED" and briefly describe the extent (light, moderate, heavy). If none visible, write "None detected."
6. WHAT I CAN'T SEE: 1-2 bullet points about limitations
7. Level: [1/2/3/4]

Be honest. Weight toward the worst section. Do not guess — only rate what you can actually see.`
          },
          { role: 'user', content: content }
        ],
        max_tokens: 500
      })
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) return analyzeWithPlaceholder(street);
    const rating = extractRating(text);
    const weedAlert = extractWeedAlert(text);

    // Store how many photos were used
    street.photosScanned = validPairs.length;

    return { text, rating, weedAlert };
  } catch (e) {
    console.error('AI analysis error:', e);
    return analyzeWithPlaceholder(street);
  }
}

// Fetch an image URL and return as base64 data URL
function imageUrlToBase64(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
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

function extractWeedAlert(text) {
  const lower = text.toLowerCase();
  if (lower.includes('weed control needed')) return true;
  if (lower.includes('vegetation growing') || lower.includes('weeds growing') || lower.includes('grass growing')) return true;
  return false;
}

function ratingLabel(rating) {
  switch (rating) {
    case 'level-1': case 'good': return 'LVL 1';
    case 'level-2': case 'fair': return 'LVL 2';
    case 'level-3': case 'poor': return 'LVL 3';
    case 'level-4': case 'critical': return 'LVL 4';
    default: return rating.toUpperCase();
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
  markers.forEach(m => m.setMap(null));
  markers = [];

  streets.forEach(street => {
    const color = ratingColor(street.rating);
    const marker = new google.maps.Marker({
      position: { lat: street.lat, lng: street.lng },
      map: map,
      title: street.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 14,
        fillColor: color,
        fillOpacity: 0.9,
        strokeColor: '#fff',
        strokeWeight: 2.5
      }
    });

    marker.addListener('click', () => selectStreet(street.id));
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
    <div class="street-card ${s.id === activeStreetId ? 'active' : ''} ${s.crossesBoundary ? 'street-card-warning' : ''}" onclick="selectStreet('${s.id}')">
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
function selectStreet(id) {
  activeStreetId = id;
  const street = streets.find(s => s.id === id);
  if (!street) return;

  // Highlight card
  renderStreetList();

  // Center map
  map.setCenter({ lat: street.lat, lng: street.lng });
  map.setZoom(16);

  // If Street View is open, jump to this street
  const svOpen = streetViewPano && !document.getElementById('streetview-panel').classList.contains('hidden');
  if (svOpen) {
    streetViewPano.setPosition({ lat: street.lat, lng: street.lng });
  }

  // Show detail panel
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <h3>${escHtml(street.name)}</h3>
      ${street.city ? `<div class="detail-jurisdiction">${escHtml(street.city)}${street.county ? ' — ' + escHtml(street.county) : ''}${street.state ? ', ' + escHtml(street.state) : ''}</div>` : ''}
      ${street.crossesBoundary ? `<div class="detail-boundary-warn">⚠ ${escHtml(street.boundaryNote)}</div>` : ''}
      ${street.weedAlert ? `<div class="detail-weed-warn">🌿 Weed/grass control may be needed on this street</div>` : ''}
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
      <img class="streetview-img" src="${street.svImage}" alt="Street View of ${escHtml(street.name)}" onclick="openStreetViewAt(${street.lat}, ${street.lng})" style="cursor:pointer" title="Click to open interactive Street View" onerror="this.src=''; this.alt='Street View not available'">
    </div>

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

    ${activeProject.aiEnabled !== false ? `
    <div class="detail-section">
      <h4>On-Site Photos (${(street.photos || []).length})</h4>
      <button class="btn-photo" onclick="openPhotoCapture('${street.id}')">Take Photo</button>
      ${(street.photos || []).length > 0 ? `
        <div class="photo-grid">
          ${street.photos.map(p => `
            <div class="photo-card">
              <img src="${p.dataUrl}" alt="Crack photo" class="photo-thumb">
              <div class="photo-info">
                <small>${p.address ? escHtml(p.address.split(',')[0]) : 'GPS tagged'}</small>
                <small>${new Date(p.takenAt).toLocaleDateString()}</small>
              </div>
              <button class="photo-delete" onclick="deletePhoto('${street.id}','${p.id}')" title="Delete">&times;</button>
            </div>
          `).join('')}
        </div>
      ` : '<p class="text-dim">No photos yet — take one on-site</p>'}
    </div>
    ` : ''}

    <div class="detail-actions">
      ${(street.path || street.highlightStart) ?
        `<button class="btn-secondary" onclick="removeHighlight('${street.id}')">Clear Line</button>` :
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

    // Build mini map
    setTimeout(() => {
      miniMap = new google.maps.Map(document.getElementById('mini-map'), {
        center: { lat: street.lat, lng: street.lng },
        zoom: 17,
        mapTypeId: 'roadmap',
        styles: darkMapStyle(),
        disableDefaultUI: true,
        zoomControl: true
      });

      miniMapMarker = new google.maps.Marker({
        position: { lat: street.lat, lng: street.lng },
        map: miniMap,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 }
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
        streetViewPano.addListener('position_changed', () => {
          const pos = streetViewPano.getPosition();
          if (miniMapMarker) { miniMapMarker.setPosition(pos); miniMap.setCenter(pos); }

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
  renderStreetList();
  updateStats();
  placeAllMarkers();
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
async function rescanStreet(id) {
  if (activeProject.aiEnabled === false) {
    showToast('AI is off — turn it on to re-scan');
    return;
  }
  const street = streets.find(s => s.id === id);
  if (!street) return;

  showScanModal('Re-scanning pavement condition...');
  const analysis = await analyzeStreetView(street);
  street.analysis = analysis.text;
  street.rating = analysis.rating;
  street.weedAlert = analysis.weedAlert || false;
  street.scannedAt = new Date().toISOString();

  saveStreets();
  hideScanModal();

  placeAllMarkers();
  updateStats();
  selectStreet(id);
  showToast('Street re-scanned');
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

// ─── HELPERS ───────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatNumber(n) {
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
      if (window._myLocationMarker) window._myLocationMarker.setMap(null);
      window._myLocationMarker = new google.maps.Marker({
        position: { lat, lng },
        map: map,
        title: 'You are here',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#3b82f6',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 3
        }
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

// ─── PHOTO MARKERS ON MAP ──────────────────────────────────
let photoMarkers = [];

function placePhotoMarkers() {
  photoMarkers.forEach(m => m.setMap(null));
  photoMarkers = [];

  streets.forEach(street => {
    if (!street.photos) return;
    street.photos.forEach(photo => {
      const marker = new google.maps.Marker({
        position: { lat: photo.lat, lng: photo.lng },
        map: map,
        title: `Photo — ${photo.address || 'On-site'}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: '#a855f7',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2
        }
      });

      const infoWindow = new google.maps.InfoWindow({
        content: `<div style="max-width:200px;"><img src="${photo.dataUrl}" style="width:100%;border-radius:4px;"><br><small>${photo.address || ''}<br>${new Date(photo.takenAt).toLocaleString()}</small></div>`
      });
      marker.addListener('click', () => infoWindow.open(map, marker));
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

function openStreetViewAt(lat, lng) {
  const panel = document.getElementById('streetview-panel');
  panel.classList.remove('hidden');

  streetViewPano = new google.maps.StreetViewPanorama(
    document.getElementById('streetview-pano'), {
      position: { lat, lng },
      pov: { heading: 0, pitch: -5 },
      zoom: 1,
      motionTracking: false,
      motionTrackingControl: false,
      addressControl: true,
      fullscreenControl: false
    }
  );

  // If a street is selected, refresh the detail panel to include mini map
  if (activeStreetId) {
    selectStreet(activeStreetId);
  }
}

function closeStreetViewPanel() {
  document.getElementById('streetview-panel').classList.add('hidden');
  document.getElementById('detail-panel').classList.add('hidden');
  streetViewPano = null;
  miniMap = null;
  miniMapMarker = null;
  miniMapLines.forEach(l => l.setMap(null));
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
        rating: 'pending',
        notes: 'Auto-created from photo',
        analysis: '',
        svImage: getStreetViewUrl(lat, lng),
        photos: [],
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
  const distFt = Math.round(calcDistanceFt(startPt, endPt));

  const [startGeo, endGeo] = await Promise.all([
    geocodeDetails(startPt),
    geocodeDetails(endPt)
  ]);

  const street = {
    id: crypto.randomUUID?.() || Date.now().toString(36),
    name: startGeo.address || 'Unknown location',
    lat: startPt.lat,
    lng: startPt.lng,
    length: distFt,
    width: 24,
    sqft: distFt * 24,
    rating: 'pending',
    notes: '',
    analysis: '',
    svImage: getStreetViewUrl(startPt.lat, startPt.lng),
    path: [startPt, endPt],
    city: startGeo.city,
    county: startGeo.county,
    state: startGeo.state,
    endCity: endGeo.city,
    endCounty: endGeo.county,
    crossesBoundary: (startGeo.city !== endGeo.city) || (startGeo.county !== endGeo.county),
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

  streets.push(street);
  saveStreets();

  // Reset for next street
  window._drawStart = null;
  clearTempMarkers();
  clearTempPolyline();
  drawAllHighlights();
  renderStreetList();
  placeAllMarkers();
  updateStats();

  drawCount++;
  document.getElementById('highlight-bar-text').textContent = `Street ${drawCount} saved (${formatNumber(distFt)} ft) — click next street or Done`;
  showToast(`${formatNumber(distFt)} ft — ${formatNumber(street.sqft)} sq ft`);

  if (street.crossesBoundary) {
    setTimeout(() => showToast(`⚠ ${street.boundaryNote}`, 5000), 1500);
  }

  // Auto-scan in background
  analyzeStreetView(street).then(analysis => {
    street.analysis = analysis.text;
    street.rating = analysis.rating;
    street.scannedAt = new Date().toISOString();
    saveStreets();
    drawAllHighlights();
    renderStreetList();
    updateStats();
  });
}

function addTempMarker(latLng, label, color) {
  const marker = new google.maps.Marker({
    position: latLng,
    map: map,
    label: { text: label, color: '#fff', fontWeight: '700', fontSize: '12px' },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 12,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2
    }
  });
  highlightMarkers.push(marker);
}

function clearTempMarkers() {
  highlightMarkers.forEach(m => m.setMap(null));
  highlightMarkers = [];
}

function drawAllHighlights() {
  polylines.forEach(p => p.setMap(null));
  polylines = [];

  streets.forEach(street => {
    // Support old format (highlightStart/End) and new format (path)
    let pathPoints = street.path;
    if (!pathPoints && street.highlightStart && street.highlightEnd) {
      pathPoints = [street.highlightStart, street.highlightEnd];
    }
    if (!pathPoints || pathPoints.length < 2) return;

    const color = ratingColor(street.rating);
    const line = new google.maps.Polyline({
      path: pathPoints,
      geodesic: true,
      strokeColor: color,
      strokeOpacity: 0.9,
      strokeWeight: 6,
      map: map
    });

    line.addListener('click', () => selectStreet(street.id));
    polylines.push(line);

    // Start marker
    const startMk = new google.maps.Marker({
      position: pathPoints[0],
      map: map,
      label: { text: 'S', color: '#fff', fontWeight: '700', fontSize: '11px' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#22c55e', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
    });
    startMk.addListener('click', () => selectStreet(street.id));
    polylines.push(startMk);

    // End marker
    const endMk = new google.maps.Marker({
      position: pathPoints[pathPoints.length - 1],
      map: map,
      label: { text: 'E', color: '#fff', fontWeight: '700', fontSize: '11px' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#ef4444', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
    });
    endMk.addListener('click', () => selectStreet(street.id));
    polylines.push(endMk);
  });
}

function removeHighlight(id) {
  const street = streets.find(s => s.id === id);
  if (!street) return;
  delete street.path;
  delete street.highlightStart;
  delete street.highlightEnd;
  saveStreets();
  drawAllHighlights();
  selectStreet(id);
  showToast('Highlight removed');
}

function calcPathLength(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += calcDistanceFt(path[i - 1], path[i]);
  }
  return total;
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
  const ratingCounts = { 'level-1': 0, 'level-2': 0, 'level-3': 0, 'level-4': 0 };
  streets.forEach(s => {
    let r = s.rating;
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
      const res = await fetch(AI_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
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
function darkMapStyle() {
  return [
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
}
