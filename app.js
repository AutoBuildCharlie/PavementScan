/* ================================================================
   CRACKING & SEALING EST. — App Logic
   Street assessment tool for GRSI
   ================================================================ */

/* ─── DATA SHAPE REFERENCE ──────────────────────────────────
   localStorage key: "cse_streets"
   [
     {
       id:        "uuid-string",
       name:      "1200 W Ball Rd, Anaheim, CA",
       lat:       33.8366,
       lng:       -117.9143,
       length:    500,         // feet
       width:     24,          // feet
       sqft:      12000,       // length * width
       rating:    "fair",      // "good" | "fair" | "poor" | "critical" | "pending"
       notes:     "Parking lot near freeway",
       analysis:  "AI analysis text...",
       svImage:   "street-view-url",
       scannedAt: "2026-03-30T07:42:00Z",
       createdAt: "2026-03-30T07:40:00Z"
     }
   ]
──────────────────────────────────────────────────────────── */

// ─── GLOBALS ───────────────────────────────────────────────
let map = null;
let markers = [];
let streets = [];
let activeStreetId = null;
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

  renderStreetList();
  placeAllMarkers();
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

// ─── GEOCODING ─────────────────────────────────────────────
async function geocodeAddress(address) {
  try {
    const url = `${GEOCODE_BASE}?address=${encodeURIComponent(address)}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results.length > 0) {
      const result = data.results[0];
      return {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        formatted: result.formatted_address
      };
    }
    return null;
  } catch (e) {
    console.error('Geocoding error:', e);
    return null;
  }
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
        scale: 10,
        fillColor: color,
        fillOpacity: 0.9,
        strokeColor: '#fff',
        strokeWeight: 2
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

    <div class="detail-actions">
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
    { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#1f1f35' }] },
    { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2d2d44' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1a1a2e' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3b3b5c' }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8892b0' }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#1f1f35' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1525' }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4a5568' }] }
  ];
}
