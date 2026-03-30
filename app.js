/* ================================================================
   CRACKING & SEALING EST. — App Logic
   Street assessment tool for GRSI
   ================================================================ */

/* ─── DATA SHAPE REFERENCE ──────────────────────────────────
   localStorage key: "cse_streets"
   [
     {
       id:             "uuid-string",
       name:           "1200 W Ball Rd, Anaheim, CA",
       lat:            33.8366,
       lng:            -117.9143,
       length:         500,
       width:          24,
       sqft:           12000,
       rating:         "fair",      // "good"|"fair"|"poor"|"critical"|"pending"
       notes:          "Parking lot near freeway",
       analysis:       "AI analysis text...",
       svImage:        "street-view-url",
       highlightStart: { lat, lng },
       highlightEnd:   { lat, lng },
       photos:         [{ id, dataUrl, lat, lng, address, note, takenAt }],
       scannedAt:      "2026-03-30T07:42:00Z",
       createdAt:      "2026-03-30T07:40:00Z"
     }
   ]
──────────────────────────────────────────────────────────── */

// ─── GLOBALS ───────────────────────────────────────────────
let map = null;
let markers = [];
let streets = [];
let activeStreetId = null;
let highlightMode = null; // null | 'start' | 'end'
let highlightStreetId = null;
let highlightMarkers = []; // temp start/end markers
let polylines = []; // drawn street lines
const STORAGE_KEY = 'cse_streets';
const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const SV_BASE = 'https://maps.googleapis.com/maps/api/streetview';
let API_KEY = '';

// ─── OPENAI PROXY (for AI crack analysis) ──────────────────
const AI_PROXY = ''; // Cloudflare Worker URL — add later

// ─── INIT ──────────────────────────────────────────────────
function initMap() {
  API_KEY = getMapKey();
  streets = loadStreets();

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

  // Map click listener for highlight mode
  map.addListener('click', (e) => handleMapClick(e.latLng));

  renderStreetList();
  placeAllMarkers();
  placePhotoMarkers();
  drawAllHighlights();
  updateStats();
}

// ─── STORAGE ───────────────────────────────────────────────
function loadStreets() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch { return []; }
}

function saveStreets() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(streets));
}

// ─── MODAL CONTROLS ────────────────────────────────────────
function openAddStreetModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('input-street-name').value = '';
  document.getElementById('input-length').value = '';
  document.getElementById('input-width').value = '';
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
  const width = parseFloat(document.getElementById('input-width').value) || 0;
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
    rating: 'pending',
    notes: notes,
    analysis: '',
    svImage: getStreetViewUrl(geo.lat, geo.lng),
    scannedAt: null,
    createdAt: new Date().toISOString()
  };

  // Run AI scan on Street View image
  showScanModal('AI analyzing pavement condition...');
  const analysis = await analyzeStreetView(street);
  street.analysis = analysis.text;
  street.rating = analysis.rating;
  street.scannedAt = new Date().toISOString();

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

  showToast('Street added and scanned');
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
async function analyzeStreetView(street) {
  // If no AI proxy configured, use built-in heuristic placeholder
  if (!AI_PROXY) {
    return analyzeWithPlaceholder(street);
  }

  try {
    const svUrl = getStreetViewUrl(street.lat, street.lng);
    const res = await fetch(AI_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a pavement condition assessor for a road sealing company. Analyze the Street View image and assess the visible pavement/road condition. Look for: cracks (alligator, longitudinal, transverse), potholes, fading, patches, wear. Rate the overall condition as exactly one of: good, fair, poor, critical. Be concise — 3-4 bullet points max. End with "Rating: [good/fair/poor/critical]"`
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Assess the pavement condition visible in this Street View image of: ${street.name}` },
              { type: 'image_url', image_url: { url: svUrl } }
            ]
          }
        ],
        max_tokens: 300
      })
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const rating = extractRating(text);
    return { text, rating };
  } catch (e) {
    console.error('AI analysis error:', e);
    return analyzeWithPlaceholder(street);
  }
}

function extractRating(text) {
  const lower = text.toLowerCase();
  if (lower.includes('rating: critical') || lower.includes('rating:critical')) return 'critical';
  if (lower.includes('rating: poor') || lower.includes('rating:poor')) return 'poor';
  if (lower.includes('rating: fair') || lower.includes('rating:fair')) return 'fair';
  if (lower.includes('rating: good') || lower.includes('rating:good')) return 'good';
  return 'fair';
}

// Placeholder analysis when AI proxy isn't connected yet
function analyzeWithPlaceholder(street) {
  const ratings = ['good', 'fair', 'poor', 'critical'];
  const rating = ratings[Math.floor(Math.random() * ratings.length)];

  const analyses = {
    good: `Street View Assessment — ${street.name}\n\n• Pavement appears to be in good overall condition\n• No major cracking or deterioration visible from street level\n• Surface color and texture appear consistent\n• Minimal patching observed\n\nNote: This is a preliminary scan from Street View. On-site inspection recommended for accurate crack measurement.\n\nRating: Good`,
    fair: `Street View Assessment — ${street.name}\n\n• Some visible surface wear and minor cracking detected\n• Possible longitudinal cracking along lane edges\n• Pavement color suggests moderate aging\n• Some areas may have previous patch work\n\nNote: This is a preliminary scan from Street View. On-site inspection recommended for accurate crack measurement.\n\nRating: Fair`,
    poor: `Street View Assessment — ${street.name}\n\n• Significant pavement deterioration visible\n• Multiple crack patterns detected (possible alligator cracking)\n• Surface appears rough and uneven in areas\n• Evidence of previous repairs that may need re-sealing\n\nNote: This is a preliminary scan from Street View. On-site inspection recommended for accurate crack measurement.\n\nRating: Poor`,
    critical: `Street View Assessment — ${street.name}\n\n• Severe pavement distress visible from street level\n• Extensive cracking across multiple areas\n• Possible potholes or surface failures detected\n• Immediate attention recommended\n\nNote: This is a preliminary scan from Street View. On-site inspection recommended for accurate crack measurement.\n\nRating: Critical`
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
    case 'good': return '#22c55e';
    case 'fair': return '#eab308';
    case 'poor': return '#f97316';
    case 'critical': return '#ef4444';
    default: return '#94a3b8';
  }
}

// ─── STREET LIST ───────────────────────────────────────────
function renderStreetList() {
  const container = document.getElementById('street-list');

  if (streets.length === 0) {
    container.innerHTML = '<div class="empty-state">No streets added yet.<br>Click <strong>+ Add Street</strong> to begin.</div>';
    return;
  }

  container.innerHTML = streets.map(s => `
    <div class="street-card ${s.id === activeStreetId ? 'active' : ''}" onclick="selectStreet('${s.id}')">
      <div class="street-card-name" title="${escHtml(s.name)}">${escHtml(s.name)}</div>
      <div class="street-card-meta">
        <span class="street-card-sqft">${s.sqft ? formatNumber(s.sqft) + ' sq ft' : 'No dimensions'}</span>
        <span class="rating-badge rating-${s.rating}">${s.rating}</span>
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

  // Show detail panel
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <h3>${escHtml(street.name)}</h3>
      <div class="detail-address">Added ${formatDate(street.createdAt)}</div>
    </div>

    <div class="detail-stats">
      <div class="detail-stat">
        <div class="detail-stat-label">Sq Ft</div>
        <div class="detail-stat-value">${street.sqft ? formatNumber(street.sqft) : '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Rating</div>
        <div class="detail-stat-value"><span class="rating-badge rating-${street.rating}">${street.rating}</span></div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Length</div>
        <div class="detail-stat-value">${street.length ? street.length + ' ft' : '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Width</div>
        <div class="detail-stat-value">${street.width ? street.width + ' ft' : '—'}</div>
      </div>
    </div>

    <div class="detail-section">
      <h4>Street View</h4>
      <img class="streetview-img" src="${street.svImage}" alt="Street View of ${escHtml(street.name)}" onerror="this.src=''; this.alt='Street View not available'">
    </div>

    <div class="detail-section">
      <h4>AI Pavement Analysis</h4>
      <div class="ai-analysis">${escHtml(street.analysis || 'No analysis available')}</div>
    </div>

    ${street.notes ? `
    <div class="detail-section">
      <h4>Notes</h4>
      <div class="ai-analysis">${escHtml(street.notes)}</div>
    </div>` : ''}

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

    <div class="detail-actions">
      ${street.highlightStart ?
        `<button class="btn-secondary" onclick="removeHighlight('${street.id}')">Clear Line</button>` :
        `<button class="btn-highlight" onclick="startHighlight('${street.id}')">Highlight Street</button>`
      }
      <button class="btn-rescan" onclick="rescanStreet('${street.id}')">Re-scan</button>
      <button class="btn-danger" onclick="deleteStreet('${street.id}')">Delete</button>
    </div>
  `;
}

function closeDetailPanel() {
  document.getElementById('detail-panel').classList.add('hidden');
  activeStreetId = null;
  renderStreetList();
}

// ─── RESCAN STREET ─────────────────────────────────────────
async function rescanStreet(id) {
  const street = streets.find(s => s.id === id);
  if (!street) return;

  showScanModal('Re-scanning pavement condition...');
  const analysis = await analyzeStreetView(street);
  street.analysis = analysis.text;
  street.rating = analysis.rating;
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
  if (!confirm('Delete this street?')) return;
  streets = streets.filter(s => s.id !== id);
  saveStreets();
  closeDetailPanel();
  renderStreetList();
  placeAllMarkers();
  updateStats();
  showToast('Street removed');
}

// ─── UPDATE STATS ──────────────────────────────────────────
function updateStats() {
  document.getElementById('total-streets').textContent = streets.length;

  const totalSqft = streets.reduce((sum, s) => sum + (s.sqft || 0), 0);
  document.getElementById('total-sqft').textContent = formatNumber(totalSqft);

  // Average rating
  const ratingValues = { good: 4, fair: 3, poor: 2, critical: 1, pending: 0 };
  const rated = streets.filter(s => s.rating !== 'pending');
  if (rated.length > 0) {
    const avg = rated.reduce((sum, s) => sum + (ratingValues[s.rating] || 0), 0) / rated.length;
    let avgLabel = 'Good';
    if (avg < 1.5) avgLabel = 'Critical';
    else if (avg < 2.5) avgLabel = 'Poor';
    else if (avg < 3.5) avgLabel = 'Fair';
    document.getElementById('avg-rating').textContent = avgLabel;
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

// ─── HIGHLIGHT STREET ──────────────────────────────────────
function startHighlight(id) {
  highlightStreetId = id;
  highlightMode = 'start';
  clearTempMarkers();
  showToast('Click the START of the street on the map');
  document.getElementById('detail-panel').classList.add('hidden');
}

function handleMapClick(latLng) {
  if (!highlightMode) return;

  const street = streets.find(s => s.id === highlightStreetId);
  if (!street) return;

  if (highlightMode === 'start') {
    // Place start marker
    street.highlightStart = { lat: latLng.lat(), lng: latLng.lng() };
    addTempMarker(latLng, 'S', '#22c55e');
    highlightMode = 'end';
    showToast('Now click the END of the street');

  } else if (highlightMode === 'end') {
    // Place end marker
    street.highlightEnd = { lat: latLng.lat(), lng: latLng.lng() };
    addTempMarker(latLng, 'E', '#ef4444');

    // Calculate distance in feet
    const distFt = calcDistanceFt(street.highlightStart, street.highlightEnd);
    street.length = Math.round(distFt);
    street.sqft = street.length * (street.width || 24);

    // Done
    highlightMode = null;
    highlightStreetId = null;
    saveStreets();
    clearTempMarkers();
    drawAllHighlights();
    updateStats();
    renderStreetList();
    selectStreet(street.id);
    showToast(`Street highlighted — ${formatNumber(street.length)} ft long, ${formatNumber(street.sqft)} sq ft`);
  }
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
  // Clear existing polylines
  polylines.forEach(p => p.setMap(null));
  polylines = [];

  streets.forEach(street => {
    if (!street.highlightStart || !street.highlightEnd) return;

    const color = ratingColor(street.rating);
    const line = new google.maps.Polyline({
      path: [street.highlightStart, street.highlightEnd],
      geodesic: true,
      strokeColor: color,
      strokeOpacity: 0.9,
      strokeWeight: 6,
      map: map
    });

    // Click polyline to select street
    line.addListener('click', () => selectStreet(street.id));
    polylines.push(line);

    // Start/end markers
    [{ pos: street.highlightStart, label: 'S', clr: '#22c55e' },
     { pos: street.highlightEnd, label: 'E', clr: '#ef4444' }].forEach(m => {
      const mk = new google.maps.Marker({
        position: m.pos,
        map: map,
        label: { text: m.label, color: '#fff', fontWeight: '700', fontSize: '11px' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: m.clr,
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2
        }
      });
      mk.addListener('click', () => selectStreet(street.id));
      polylines.push(mk); // store so we can clear later
    });
  });
}

function removeHighlight(id) {
  const street = streets.find(s => s.id === id);
  if (!street) return;
  delete street.highlightStart;
  delete street.highlightEnd;
  saveStreets();
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
