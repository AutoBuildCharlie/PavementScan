/* ================================================================
   PAVEMENTSCAN MOBILE — mobile.js
   All logic for the Google Maps-style mobile interface.
   Shares localStorage with the desktop app.
   ================================================================ */

// ─── CONSTANTS ────────────────────────────────────────────
const PROXY = 'https://cse-worker.aestheticcal22.workers.dev';
const MAP_ID = 'f2e86140855a96ecc6c0576f';
const USERS  = { 'Cal.Zentara': '0911' };

// ─── STATE ────────────────────────────────────────────────
let map, panorama;
let projects = [], activeProject = null;
let activeStreetId = null;
let polylines = [], markers = [];
let _pinMode = false, _pinStart = null, _pinLine = null;
let _svStreetId = null, _svPhotoIndex = null, _svIsRetake = false;
let _lbPhotos = [], _lbIdx = 0, _lbStreetId = null, _lbArray = null;
let _photoStreetId = null, _rrPhotoStreetId = null;
let _pendingStreet = null;
let _sheetState = 'peek'; // peek | half | full
let _mobileTab = 'overview';
let _sheetDragStartY = null, _sheetStartTranslate = null;
let _animInterval = null;

// ─── AUTH ──────────────────────────────────────────────────
function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value;
  if (USERS[u] && USERS[u] === p) {
    sessionStorage.setItem('cse_auth', '1');
    document.getElementById('login-screen').style.display = 'none';
    initMap();
  } else {
    document.getElementById('login-error').classList.remove('hidden');
  }
}

// ─── MAP INIT ──────────────────────────────────────────────
function initMap() {
  if (!sessionStorage.getItem('cse_auth')) {
    // Hide splash immediately — login screen needs to be visible
    const splash = document.getElementById('loading-splash');
    if (splash) { splash.classList.add('hidden'); setTimeout(() => splash.remove(), 300); }
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    return;
  }
  document.getElementById('login-screen').style.display = 'none';

  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 33.835, lng: -117.914 },
    zoom: 14,
    disableDefaultUI: true,
    gestureHandling: 'greedy',
    clickableIcons: false,
    styles: [
      { elementType: 'geometry', stylers: [{ color: '#0d1117' }] },
      { elementType: 'labels.text.fill', stylers: [{ color: '#94a3b8' }] },
      { elementType: 'labels.text.stroke', stylers: [{ color: '#0d1117' }] },
      { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1e293b' }] },
      { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#0a0e1a' }] },
      { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#94a3b8' }] },
      { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2d3f55' }] },
      { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#cbd5e1' }] },
      { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a1628' }] },
      { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4b6a8a' }] },
      { featureType: 'poi', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', stylers: [{ visibility: 'off' }] },
      { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0f172a' }] },
      { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#1e293b' }] },
      { featureType: 'administrative', elementType: 'labels.text.fill', stylers: [{ color: '#64748b' }] },
    ],
  });

  map.addListener('click', e => handleMapClick(e.latLng));
  map.addListener('rightclick', () => cancelPin());

  // Hide splash once map tiles load, or after 8s max — never freeze
  const hideSplash = () => {
    const splash = document.getElementById('loading-splash');
    if (splash) { splash.classList.add('hidden'); setTimeout(() => splash.remove(), 500); }
  };
  google.maps.event.addListenerOnce(map, 'tilesloaded', hideSplash);
  setTimeout(hideSplash, 8000);

  loadProjects();
  initBottomSheet();
  initWorkerDrag();
  initPullToRefresh();

  // Start collapsed — user swipes up when they need it
  setTimeout(() => setSheetState('peek'), 400);

  // Auto-center on user's location on load
  setTimeout(() => goToMyLocation(), 800);
}

// ─── PROJECTS ──────────────────────────────────────────────
function loadProjects() {
  try { projects = JSON.parse(localStorage.getItem('cse_projects') || '[]'); } catch { projects = []; }
  const activeId = localStorage.getItem('cse_active_project');

  // Migrate defaults
  projects.forEach(p => {
    if (!p.photoInterval) p.photoInterval = 200;
    if (!p.maxPhotos) p.maxPhotos = 6;
    if (p.aiEnabled === undefined) p.aiEnabled = false;
    if (!p.scanModel) p.scanModel = 'gpt-4o';
    if (!p.type) p.type = 'crack-seal';
    if (!p.streets) p.streets = [];
  });

  if (!projects.length) {
    projects = [createProject('My First Project', 'crack-seal')];
  }
  activeProject = projects.find(p => p.id === activeId) || projects[0];
  renderAll();
}

function saveProjects() {
  localStorage.setItem('cse_projects', JSON.stringify(projects));
  localStorage.setItem('cse_active_project', activeProject.id);
}

function createProject(name, type = 'crack-seal') {
  return {
    id: crypto.randomUUID(), name, type,
    streets: [], createdAt: new Date().toISOString(),
    photoInterval: 200, maxPhotos: 6,
    aiEnabled: false, scanModel: 'gpt-4o',
    aiNotes: '', detectRR: true, includeWideCracks: false,
    detectLaneLayout: false,
  };
}

function switchProject(id) {
  activeProject = projects.find(p => p.id === id) || activeProject;
  localStorage.setItem('cse_active_project', activeProject.id);
  activeStreetId = null;
  closeProjectSheet();
  renderAll();
  setSheetState('peek');
  showListView();
}

function clearAllData() {
  if (!confirm('Delete ALL projects and data? This cannot be undone.')) return;
  localStorage.removeItem('cse_projects');
  localStorage.removeItem('cse_active_project');
  localStorage.removeItem('cse_global_settings');
  sessionStorage.removeItem('cse_auth');
  location.reload();
}

function importProject(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const project = JSON.parse(ev.target.result);
      if (!project.id || !project.name || !Array.isArray(project.streets)) {
        showToast('Invalid project file'); return;
      }
      // Replace if same ID exists, otherwise add
      const idx = projects.findIndex(p => p.id === project.id);
      if (idx >= 0) projects[idx] = project;
      else projects.push(project);
      activeProject = project;
      localStorage.setItem('cse_active_project', project.id);
      saveProjects();
      renderAll();
      closeProjectSheet();
      showToast('Project imported: ' + project.name);
    } catch {
      showToast('Could not read file');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

function promptNewProject() {
  const name = prompt('Project name:');
  if (!name?.trim()) return;
  const type = confirm('Slurry Seal project? (Cancel = Crack Seal)') ? 'slurry' : 'crack-seal';
  const proj = createProject(name.trim(), type);
  projects.push(proj);
  activeProject = proj;
  saveProjects();
  closeProjectSheet();
  renderAll();
  showToast('Project created');
}

function getStreets() { return activeProject?.streets || []; }

// ─── RENDER ALL ────────────────────────────────────────────
function renderAll() {
  renderProjectChip();
  renderStreetList();
  renderProjectList();
  drawAllPolylines();
  renderMarkers();
  updateStats();
}

function renderProjectChip() {
  const el = document.getElementById('project-chip-name');
  if (el) el.textContent = activeProject?.name || 'No Project';
}

let _streetFilter = '';

function filterStreetList(query) {
  _streetFilter = query.toLowerCase();
  renderStreetList();
}

function renderStreetList() {
  const el = document.getElementById('mobile-street-list');
  let streets = getStreets();

  // Filter by search query
  if (_streetFilter) {
    streets = streets.filter(s => s.name.toLowerCase().includes(_streetFilter));
  }

  if (!getStreets().length) {
    el.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--text-dim);font-size:13px">No streets yet.<br>Tap 📍 to pin a street or use Add Street.</div>`;
    return;
  }
  if (!streets.length) {
    el.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--text-dim);font-size:13px">No streets match "${escHtml(_streetFilter)}"</div>`;
    return;
  }

  el.innerHTML = streets.map(s => {
    const rc = ratingClass(s.rating);
    const badge = ratingLabel(s.rating);
    const sqft = s.sqft ? `${formatNum(s.sqft)} sqft` : '';
    const photoCount = (s.photos?.length || 0) + (s.scanPhotos?.length || 0);
    return `<div class="mobile-street-item swipe-item" data-id="${s.id}"
        ontouchstart="swipeStart(event,this)" ontouchmove="swipeMove(event,this)" ontouchend="swipeEnd(event,this,'${s.id}')"
        onclick="openStreet('${s.id}')">
      <div class="swipe-content">
        <div class="street-item-rating ${rc}"></div>
        <div class="street-item-info">
          <div class="street-item-name">${escHtml(s.name)}</div>
          <div class="street-item-meta">${sqft}${sqft && photoCount ? ' · ' : ''}${photoCount ? photoCount + ' photos' : ''}</div>
        </div>
        <div class="street-item-badge" style="background:${ratingBg(s.rating)};color:${ratingColor(s.rating)}">${badge}</div>
      </div>
      <div class="swipe-delete" onclick="swipeDeleteStreet('${s.id}')">Delete</div>
    </div>`;
  }).join('');
}

function renderProjectList() {
  const el = document.getElementById('project-list-mobile');
  if (!el) return;
  el.innerHTML = projects.map(p => `
    <div class="project-mobile-item" onclick="switchProject('${p.id}')">
      <div>
        <div class="project-mobile-name">${escHtml(p.name)}</div>
        <div class="project-mobile-meta">${p.streets?.length || 0} streets · ${p.type === 'slurry' ? 'Slurry' : p.type === 'both' ? 'Both' : 'Crack Seal'}</div>
      </div>
      ${p.id === activeProject?.id ? '<span class="project-mobile-check">✓</span>' : ''}
    </div>`).join('');
}

function updateStats() {
  const streets = getStreets();
  const sqft = streets.reduce((a, s) => a + (s.sqft || 0), 0);
  const rated = streets.filter(s => s.rating);
  const avgR = rated.length ? (rated.reduce((a, s) => a + parseInt(s.rating?.replace('level-', '') || 0), 0) / rated.length).toFixed(1) : '—';
  const el = document.getElementById('sheet-stats');
  if (el) el.innerHTML = `
    <div class="stat-chip">Streets <span>${streets.length}</span></div>
    <div class="stat-chip">Sq Ft <span>${formatNum(sqft)}</span></div>
    <div class="stat-chip">Avg Rating <span>${avgR}</span></div>`;
}

// ─── BOTTOM SHEET ──────────────────────────────────────────
function initBottomSheet() {
  const sheet = document.getElementById('bottom-sheet');
  const handle = document.getElementById('sheet-handle-wrap');

  handle.addEventListener('touchstart', onSheetDragStart, { passive: true });
  handle.addEventListener('mousedown', onSheetDragStart);

  document.addEventListener('touchmove', onSheetDrag, { passive: false });
  document.addEventListener('mousemove', onSheetDrag);

  document.addEventListener('touchend', onSheetDragEnd);
  document.addEventListener('mouseup', onSheetDragEnd);
}

function getSheetTranslate() {
  const sheet = document.getElementById('bottom-sheet');
  const h = sheet.offsetHeight;
  if (_sheetState === 'full') return 0;
  if (_sheetState === 'half') return h * 0.5;
  return h - 120; // peek
}

function setSheetState(state) {
  _sheetState = state;
  const sheet = document.getElementById('bottom-sheet');
  sheet.classList.remove('peek', 'half', 'full');
  sheet.classList.add(state);
  sheet.style.transform = '';
  // Hide FABs when sheet is full
  const fabs = document.getElementById('fab-group');
  if (fabs) fabs.classList.toggle('fabs-hidden', state === 'full');
  // Update handle color to active street rating
  updateHandleColor();
}

function updateHandleColor() {
  const handle = document.getElementById('sheet-handle');
  if (!handle) return;
  const s = activeStreetId ? getStreets().find(s => s.id === activeStreetId) : null;
  handle.style.background = s?.rating ? ratingColor(s.rating) : '';
}

function onSheetDragStart(e) {
  const touch = e.touches ? e.touches[0] : e;
  _sheetDragStartY = touch.clientY;
  const sheet = document.getElementById('bottom-sheet');
  _sheetStartTranslate = getSheetTranslate();
  sheet.style.transition = 'none';
}

function onSheetDrag(e) {
  if (_sheetDragStartY === null) return;
  const touch = e.touches ? e.touches[0] : e;
  const delta = touch.clientY - _sheetDragStartY;
  const sheet = document.getElementById('bottom-sheet');
  const newT = Math.max(0, _sheetStartTranslate + delta);
  sheet.style.transform = `translateY(${newT}px)`;
  if (e.cancelable) e.preventDefault();
}

function onSheetDragEnd(e) {
  if (_sheetDragStartY === null) return;
  const touch = e.changedTouches ? e.changedTouches[0] : e;
  const delta = touch.clientY - _sheetDragStartY;
  const sheet = document.getElementById('bottom-sheet');
  sheet.style.transition = '';

  if (delta < -40) {
    // dragged up
    if (_sheetState === 'peek') setSheetState('half');
    else setSheetState('full');
  } else if (delta > 40) {
    // dragged down
    if (_sheetState === 'full') setSheetState('half');
    else setSheetState('peek');
  } else {
    // snap back
    sheet.classList.remove('peek', 'half', 'full');
    sheet.classList.add(_sheetState);
    sheet.style.transform = '';
  }
  _sheetDragStartY = null;
}

function showListView() {
  document.getElementById('view-list').classList.remove('hidden');
  document.getElementById('view-detail').classList.add('hidden');
}

function showDetailView() {
  document.getElementById('view-list').classList.add('hidden');
  document.getElementById('view-detail').classList.remove('hidden');
}

// ─── STREET DETAIL ─────────────────────────────────────────
function openStreet(id) {
  activeStreetId = id;
  _mobileTab = 'overview';
  showDetailView();
  renderStreetDetail();
  setSheetState('half');
  // Animate the street on map
  drawAllPolylines();
  // Pan map to street
  const s = getStreets().find(s => s.id === id);
  if (s) {
    map.panTo({ lat: s.lat, lng: s.lng });
  }
}

function backToList() {
  activeStreetId = null;
  showListView();
  drawAllPolylines();
}

function renderStreetDetail() {
  const s = getStreets().find(s => s.id === activeStreetId);
  if (!s) return;

  // Header
  const hdr = document.getElementById('detail-header-mobile');
  hdr.innerHTML = `
    <button class="detail-back" onclick="backToList()">← Streets</button>
    <div class="detail-mobile-name">${escHtml(s.name)}</div>
    <div class="detail-mobile-meta">
      <span class="detail-rating-badge" style="background:${ratingBg(s.rating)};color:${ratingColor(s.rating)}">${ratingLabel(s.rating)}</span>
      ${s.roadType ? `<span style="font-size:11px;color:var(--text-dim)">${capitalize(s.roadType)}</span>` : ''}
    </div>`;

  // Tab count badge
  const photoCount = (s.photos?.length || 0) + (s.rrPhotos?.length || 0) + (s.scanPhotos?.length || 0);
  const badge = document.getElementById('mobile-photo-count');
  if (badge) badge.textContent = photoCount || '';

  // Active tab
  document.querySelectorAll('.mobile-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === _mobileTab));

  renderMobileTab();
}

function switchMobileTab(tab) {
  _mobileTab = tab;
  document.querySelectorAll('.mobile-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  renderMobileTab();
}

function renderMobileTab() {
  const s = getStreets().find(s => s.id === activeStreetId);
  if (!s) return;
  const el = document.getElementById('mobile-tab-content');

  if (_mobileTab === 'overview') el.innerHTML = renderOverviewTab(s);
  else if (_mobileTab === 'photos') el.innerHTML = renderPhotosTab(s);
  else if (_mobileTab === 'analysis') el.innerHTML = renderAnalysisTab(s);
}

function renderOverviewTab(s) {
  const sqft = s.sqft || (s.length && s.width ? s.length * s.width : 0);
  const sy = sqft ? Math.round(sqft / 9) : 0;
  const treatment = getTreatment(s.rating, activeProject?.type);
  let alerts = '';
  if (s.weedAlert) alerts += `<div class="mobile-alert weed">🌿 Weed/Grass Detected${s.weedNotes ? '<br><span style="font-weight:400;font-size:11px">'+escHtml(s.weedNotes)+'</span>' : ''}</div>`;
  if (s.ravelingAlert) alerts += `<div class="mobile-alert raveling">⚠ Raveling Detected</div>`;
  if (s.rrAlert) alerts += `<div class="mobile-alert rr">🔧 R&amp;R Recommended</div>`;

  return `
    ${alerts}
    <div class="mobile-stat-grid">
      <div class="mobile-stat-card">
        <div class="mobile-stat-label">Sq Ft</div>
        <div class="mobile-stat-value">${formatNum(sqft)}</div>
      </div>
      <div class="mobile-stat-card">
        <div class="mobile-stat-label">Sq Yards</div>
        <div class="mobile-stat-value">${formatNum(sy)}</div>
      </div>
      <div class="mobile-stat-card">
        <div class="mobile-stat-label">Length</div>
        <div class="mobile-stat-value">${s.length ? formatNum(s.length) + ' ft' : '—'}</div>
      </div>
      <div class="mobile-stat-card">
        <div class="mobile-stat-label">Width</div>
        <div class="mobile-stat-value">${s.width ? s.width + ' ft' : '—'}</div>
      </div>
    </div>
    <div class="mobile-stat-card" style="margin-bottom:10px">
      <div class="mobile-stat-label">Treatment</div>
      <div style="font-size:14px;font-weight:600;margin-top:4px">${treatment}</div>
    </div>
    <div class="form-group" style="margin:12px 0">
      <label>Rating</label>
      <select class="mobile-rating-select" onchange="setMobileRating('${s.id}', this.value)">
        <option value="">— Not rated —</option>
        <option value="level-1" ${s.rating==='level-1'?'selected':''}>LVL 1 — Good</option>
        <option value="level-2" ${s.rating==='level-2'?'selected':''}>LVL 2 — Light cracks</option>
        <option value="level-3" ${s.rating==='level-3'?'selected':''}>LVL 3 — Heavy cracks</option>
        <option value="level-4" ${s.rating==='level-4'?'selected':''}>LVL 4 — Alligator</option>
      </select>
    </div>
    <div class="mobile-actions">
      <button class="mobile-action-btn" onclick="rescanMobile('${s.id}')">🔄 Re-scan</button>
      <button class="mobile-action-btn" onclick="openSVAt(${s.lat},${s.lng})">📍 Street View</button>
    </div>
    <div class="mobile-actions">
      <button class="mobile-action-btn danger" onclick="deleteMobileStreet('${s.id}')">🗑 Delete Street</button>
    </div>`;
}

function renderPhotosTab(s) {
  let html = '';

  // Street View thumbnail
  if (s.svImage) {
    html += `<p class="photo-section-title">Street View Thumbnail</p>
      <img src="${escHtml(s.svImage)}" class="mobile-photo-thumb" style="width:100%;height:140px;border-radius:10px;object-fit:cover;margin-bottom:8px" onclick="openSVAt(${s.lat},${s.lng})">`;
  }

  // On-site photos
  html += `<p class="photo-section-title">On-Site Photos</p>`;
  if (s.photos?.length) {
    html += `<div class="mobile-photo-grid">` + s.photos.map((p, i) =>
      `<img src="${p.dataUrl}" class="mobile-photo-thumb" onclick="openLightboxMobile('${s.id}','photos',${i})" loading="lazy">`
    ).join('') + `</div>`;
  }
  html += `<button class="btn-add-photo" onclick="startPhotoFor('${s.id}')">+ Add Photo</button>`;

  // R&R photos
  if (activeProject?.detectRR) {
    html += `<p class="photo-section-title">R&amp;R Photos</p>`;
    if (s.rrPhotos?.length) {
      html += `<div class="mobile-photo-grid">` + s.rrPhotos.map((p, i) =>
        `<img src="${p.dataUrl}" class="mobile-photo-thumb" onclick="openLightboxMobile('${s.id}','rrPhotos',${i})" loading="lazy">`
      ).join('') + `</div>`;
    }
    html += `<button class="btn-add-photo" onclick="startRRPhotoFor('${s.id}')">+ Add R&amp;R Photo</button>`;
  }

  // Scan photos
  if (s.scanPhotos?.length) {
    html += `<p class="photo-section-title">AI Scan Photos (${s.scanPhotos.length})</p>
      <div class="mobile-photo-grid">` +
      s.scanPhotos.map((p, i) =>
        `<img src="${p.dataUrl || p.url}" class="mobile-photo-thumb" onclick="openLightboxMobile('${s.id}','scanPhotos',${i})" loading="lazy">`
      ).join('') + `</div>`;
  }

  return html;
}

function renderAnalysisTab(s) {
  if (!s.analysis) return `<div style="color:var(--text-dim);font-size:13px;padding:16px 0">No analysis yet. Tap Re-scan to analyze this street.</div>`;

  const lines = s.analysis.split('\n');
  let html = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { html += '<div style="height:8px"></div>'; continue; }
    // Skip level line — shown in header
    if (line.match(/Level:\s*\[?[1-4]\]?/i) || line.match(/^Level\s*[1-4]\s*[—\-]/i)) continue;
    // Section header
    const sec = line.match(/^(\d+)\.\s+([A-Z][A-Z\s\/&']+)(:.*)?$/);
    if (sec) { html += `<div class="analysis-section-title">${sec[2].trim()}</div>`; continue; }
    // Key-value
    const kv = line.match(/^([^:]{3,40}):\s+(.+)$/);
    if (kv && !line.startsWith('–') && !line.startsWith('-')) {
      html += `<div class="analysis-kv"><span class="analysis-kv-label">${escHtml(kv[1])}</span><span class="analysis-kv-value">${escHtml(kv[2])}</span></div>`;
      continue;
    }
    // Bullet
    if (line.startsWith('–') || line.startsWith('-') || line.startsWith('•')) {
      html += `<div class="analysis-bullet">${escHtml(line.replace(/^[–\-•]\s*/, ''))}</div>`;
      continue;
    }
    html += `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">${escHtml(line)}</div>`;
  }

  // Admin notes
  html += `<div class="analysis-section-title" style="margin-top:16px">Admin Notes</div>`;
  html += `<div style="font-size:13px;color:var(--text-dim)">${s.adminNotes ? escHtml(s.adminNotes) : 'No notes.'}</div>`;

  return html;
}

// ─── RATING ACTIONS ────────────────────────────────────────
function setMobileRating(id, rating) {
  const s = getStreets().find(s => s.id === id);
  if (!s) return;
  if (s.aiRating && s.aiRating !== rating && rating) logCalibration(s, s.aiRating, rating);
  s.rating = rating || null;
  saveProjects();
  drawAllPolylines();
  renderStreetDetail();
  updateStats();
}

// ─── POLYLINES ─────────────────────────────────────────────
function drawAllPolylines() {
  polylines.forEach(p => p.setMap(null));
  polylines = [];
  if (_animInterval) { clearInterval(_animInterval); _animInterval = null; }

  getStreets().forEach(s => {
    if (!s.path?.length) return;
    const points = s.path;
    const color = ratingColor(s.rating);
    const isActive = s.id === activeStreetId;

    // Wide invisible tap target
    const tap = new google.maps.Polyline({
      path: points, geodesic: true,
      strokeColor: color, strokeOpacity: 0.001, strokeWeight: 30, map,
      zIndex: 2, clickable: true
    });
    tap.addListener('click', () => { openStreet(s.id); setSheetState('half'); });
    polylines.push(tap);

    // Glow
    const glow = new google.maps.Polyline({
      path: points, geodesic: true,
      strokeColor: color, strokeOpacity: 0.08, strokeWeight: 10, map,
      zIndex: 3
    });
    glow.addListener('click', () => { openStreet(s.id); setSheetState('half'); });
    polylines.push(glow);

    // Main line
    const line = new google.maps.Polyline({
      path: points, geodesic: true,
      strokeColor: color,
      strokeOpacity: isActive ? 0.35 : 0.32,
      strokeWeight: isActive ? 6 : 5,
      map, zIndex: isActive ? 20 : 5
    });
    line.addListener('click', () => openStreet(s.id));
    polylines.push(line);

    if (isActive) {
      const outerGlow = new google.maps.Polyline({ path: points, geodesic: true, strokeColor: color, strokeOpacity: 0.08, strokeWeight: 20, map, zIndex: 17 });
      const innerGlow = new google.maps.Polyline({ path: points, geodesic: true, strokeColor: '#ffffff', strokeOpacity: 0.1, strokeWeight: 12, map, zIndex: 18 });
      outerGlow.addListener('click', () => openStreet(s.id));
      innerGlow.addListener('click', () => openStreet(s.id));
      polylines.push(outerGlow, innerGlow);
      let _t = 0;
      _animInterval = setInterval(() => {
        _t += 0.0225;
        const pulse = (Math.sin(_t) + 1) / 2;
        outerGlow.setOptions({ strokeOpacity: 0.08 + pulse * 0.52 });
        innerGlow.setOptions({ strokeOpacity: 0.1 + pulse * 0.5 });
      }, 16);
    }
  });
}

function renderMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
  getStreets().forEach(s => {
    if (!s.lat || !s.lng) return;
    if (!(s.photos?.length || s.rrPhotos?.length)) return;
    const m = new google.maps.Marker({
      position: { lat: s.lat, lng: s.lng }, map,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#f59e0b', fillOpacity: 1, strokeWeight: 2, strokeColor: '#fff' },
      title: s.name
    });
    m.addListener('click', () => openStreet(s.id));
    markers.push(m);
  });
}

// ─── PIN MODE ──────────────────────────────────────────────
function togglePinMode() {
  if (_pinMode && _pinStart) { cancelPin(); return; }
  _pinMode = !_pinMode;
  document.getElementById('fab-pin').classList.toggle('pinning', _pinMode);
  const bar = document.getElementById('pin-bar');
  if (_pinMode) {
    bar.classList.remove('hidden');
    document.getElementById('pin-bar-text').textContent = 'Tap the START of the street';
    _pinStart = null;
  } else {
    bar.classList.add('hidden');
    if (_pinLine) { _pinLine.setMap(null); _pinLine = null; }
  }
}

function cancelPin() {
  _pinMode = false; _pinStart = null;
  document.getElementById('fab-pin').classList.remove('pinning');
  document.getElementById('pin-bar').classList.add('hidden');
  if (_pinLine) { _pinLine.setMap(null); _pinLine = null; }
}

function handleMapClick(latLng) {
  if (!_pinMode) return;
  if (!_pinStart) {
    _pinStart = latLng;
    document.getElementById('pin-bar-text').textContent = 'Now tap the END of the street';
    new google.maps.Marker({ position: latLng, map, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#22c55e', fillOpacity: 1, strokeWeight: 2, strokeColor: '#fff' } });
  } else {
    const start = _pinStart, end = latLng;
    _pinLine = new google.maps.Polyline({
      path: [start, end], geodesic: true,
      strokeColor: '#f59e0b', strokeOpacity: 0.7, strokeWeight: 4, map
    });
    polylines.push(_pinLine);
    cancelPin();
    // Geocode midpoint for name suggestion
    const mid = { lat: (start.lat() + end.lat()) / 2, lng: (start.lng() + end.lng()) / 2 };
    const gc = new google.maps.Geocoder();
    gc.geocode({ location: mid }, (res, status) => {
      let suggested = '';
      if (status === 'OK' && res[0]) {
        const comp = res[0].address_components;
        const route = comp.find(c => c.types.includes('route'));
        suggested = route?.long_name || res[0].formatted_address;
      }
      _pendingStreet = {
        id: crypto.randomUUID(),
        lat: mid.lat, lng: mid.lng,
        path: [{ lat: start.lat(), lng: start.lng() }, { lat: end.lat(), lng: end.lng() }],
        length: Math.round(calcDistanceFt(
          { lat: start.lat(), lng: start.lng() },
          { lat: end.lat(), lng: end.lng() }
        )),
      };
      openNameSheet(suggested);
    });
  }
}

// ─── SCAN SHEET ────────────────────────────────────────────
function openScanSheet() {
  document.getElementById('scan-sheet-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('scan-street-name')?.focus(), 100);
}

function useMyLocationForScan() {
  if (!navigator.geolocation) { showToast('Geolocation not supported'); return; }
  const btn = document.getElementById('btn-use-location');
  if (btn) { btn.textContent = 'Getting location…'; btn.disabled = true; }
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    const gc = new google.maps.Geocoder();
    gc.geocode({ location: { lat, lng } }, (res, status) => {
      if (btn) { btn.textContent = '📍 Use My Location'; btn.disabled = false; }
      if (status === 'OK' && res[0]) {
        const comp = res[0].address_components;
        const route = comp.find(c => c.types.includes('route'));
        const name = route?.long_name || res[0].formatted_address;
        document.getElementById('scan-street-name').value = name;
      }
    });
  }, () => {
    if (btn) { btn.textContent = '📍 Use My Location'; btn.disabled = false; }
    showToast('Could not get location');
  }, { enableHighAccuracy: true });
}
function closeScanSheet(e) {
  if (e && e.target !== document.getElementById('scan-sheet-overlay')) return;
  document.getElementById('scan-sheet-overlay').classList.add('hidden');
}
function submitScanSheet() {
  const name = document.getElementById('scan-street-name').value.trim();
  const length = parseInt(document.getElementById('scan-street-length').value) || 0;
  const notes = document.getElementById('scan-street-notes').value.trim();
  if (!name) { showToast('Enter a street name'); return; }
  closeScanSheet();
  addStreetByAddress(name, length, notes);
}

async function addStreetByAddress(address, lengthFt, notes) {
  showScanning('Geocoding address…');
  try {
    const latLng = await geocodeAddress(address);
    const roadType = await detectRoadType(latLng.lat, latLng.lng);
    const width = roadTypeWidth(roadType);
    const length = lengthFt || 300;
    const sqft = length * width;

    const street = {
      id: crypto.randomUUID(),
      name: address, lat: latLng.lat, lng: latLng.lng,
      length, width, sqft, roadType, notes,
      rating: null, analysis: '', aiRating: null,
      photos: [], rrPhotos: [], scanPhotos: [],
      path: [], weedAlert: false, ravelingAlert: false, rrAlert: false,
      createdAt: new Date().toISOString(),
    };

    activeProject.streets.push(street);
    saveProjects();
    map.panTo({ lat: latLng.lat, lng: latLng.lng });

    if (false) {
      await analyzeStreet(street);
    } else {
      hideScanning();
      renderAll();
      openStreet(street.id);
    }
  } catch (e) {
    hideScanning();
    showToast('Could not find that address');
    console.error(e);
  }
}

// ─── NAME SHEET ────────────────────────────────────────────
function openNameSheet(suggested = '') {
  const overlay = document.getElementById('name-sheet-overlay');
  const input = document.getElementById('name-sheet-input');
  overlay.classList.remove('hidden');
  input.value = suggested;
  setTimeout(() => input.focus(), 100);
}
function closeNameSheet(e) {
  if (e && e.target !== document.getElementById('name-sheet-overlay')) return;
  document.getElementById('name-sheet-overlay').classList.add('hidden');
  _pendingStreet = null;
}
function confirmNameSheet() {
  const name = document.getElementById('name-sheet-input').value.trim();
  if (!name || !_pendingStreet) { closeNameSheet(); return; }
  document.getElementById('name-sheet-overlay').classList.add('hidden');

  const s = _pendingStreet;
  s.name = name;
  s.rating = null; s.analysis = ''; s.aiRating = null;
  s.photos = []; s.rrPhotos = []; s.scanPhotos = [];
  s.weedAlert = false; s.ravelingAlert = false; s.rrAlert = false;
  s.createdAt = new Date().toISOString();
  _pendingStreet = null;

  // Detect road type before scan
  detectRoadType(s.lat, s.lng).then(rt => {
    s.roadType = rt;
    s.width = roadTypeWidth(rt);
    s.sqft = (s.length || 300) * s.width;
    saveProjects();
  }).catch(() => {
    s.roadType = 'residential'; s.width = 36; s.sqft = (s.length || 300) * 36;
  });

  activeProject.streets.push(s);
  saveProjects();
  drawAllPolylines();

  if (false) {
    showScanning('Scanning Street View…');
    analyzeStreet(s).catch(e => { console.error(e); hideScanning(); showToast('Scan failed'); });
  } else {
    renderAll();
    openStreet(s.id);
  }
}

// ─── AI SCANNING ───────────────────────────────────────────
async function analyzeStreet(street) {
  showScanning('Pulling Street View imagery…');
  try {
    // Detect road type for pin-mode streets that don't have it yet
    if (!street.roadType || street.roadType === 'residential') {
      try {
        const rt = await detectRoadType(street.lat, street.lng);
        street.roadType = rt;
        street.width = roadTypeWidth(rt);
        street.sqft = (street.length || 300) * street.width;
      } catch {}
    }

    const points = getSamplePoints(street);
    if (!points.length) {
      street.analysis = 'No Street View imagery found for this location.';
      street.rating = null;
      saveProjects();
      hideScanning();
      renderAll();
      openStreet(street.id);
      return;
    }

    updateScanning(`Analyzing ${points.length} photos…`);

    // Fetch images
    const photoData = [];
    for (const pt of points) {
      const url = getSVUrl(pt.lat, pt.lng, pt.heading);
      try {
        const base64 = await fetchImageBase64(url);
        if (!base64) continue;
        photoData.push({ base64, url, lat: pt.lat, lng: pt.lng, heading: pt.heading });
        if (photoData.length >= (activeProject.maxPhotos || 6)) break;
      } catch {}
    }

    if (!photoData.length) {
      street.analysis = 'Could not retrieve usable Street View photos.';
      street.rating = null;
      saveProjects();
      hideScanning();
      renderAll();
      openStreet(street.id);
      return;
    }

    // Store scan photos — embed base64 so they work offline and on mobile
    street.scanPhotos = photoData.map((p, i) => ({
      url: getSVUrl(p.lat, p.lng, p.heading, 400, 250),
      hdUrl: getSVUrl(p.lat, p.lng, p.heading, 800, 500),
      dataUrl: `data:image/jpeg;base64,${p.base64}`,
      label: `Photo ${i + 1}`,
      lat: p.lat, lng: p.lng
    }));
    // Set thumbnail from embedded base64
    street.svImage = street.scanPhotos[0]?.dataUrl || street.scanPhotos[0]?.url || '';

    updateScanning('Asking AI to analyze pavement…');

    // Build prompt
    const globalNotes = getGlobalSettings().globalAiNotes || '';
    const projNotes = activeProject.aiNotes || '';
    const calibRules = (activeProject.calibrationRules || []).join('\n');
    const projType = activeProject.type || 'crack-seal';
    const isSlurry = projType === 'slurry' || projType === 'both';

    const systemPrompt = `${globalNotes ? 'GLOBAL RULES:\n' + globalNotes + '\n\n' : ''}${projNotes ? 'PROJECT NOTES:\n' + projNotes + '\n\n' : ''}${calibRules ? 'CALIBRATION RULES:\n' + calibRules + '\n\n' : ''}You are a pavement condition expert. Analyze the Street View photos and return a structured assessment.

Rate the pavement:
Level: [1] = Good condition, minimal cracking
Level: [2] = Light cracks, surface wear
Level: [3] = Heavy cracks, significant deterioration
Level: [4] = Alligator cracking, severe damage

${isSlurry ? 'This is a slurry seal project — flag raveling and prep cracks (0.25"+).\n' : ''}
Respond with this exact format:
1. PHOTOS ANALYZED
[count] images covering [distance] ft

2. WHAT I CAN SEE
- [observations]

3. WIDE CRACKS
[None detected. / Description]

4. WEED/GRASS CONTROL
[None detected. / Description]

5. WHAT I CAN'T SEE
- [limitations]

6. RECOMMENDATIONS
[treatment recommendation]

7. Level: [1/2/3/4]

8. PHOTO RATINGS
Photo 1: [1/2/3/4], Photo 2: [1/2/3/4], ...

Also add on separate lines if detected:
WEED_ALERT: YES
RAVELING_ALERT: YES
RR_ALERT: YES`;

    const content = [
      { type: 'text', text: systemPrompt },
      ...photoData.map((p, i) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${p.base64}` }
      }))
    ];

    const resp = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: activeProject.scanModel || 'gpt-4o',
        provider: getProvider(activeProject.scanModel),
        messages: [{ role: 'user', content }],
        max_tokens: 1200,
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.status);
      throw new Error(`Proxy error ${resp.status}: ${errText}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) throw new Error('AI returned empty response: ' + JSON.stringify(data).slice(0, 200));

    // Parse
    street.analysis = text;
    street.aiRating = extractRating(text);
    street.rating = street.aiRating;
    street.weedAlert = /WEED_ALERT:\s*YES/i.test(text);
    street.ravelingAlert = /RAVELING_ALERT:\s*YES/i.test(text);
    street.rrAlert = /RR_ALERT:\s*YES/i.test(text);
    street.scannedAt = new Date().toISOString();

    saveProjects();
    hideScanning();
    renderAll();
    openStreet(street.id);

  } catch (e) {
    console.error('Scan error:', e);
    hideScanning();
    showToast('Scan failed: ' + (e.message || 'unknown error').slice(0, 80));
    renderAll();
  }
}

function getSamplePoints(street) {
  const interval = activeProject.photoInterval || 200;
  const maxPts = activeProject.maxPhotos || 6;
  const path = street.path?.length >= 2 ? street.path : [{ lat: street.lat - 0.001, lng: street.lng }, { lat: street.lat + 0.001, lng: street.lng }];
  const points = [];
  let accDist = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const segDist = calcDistanceFt(path[i], path[i + 1]);
    const heading = calcHeading(path[i], path[i + 1]);
    let d = i === 0 ? 0 : interval - (accDist % interval);
    while (d <= segDist && points.length < maxPts) {
      const frac = d / segDist;
      points.push({
        lat: path[i].lat + frac * (path[i + 1].lat - path[i].lat),
        lng: path[i].lng + frac * (path[i + 1].lng - path[i].lng),
        heading
      });
      d += interval;
    }
    accDist += segDist;
  }
  if (!points.length) {
    const heading = path.length >= 2 ? calcHeading(path[0], path[1]) : 0;
    points.push({ lat: street.lat, lng: street.lng, heading });
  }
  return points.slice(0, maxPts);
}

function getSVUrl(lat, lng, heading, w = 400, h = 250) {
  return `${PROXY}/image?url=${encodeURIComponent(`https://maps.googleapis.com/maps/api/streetview?size=${w}x${h}&location=${lat},${lng}&heading=${heading}&pitch=-5&fov=90&key=AIzaSyALUzyaUCMmtVah_gcnoe-g2VGeezsPkZ8`)}`;
}

async function fetchImageBase64(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const blob = await r.blob();
  // Convert to JPEG via canvas to ensure consistent format across browsers
  return new Promise(res => {
    const img = new Image();
    const objUrl = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width || 400;
      canvas.height = img.height || 250;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(objUrl);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      res(dataUrl.split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); res(null); };
    img.src = objUrl;
  });
}

async function checkHasRoad(base64) {
  try {
    const r = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o', provider: 'openai',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Does this image show a road or pavement surface? Reply YES or NO only.' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]}],
        max_tokens: 5
      })
    });
    const d = await r.json();
    const t = d.choices?.[0]?.message?.content || '';
    return t.toUpperCase().includes('YES');
  } catch { return true; }
}

function extractRating(text) {
  const m = text.match(/Level:\s*\[?([1-4])\]?/i);
  if (m) return `level-${m[1]}`;
  const m2 = text.match(/level[- ]([1-4])/i);
  if (m2) return `level-${m2[1]}`;
  return null;
}

function getProvider(model) {
  return (model || '').includes('gemini') ? 'google' : 'openai';
}

async function rescanMobile(id) {
  showToast('AI scanning is office use only. Use the desktop app to scan.');
}

async function deleteMobileStreet(id) {
  if (!confirm('Delete this street?')) return;
  activeProject.streets = activeProject.streets.filter(s => s.id !== id);
  saveProjects();
  activeStreetId = null;
  showListView();
  renderAll();
  setSheetState('peek');
}

// ─── PHOTOS ────────────────────────────────────────────────
function startPhoto() {
  if (activeStreetId) {
    startPhotoFor(activeStreetId);
    return;
  }
  // No street selected — find nearest street to current location
  if (!navigator.geolocation) { showToast('Select a street first'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const streets = getStreets();
    if (!streets.length) { showToast('No streets yet'); return; }
    let nearest = null, minDist = Infinity;
    streets.forEach(s => {
      const d = calcDistanceFt({ lat: pos.coords.latitude, lng: pos.coords.longitude }, { lat: s.lat, lng: s.lng });
      if (d < minDist) { minDist = d; nearest = s; }
    });
    if (nearest && minDist < 2000) {
      showToast(`Photo saved to ${nearest.name}`);
      startPhotoFor(nearest.id);
    } else {
      showToast('Select a street first');
    }
  }, () => showToast('Select a street first'));
}

function startPhotoFor(streetId) {
  _photoStreetId = streetId;
  document.getElementById('photo-input').click();
}

function startRRPhotoFor(streetId) {
  _rrPhotoStreetId = streetId;
  document.getElementById('rr-photo-input').click();
}

function handlePhotoInput(e) {
  const file = e.target.files?.[0];
  if (!file || !_photoStreetId) return;
  compressAndStorePhoto(file, _photoStreetId, 'photos');
  e.target.value = '';
}

function handleRRPhotoInput(e) {
  const file = e.target.files?.[0];
  if (!file || !_rrPhotoStreetId) return;
  compressAndStorePhoto(file, _rrPhotoStreetId, 'rrPhotos');
  e.target.value = '';
}

function compressAndStorePhoto(file, streetId, arrayName) {
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const max = 1200;
      let w = img.width, h = img.height;
      if (w > max) { h = Math.round(h * max / w); w = max; }
      if (h > max) { w = Math.round(w * max / h); h = max; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      const s = getStreets().find(s => s.id === streetId);
      if (!s) return;
      if (!s[arrayName]) s[arrayName] = [];
      s[arrayName].push({ id: crypto.randomUUID(), dataUrl, lat: s.lat, lng: s.lng, note: '', rating: null, takenAt: new Date().toISOString() });
      saveProjects();
      if (activeStreetId === streetId) { renderStreetDetail(); switchMobileTab('photos'); }
      renderMarkers();
      showToast('Photo saved');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// ─── LIGHTBOX ──────────────────────────────────────────────
function openLightboxMobile(streetId, arrayName, idx) {
  const s = getStreets().find(s => s.id === streetId);
  if (!s) return;
  _lbStreetId = streetId; _lbArray = arrayName; _lbIdx = idx;
  _lbPhotos = s[arrayName] || [];
  document.getElementById('lightbox').classList.remove('hidden');
  renderLightbox();
}

function renderLightbox() {
  const photo = _lbPhotos[_lbIdx];
  if (!photo) return;
  const isScan = _lbArray === 'scanPhotos';
  document.getElementById('lb-img').src = photo.hdUrl || photo.dataUrl || photo.url || '';
  document.getElementById('lb-label').textContent = photo.label || `Photo ${_lbIdx + 1}`;
  document.getElementById('lb-count').textContent = `${_lbIdx + 1} / ${_lbPhotos.length}`;
  document.getElementById('lb-rating').value = photo.rating || '';
  document.getElementById('lb-retake').classList.toggle('hidden', !isScan);
  document.getElementById('lb-calib').classList.add('hidden');
}

function lbNav(dir) {
  _lbIdx = Math.max(0, Math.min(_lbPhotos.length - 1, _lbIdx + dir));
  renderLightbox();
}

function lbSetRating(value) {
  const s = getStreets().find(s => s.id === _lbStreetId);
  const photo = _lbPhotos[_lbIdx];
  if (!s || !photo) return;
  const old = photo.rating;
  photo.rating = value || null;

  if (_lbArray === 'scanPhotos') {
    s.scanPhotos = _lbPhotos;
    // Recalc street rating from photos
    const rated = s.scanPhotos.filter(p => p.rating);
    if (rated.length) {
      const avg = rated.reduce((a, p) => a + parseInt(p.rating.replace('level-', '')), 0) / rated.length;
      s.rating = `level-${Math.round(avg)}`;
    }
    if (old && old !== value) logCalibration(s, old, value);
  } else {
    photo.rating = value || null;
  }

  saveProjects();
  drawAllPolylines();
  if (activeStreetId === _lbStreetId) renderStreetDetail();
  updateStats();
}

function lbDelete() {
  if (!confirm('Delete this photo?')) return;
  const s = getStreets().find(s => s.id === _lbStreetId);
  if (!s) return;
  s[_lbArray].splice(_lbIdx, 1);
  _lbPhotos = s[_lbArray];
  saveProjects();
  if (!_lbPhotos.length) { closeLightboxMobile(); return; }
  _lbIdx = Math.min(_lbIdx, _lbPhotos.length - 1);
  renderLightbox();
  if (activeStreetId === _lbStreetId) renderStreetDetail();
}

function lbRetake() {
  _svIsRetake = true;
  _svStreetId = _lbStreetId;
  _svPhotoIndex = _lbIdx;
  closeLightboxMobile();
  const photo = _lbPhotos[_lbIdx];
  openSVAt(photo.lat, photo.lng);
  document.getElementById('btn-sv-replace').classList.remove('hidden');
}

function closeLightboxMobile() {
  document.getElementById('lightbox').classList.add('hidden');
}

// ─── STREET VIEW ───────────────────────────────────────────
let _svMinimap = null, _svMinimapOverlay = null, _svResizeInit = false;

function initSVResize() {
  if (_svResizeInit) return;
  _svResizeInit = true;
  const handle = document.getElementById('sv-resize-handle');
  const minimap = document.getElementById('sv-minimap');
  let startY, startH;
  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    startH = minimap.offsetHeight;
    e.preventDefault();
  }, { passive: false });
  handle.addEventListener('touchmove', e => {
    const dy = e.touches[0].clientY - startY;
    const newH = Math.min(Math.max(startH + dy, 80), window.innerHeight * 0.7);
    minimap.style.height = newH + 'px';
    if (_svMinimap) google.maps.event.trigger(_svMinimap, 'resize');
    e.preventDefault();
  }, { passive: false });
}

function openSVAt(lat, lng, heading = 0) {
  const overlay = document.getElementById('sv-overlay');
  overlay.classList.remove('hidden');
  initSVResize();

  // Init minimap
  if (!_svMinimap) {
    _svMinimap = new google.maps.Map(document.getElementById('sv-minimap'), {
      center: { lat, lng }, zoom: 17,
      disableDefaultUI: true,
      gestureHandling: 'none',
      clickableIcons: false,
      styles: [
        { elementType: 'geometry', stylers: [{ color: '#0d1117' }] },
        { elementType: 'labels.text.fill', stylers: [{ color: '#94a3b8' }] },
        { elementType: 'labels.text.stroke', stylers: [{ color: '#0d1117' }] },
        { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1e293b' }] },
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0f172a' }] },
      ],
    });
    _svMinimapOverlay = new (getLocationDotOverlayClass())({ lat, lng });
    _svMinimapOverlay.setMap(_svMinimap);
  } else {
    _svMinimap.panTo({ lat, lng });
    _svMinimapOverlay.setLatLng({ lat, lng });
  }

  // Init panorama
  if (!panorama) {
    panorama = new google.maps.StreetViewPanorama(document.getElementById('sv-pano'), {
      position: { lat, lng }, pov: { heading, pitch: 0 }, zoom: 1,
      disableDefaultUI: true,
    });
    // Track position as user moves in SV
    panorama.addListener('position_changed', () => {
      const pos = panorama.getPosition();
      if (pos && _svMinimap) {
        const latlng = { lat: pos.lat(), lng: pos.lng() };
        _svMinimap.panTo(latlng);
        _svMinimapOverlay.setLatLng(latlng);
      }
    });
  } else {
    panorama.setPosition({ lat, lng });
    panorama.setPov({ heading, pitch: 0 });
  }
}

function closeSV() {
  document.getElementById('sv-overlay').classList.add('hidden');
  _svIsRetake = false;
  document.getElementById('btn-sv-replace').classList.add('hidden');
}

function snapSV(isRR) {
  const pos = panorama.getPosition();
  const pov = panorama.getPov();
  const url = getSVUrl(pos.lat(), pos.lng(), pov.heading, 800, 500);
  document.getElementById('snap-preview').src = url;
  document.getElementById('snap-rating').value = '';
  document.getElementById('snap-note').value = '';
  // Store for save
  window._snapUrl = url;
  window._snapIsRR = isRR;
  window._snapLat = pos.lat();
  window._snapLng = pos.lng();
  document.getElementById('snap-sheet-overlay').classList.remove('hidden');
}

function closeSnapSheet(e) {
  if (e && e.target !== document.getElementById('snap-sheet-overlay')) return;
  document.getElementById('snap-sheet-overlay').classList.add('hidden');
}

function saveSnapMobile() {
  const s = getStreets().find(s => s.id === activeStreetId);
  if (!s) { showToast('Select a street first'); closeSnapSheet(); return; }
  const arrayName = window._snapIsRR ? 'rrPhotos' : 'photos';
  if (!s[arrayName]) s[arrayName] = [];
  s[arrayName].push({
    id: crypto.randomUUID(),
    dataUrl: window._snapUrl,
    lat: window._snapLat, lng: window._snapLng,
    note: document.getElementById('snap-note').value.trim(),
    rating: document.getElementById('snap-rating').value || null,
    takenAt: new Date().toISOString(),
  });
  saveProjects();
  closeSnapSheet();
  if (activeStreetId) { renderStreetDetail(); switchMobileTab('photos'); }
  showToast('Photo saved');
}

function snapRetakeMobile() {
  const s = getStreets().find(s => s.id === _svStreetId);
  if (!s || _svPhotoIndex === null) return;
  const pos = panorama.getPosition();
  const pov = panorama.getPov();
  const newUrl = getSVUrl(pos.lat(), pos.lng(), pov.heading, 400, 250);
  const newHD = getSVUrl(pos.lat(), pos.lng(), pov.heading, 800, 500);
  if (s.scanPhotos?.[_svPhotoIndex]) {
    s.scanPhotos[_svPhotoIndex].url = newUrl;
    s.scanPhotos[_svPhotoIndex].hdUrl = newHD;
    s.scanPhotos[_svPhotoIndex].lat = pos.lat();
    s.scanPhotos[_svPhotoIndex].lng = pos.lng();
  }
  saveProjects();
  closeSV();
  _svIsRetake = false; _svStreetId = null; _svPhotoIndex = null;
  if (activeStreetId) renderStreetDetail();
  showToast('Photo replaced');
}

// Worker drag (same as desktop)
function initWorkerDrag() {
  const sv = document.getElementById('fab-sv');
  if (!sv) return;
  let ghost = null;

  sv.addEventListener('touchstart', e => {
    e.preventDefault();
    sv.style.opacity = '0.4';
    ghost = createWorkerGhost();
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('touchend', onDrop);
  }, { passive: false });

  sv.addEventListener('mousedown', e => {
    e.preventDefault();
    sv.style.opacity = '0.4';
    ghost = createWorkerGhost();
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onDrop);
  });

  function onDrag(e) {
    const touch = e.touches ? e.touches[0] : e;
    if (ghost) {
      ghost.style.left = touch.clientX + 'px';
      ghost.style.top = touch.clientY + 'px';
    }
    if (e.cancelable) e.preventDefault();
  }

  function onDrop(e) {
    const touch = e.changedTouches ? e.changedTouches[0] : e;
    sv.style.opacity = '1';
    if (ghost) { ghost.remove(); ghost = null; }
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('touchend', onDrop);
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onDrop);

    // Check if dropped on map
    const mapEl = document.getElementById('map');
    const rect = mapEl.getBoundingClientRect();
    const x = touch.clientX, y = touch.clientY;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      // Convert pixel to lat/lng
      const proj = map.getProjection();
      if (proj) {
        const bounds = map.getBounds();
        const nw = new google.maps.LatLng(bounds.getNorthEast().lat(), bounds.getSouthWest().lng());
        const nwPx = proj.fromLatLngToPoint(nw);
        const scale = Math.pow(2, map.getZoom());
        const pointX = nwPx.x + (x - rect.left) / scale;
        const pointY = nwPx.y + (y - rect.top) / scale;
        const latLng = proj.fromPointToLatLng(new google.maps.Point(pointX, pointY));
        openSVAt(latLng.lat(), latLng.lng());
      }
    }
  }
}

function createWorkerGhost() {
  const el = document.createElement('div');
  el.id = 'worker-ghost-mobile';
  el.innerHTML = `<svg width="44" height="64" viewBox="0 0 22 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="9" r="3.5" fill="#fde68a"/>
    <rect x="2" y="13.5" width="6" height="2.5" rx="1.25" fill="#f97316" transform="rotate(20,7.5,14.75)"/>
    <rect x="14" y="13.5" width="6" height="2.5" rx="1.25" fill="#f97316" transform="rotate(-20,14.5,14.75)"/>
    <rect x="7.5" y="13" width="7" height="7" rx="2" fill="#f97316"/>
    <rect x="7.5" y="19.5" width="3" height="7.5" rx="1.5" fill="#374151"/>
    <rect x="11.5" y="19.5" width="3" height="7.5" rx="1.5" fill="#374151"/>
  </svg>`;
  document.body.appendChild(el);
  return el;
}

// ─── PROJECT SHEET ─────────────────────────────────────────
function openProjectSheet() {
  renderProjectList();
  document.getElementById('project-sheet-overlay').classList.remove('hidden');
}
function closeProjectSheet(e) {
  if (e && e.target !== document.getElementById('project-sheet-overlay')) return;
  document.getElementById('project-sheet-overlay').classList.add('hidden');
}

// ─── SCAN SPINNER ──────────────────────────────────────────
function showScanning(msg = 'Scanning…') {
  document.getElementById('scanning-overlay').classList.remove('hidden');
  document.getElementById('scanning-status').textContent = msg;
}
function updateScanning(msg) {
  document.getElementById('scanning-status').textContent = msg;
}
function hideScanning() {
  document.getElementById('scanning-overlay').classList.add('hidden');
}

// ─── SEARCH ────────────────────────────────────────────────
function searchLocation() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  geocodeAddress(q).then(({ lat, lng }) => {
    map.panTo({ lat, lng });
    map.setZoom(16);
  }).catch(() => showToast('Location not found'));
}

// ─── MY LOCATION ───────────────────────────────────────────
let _locOverlay = null, _locCircle = null, _locWatch = null, _locTracking = false;
let _LocationDotOverlay = null;

function getLocationDotOverlayClass() {
  if (_LocationDotOverlay) return _LocationDotOverlay;
  _LocationDotOverlay = class extends google.maps.OverlayView {
    constructor(latlng) {
      super();
      this._latlng = new google.maps.LatLng(latlng.lat, latlng.lng);
      this._el = null;
    }
    onAdd() {
      const el = document.createElement('div');
      el.className = 'loc-overlay';
      el.innerHTML = '<div class="loc-halo"></div><div class="loc-halo loc-halo-2"></div><div class="loc-halo loc-halo-3"></div><div class="loc-dot"></div>';
      this._el = el;
      this.getPanes().overlayMouseTarget.appendChild(el);
    }
    draw() {
      if (!this._el) return;
      const p = this.getProjection().fromLatLngToDivPixel(this._latlng);
      this._el.style.left = p.x + 'px';
      this._el.style.top = p.y + 'px';
    }
    onRemove() {
      if (this._el) { this._el.remove(); this._el = null; }
    }
    setLatLng(latlng) {
      this._latlng = new google.maps.LatLng(latlng.lat, latlng.lng);
      this.draw();
    }
    getLatLng() { return this._latlng; }
  };
  return _LocationDotOverlay;
}

function goToMyLocation() {
  if (!navigator.geolocation) { showToast('Geolocation not supported'); return; }

  const btn = document.getElementById('fab-location');

  if (_locTracking) {
    // Already tracking — just re-center
    if (_locOverlay) map.panTo(_locOverlay.getLatLng());
    return;
  }

  // Start tracking
  _locTracking = true;
  if (btn) { btn.style.background = '#3b82f6'; btn.style.color = '#fff'; btn.style.borderColor = '#3b82f6'; }

  _locWatch = navigator.geolocation.watchPosition(pos => {
    const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const acc = pos.coords.accuracy;

    if (!_locOverlay) {
      // First fix — create overlay + accuracy circle
      _locOverlay = new (getLocationDotOverlayClass())(latlng);
      _locOverlay.setMap(map);
      _locCircle = new google.maps.Circle({
        center: latlng, radius: acc, map,
        fillColor: '#3b82f6', fillOpacity: 0.08,
        strokeColor: '#3b82f6', strokeOpacity: 0.3, strokeWeight: 1,
      });
      map.panTo(latlng);
      map.setZoom(17);
    } else {
      _locOverlay.setLatLng(latlng);
      _locCircle.setCenter(latlng);
      _locCircle.setRadius(acc);
    }
  }, () => {
    showToast('Could not get location');
    _locTracking = false;
    if (btn) { btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }
  }, { enableHighAccuracy: true });
}

// ─── CALIBRATION ───────────────────────────────────────────
function logCalibration(street, aiRating, newRating) {
  if (!activeProject) return;
  if (!activeProject.calibrationLog) activeProject.calibrationLog = [];
  activeProject.calibrationLog.push({
    streetId: street.id, streetName: street.name,
    aiRating, correctedRating: newRating,
    reason: '', loggedAt: new Date().toISOString()
  });
  saveProjects();
}

// ─── SWIPE TO DELETE ───────────────────────────────────────
let _swipeStartX = null;

function swipeStart(e, el) {
  _swipeStartX = e.touches[0].clientX;
  el.querySelector('.swipe-content').style.transition = 'none';
}

function swipeMove(e, el) {
  if (_swipeStartX === null) return;
  const delta = e.touches[0].clientX - _swipeStartX;
  if (delta < 0) {
    const content = el.querySelector('.swipe-content');
    content.style.transform = `translateX(${Math.max(delta, -80)}px)`;
    el.querySelector('.swipe-delete').style.opacity = Math.min(Math.abs(delta) / 80, 1);
  }
}

function swipeEnd(e, el, id) {
  if (_swipeStartX === null) return;
  const delta = e.changedTouches[0].clientX - _swipeStartX;
  const content = el.querySelector('.swipe-content');
  content.style.transition = 'transform 0.2s';
  if (delta < -60) {
    // Reveal delete button
    content.style.transform = 'translateX(-80px)';
  } else {
    content.style.transform = '';
    el.querySelector('.swipe-delete').style.opacity = 0;
  }
  _swipeStartX = null;
}

function swipeDeleteStreet(id) {
  if (!confirm('Delete this street?')) return;
  activeProject.streets = activeProject.streets.filter(s => s.id !== id);
  saveProjects();
  if (activeStreetId === id) { activeStreetId = null; showListView(); }
  renderAll();
  showToast('Street deleted');
}

// ─── PULL TO REFRESH ───────────────────────────────────────
function initPullToRefresh() {
  const indicator = document.getElementById('pull-indicator');
  const handle = document.getElementById('sheet-handle-wrap');
  let startY = 0, pullCount = 0, pullTimer = null;

  // Only listen on the sheet handle — not the map
  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
  }, { passive: true });

  handle.addEventListener('touchend', e => {
    // Only when sheet is already at bottom (peek)
    if (_sheetState !== 'peek') return;
    const delta = e.changedTouches[0].clientY - startY;
    if (delta < 40) return; // not a downward pull

    pullCount++;
    clearTimeout(pullTimer);

    if (pullCount === 1) {
      indicator.textContent = '↓ Pull down again to refresh';
      indicator.classList.add('visible');
      pullTimer = setTimeout(() => {
        pullCount = 0;
        indicator.classList.remove('visible');
      }, 2000);
    } else if (pullCount >= 2) {
      pullCount = 0;
      indicator.textContent = 'Refreshing…';
      setTimeout(() => location.reload(), 300);
    }
  }, { passive: true });
}

// ─── HELPERS ───────────────────────────────────────────────
function geocodeAddress(address) {
  return new Promise((res, rej) => {
    const gc = new google.maps.Geocoder();
    gc.geocode({ address }, (results, status) => {
      if (status === 'OK' && results[0]) {
        const loc = results[0].geometry.location;
        res({ lat: loc.lat(), lng: loc.lng() });
      } else rej(new Error('Geocode failed'));
    });
  });
}

async function detectRoadType(lat, lng) {
  try {
    const q = `[out:json];way(around:30,${lat},${lng})[highway];out tags 1;`;
    const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
    const d = await r.json();
    const hw = d.elements?.[0]?.tags?.highway || '';
    if (['motorway','trunk','primary','secondary','tertiary'].includes(hw)) return 'arterial';
    if (hw === 'service') return 'parking-lot';
    return 'residential';
  } catch { return 'residential'; }
}

function roadTypeWidth(type) {
  const widths = { 'arterial': 64, 'highway': 72, 'residential': 36, 'parking-lot': 24 };
  return widths[type] || 36;
}

function calcDistanceFt(p1, p2) {
  const R = 20902231;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(p1.lat*Math.PI/180) * Math.cos(p2.lat*Math.PI/180) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function calcHeading(p1, p2) {
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const lat1 = p1.lat * Math.PI / 180;
  const lat2 = p2.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function getTreatment(rating, type) {
  if (!rating) return 'Not yet rated';
  const t = type || 'crack-seal';
  const lvl = parseInt(rating.replace('level-', ''));
  if (t === 'crack-seal') {
    if (lvl === 1) return 'No treatment needed';
    if (lvl === 2) return 'Crack seal recommended';
    if (lvl === 3) return 'Crack seal — moderate priority';
    return 'Crack seal — high priority (consider R&R)';
  }
  if (lvl === 1) return 'Slurry seal — good candidate';
  if (lvl === 2) return 'Crack seal then slurry';
  if (lvl === 3) return 'Crack seal required before slurry';
  return 'R&R recommended — too damaged for slurry';
}

function getGlobalSettings() {
  try { return JSON.parse(localStorage.getItem('cse_global_settings') || '{}'); } catch { return {}; }
}

function ratingColor(r) {
  if (r === 'level-1') return '#22c55e';
  if (r === 'level-2') return '#eab308';
  if (r === 'level-3') return '#f97316';
  if (r === 'level-4') return '#ef4444';
  return '#64748b';
}
function ratingBg(r) {
  if (r === 'level-1') return 'rgba(34,197,94,0.15)';
  if (r === 'level-2') return 'rgba(234,179,8,0.15)';
  if (r === 'level-3') return 'rgba(249,115,22,0.15)';
  if (r === 'level-4') return 'rgba(239,68,68,0.15)';
  return 'rgba(100,116,139,0.15)';
}
function ratingClass(r) {
  if (r === 'level-1') return 'r1';
  if (r === 'level-2') return 'r2';
  if (r === 'level-3') return 'r3';
  if (r === 'level-4') return 'r4';
  return 'r-none';
}
function ratingLabel(r) {
  if (r === 'level-1') return 'LVL 1';
  if (r === 'level-2') return 'LVL 2';
  if (r === 'level-3') return 'LVL 3';
  if (r === 'level-4') return 'LVL 4';
  return 'Unrated';
}
function formatNum(n) { return Math.round(n || 0).toLocaleString(); }
function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function showToast(msg, dur = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), dur);
}
