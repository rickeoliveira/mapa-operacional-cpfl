const map = L.map('map', { zoomControl: false }).setView([-22.35, -47.75], 8);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' });
streetLayer.addTo(map);
L.control.layers({ 'Mapa de ruas': streetLayer, 'Visão de satélite': satelliteLayer }, null, { position: 'bottomright' }).addTo(map);
const layer = L.layerGroup().addTo(map), networkLayer = L.layerGroup().addTo(map), status = document.querySelector('#status'), filters = document.querySelector('#filters'), feedersBox = document.querySelector('#feeders'), results = document.querySelector('#results'), networkVisible = document.querySelector('#networkVisible');
const NETWORK_MIN_ZOOM = 12;
const NETWORK_SEGMENT_LIMIT = 5000;
let typeSet = new Set(), feederSet = new Set(), timer, routeControl, currentLocationMarker, currentLocationAccuracy;
let networkEnabled = networkVisible.checked;
const feederColors = new Map();
const colors = { Transformador:'#0f7593', Fusível:'#de7a22', Chave:'#6e57a5', Religador:'#ca4163', Regulador:'#3a8d52', Capacitor:'#be8b14' };
const typeLabels = { Chave: 'Chave Faca' };
function displayAssetType(type) { return typeLabels[type] || type; }
function feederColor(feeder) { return feederColors.get(feeder) || '#276fbf'; }
function assignFeederColors(feeders) { feeders.forEach((item, index) => { const hue = Math.round((index * 137.508) % 360); const lightness = index % 3 === 0 ? 36 : index % 3 === 1 ? 45 : 31; feederColors.set(item.feeder, `hsl(${hue} 78% ${lightness}%)`); }); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function icon(type) { const c = colors[type] || '#0f7593'; return L.divIcon({ className:'asset-marker', iconSize:[11,11], iconAnchor:[5.5,5.5], html:`<span style="display:block;width:100%;height:100%;border-radius:50%;background:${c}"></span>` }); }
function googleMapsUrl(item) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${item.latitude},${item.longitude}`)}&travelmode=driving`; }
function popup(item) { return `<b>${escapeHtml(displayAssetType(item.asset_type))}</b><br>Número operativo: <strong>${escapeHtml(item.operational_number)}</strong><br>Alimentador: ${escapeHtml(item.feeder)}<div class="route-actions"><button class="route-button" data-route-id="${item.id}">Traçar no mapa</button><a class="google-route" href="${googleMapsUrl(item)}" target="_blank" rel="noopener">Abrir no Google Maps</a></div>`; }
function marker(item) { const point = L.marker([item.latitude,item.longitude], {icon:icon(item.asset_type), riseOnHover:true}).bindTooltip(`${displayAssetType(item.asset_type)} · ${item.operational_number}`, { direction:'top', offset:[0,-6] }).bindPopup(popup(item)); point.on('popupopen',()=>document.querySelector(`[data-route-id="${item.id}"]`)?.addEventListener('click',()=>routeTo(item))); return point; }
function queueLoad(){ clearTimeout(timer); timer=setTimeout(loadAssets,180); }
function refreshTypeSet() { typeSet = new Set([...filters.querySelectorAll('input:checked')].map(x=>x.value)); }
function refreshFeederSet() { feederSet = new Set([...feedersBox.querySelectorAll('input:checked')].map(x=>x.value)); updateFeederSelection(); }
function updateFeederSelection() {
  const inputs = [...feedersBox.querySelectorAll('input')];
  const visible = inputs.filter(input => !input.closest('.feeder-filter').hidden).length;
  document.querySelector('#feederSelectionCount').textContent = `(${feederSet.size}/${inputs.length})`;
  const query = document.querySelector('#feederSearch').value.trim();
  document.querySelector('#feederSearchHint').textContent = query ? `${visible} resultado${visible === 1 ? '' : 's'} para “${query}”. Marque ou desmarque cada alimentador que desejar.` : `${feederSet.size === inputs.length ? 'Todos os' : `${feederSet.size} de ${inputs.length}`} alimentadores estão selecionados.`;
}
function filterFeeders(query) {
  const normalized = query.trim().toLowerCase();
  feedersBox.querySelectorAll('.feeder-filter').forEach(element => { element.hidden = Boolean(normalized) && !element.dataset.feeder.includes(normalized); });
  updateFeederSelection();
}
function selectedFeeders() {
  const total = feedersBox.querySelectorAll('input').length;
  if (!feederSet.size || feederSet.size === total) return feederSet.size ? null : [];
  return [...feederSet];
}
function boundsParams(limit) {
  const b = map.getBounds(), params = new URLSearchParams({ west:b.getWest(), east:b.getEast(), south:b.getSouth(), north:b.getNorth(), limit });
  const selected = selectedFeeders();
  if (selected?.length) params.set('feeders', selected.join(','));
  return params;
}
async function loadNetwork() {
  networkLayer.clearLayers();
  const selected = selectedFeeders();
  if (!networkEnabled || (Array.isArray(selected) && selected.length === 0) || map.getZoom() < NETWORK_MIN_ZOOM) return;
  const params = boundsParams(NETWORK_SEGMENT_LIMIT);
  const response = await fetch(`/api/network?${params}`); if (!response.ok) return;
  const { items, truncated } = await response.json();
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.feeder)) grouped.set(item.feeder, []);
    grouped.get(item.feeder).push([[item.latitude_from,item.longitude_from],[item.latitude_to,item.longitude_to]]);
  }
  for (const [feeder, segments] of grouped) {
    const feederLine = L.polyline(segments, { color:feederColor(feeder), weight:4, opacity:.86, interactive:true });
    feederLine.bindTooltip(`Alimentador ${escapeHtml(feeder)}`, { sticky:true, direction:'top' });
    feederLine.bindPopup(`<b>Alimentador ${escapeHtml(feeder)}</b><br><span style="color:${feederColor(feeder)}">●</span> Rede elétrica exibida nesta cor.`);
    feederLine.on('click', () => { status.textContent = `Alimentador ${feeder} selecionado no mapa.`; });
    feederLine.addTo(networkLayer);
  }
  return { count: items.length, truncated };
}
async function loadAssets() {
  const selected = selectedFeeders();
  const network = await loadNetwork();
  if (!typeSet.size || selected?.length === 0) { layer.clearLayers(); status.textContent='Selecione ao menos um tipo de equipamento e um alimentador.'; return; }
  if (map.getZoom() < 11) { layer.clearLayers(); status.textContent=networkEnabled && map.getZoom() >= NETWORK_MIN_ZOOM ? `${network?.count?.toLocaleString('pt-BR') || 0} trechos de rede visíveis. Aproxime para carregar os equipamentos.` : `Aproxime o mapa para carregar os ativos${networkEnabled ? ` e a rede (zoom ${NETWORK_MIN_ZOOM} ou maior)` : ''}.`; return; }
  const params = boundsParams(1800); params.set('types',[...typeSet].join(','));
  const response = await fetch(`/api/assets?${params}`); if (!response.ok) return;
  const {items,truncated} = await response.json(); layer.clearLayers();
  for (const item of items) marker(item).addTo(layer);
  const networkText = networkEnabled ? ` · ${network?.count?.toLocaleString('pt-BR') || 0} trechos de rede` : '';
  status.textContent = `${items.length.toLocaleString('pt-BR')} ativos nesta área${networkText}${truncated || network?.truncated ? ' — aproxime o mapa para ver todos.' : '.'}`;
}
function routeTo(item) {
  if (!navigator.geolocation) { status.textContent='Este navegador não informa a localização atual.'; return; }
  status.textContent='Obtendo sua localização e calculando a rota…';
  navigator.geolocation.getCurrentPosition(position => {
    const origin=L.latLng(position.coords.latitude,position.coords.longitude), destination=L.latLng(item.latitude,item.longitude);
    if (routeControl) map.removeControl(routeControl);
    routeControl=L.Routing.control({ waypoints:[origin,destination], addWaypoints:false, draggableWaypoints:false, routeWhileDragging:false, show:false, createMarker:(index,waypoint)=>L.marker(waypoint.latLng,{icon:index?icon(item.asset_type):L.divIcon({className:'asset-marker',iconSize:[12,12],iconAnchor:[6,6]})}) }).addTo(map);
    map.fitBounds(L.latLngBounds([origin,destination]), {padding:[50,50]}); status.textContent=`Rota até ${item.operational_number} exibida no mapa.`;
  }, () => { status.textContent='Permita o acesso à sua localização para criar a rota.'; }, {enableHighAccuracy:true,timeout:10000});
}
function showCurrentLocation() {
  if (!navigator.geolocation) { status.textContent='Este navegador não informa a localização atual.'; return; }
  status.textContent='Obtendo sua localização atual…';
  navigator.geolocation.getCurrentPosition(position => {
    const location = L.latLng(position.coords.latitude, position.coords.longitude);
    if (currentLocationMarker) map.removeLayer(currentLocationMarker);
    if (currentLocationAccuracy) map.removeLayer(currentLocationAccuracy);
    currentLocationMarker = L.marker(location, { icon: L.divIcon({ className:'current-location-marker', iconSize:[18,18], iconAnchor:[9,9] }) }).addTo(map).bindTooltip('Sua localização', { direction:'top', offset:[0,-9] });
    currentLocationAccuracy = L.circle(location, { radius: position.coords.accuracy, className:'current-location-accuracy', interactive:false }).addTo(map);
    map.setView(location, Math.max(map.getZoom(), 16));
    status.textContent='Sua localização atual está exibida no mapa.';
  }, () => { status.textContent='Permita o acesso à sua localização para centralizar o mapa.'; }, { enableHighAccuracy:true, timeout:10000 });
}
const CurrentLocationControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar current-location-control');
    const button = L.DomUtil.create('button', 'current-location-button', container);
    button.type = 'button'; button.title = 'Ir para minha localização'; button.setAttribute('aria-label', 'Ir para minha localização');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4.5 20l7.5-4 7.5 4L12 2Zm0 4.8 3.4 8.1-3.4-1.8-3.4 1.8L12 6.8Z"/></svg>';
    L.DomEvent.disableClickPropagation(container); L.DomEvent.on(button, 'click', showCurrentLocation);
    return container;
  }
});
new CurrentLocationControl().addTo(map);
async function initialize() {
  const [types, feeders] = await Promise.all([fetch('/api/types').then(r=>r.json()),fetch('/api/feeders').then(r=>r.json())]);
  typeSet = new Set(types.map(t=>t.asset_type));
  filters.innerHTML = types.map(t=>`<label class="filter"><input type="checkbox" checked value="${escapeHtml(t.asset_type)}">${escapeHtml(displayAssetType(t.asset_type))} <small>(${t.count.toLocaleString('pt-BR')})</small></label>`).join('');
  assignFeederColors(feeders);
  feedersBox.innerHTML = feeders.map(f=>`<label class="feeder-filter" data-feeder="${escapeHtml(f.feeder).toLowerCase()}"><input type="checkbox" checked value="${escapeHtml(f.feeder)}"><i class="feeder-color" style="background:${feederColor(f.feeder)}"></i><span>${escapeHtml(f.feeder)}</span> <small>${f.segment_count.toLocaleString('pt-BR')} trechos</small></label>`).join('');
  refreshFeederSet();
  filters.addEventListener('change',()=>{refreshTypeSet();queueLoad()});
  feedersBox.addEventListener('change',()=>{refreshFeederSet();queueLoad()});
  document.querySelector('#feederSearch').addEventListener('input',event=>filterFeeders(event.target.value));
  document.querySelector('#feederSearchClear').onclick=()=>{const input=document.querySelector('#feederSearch');input.value='';filterFeeders('');input.focus()};
  document.querySelector('#feedersMatched').onclick=()=>{feedersBox.querySelectorAll('.feeder-filter').forEach(label=>{label.querySelector('input').checked=!label.hidden});refreshFeederSet();queueLoad()};
  document.querySelector('#feedersAll').onclick=()=>{feedersBox.querySelectorAll('input').forEach(input=>{input.checked=true});refreshFeederSet();queueLoad()};
  document.querySelector('#feedersNone').onclick=()=>{feedersBox.querySelectorAll('input').forEach(input=>{input.checked=false});refreshFeederSet();queueLoad()};
  document.querySelector('#typesAll').onclick=()=>{filters.querySelectorAll('input').forEach(input=>{input.checked=true});refreshTypeSet();queueLoad()};
  document.querySelector('#typesNone').onclick=()=>{filters.querySelectorAll('input').forEach(input=>{input.checked=false});refreshTypeSet();queueLoad()};
  networkVisible.addEventListener('change',()=>{networkEnabled=networkVisible.checked;queueLoad()});
  queueLoad();
}
async function search() {
  const q=document.querySelector('#search').value.trim(); if(q.length<2){results.classList.remove('show');return;}
  const numeric = /\d/.test(q);
  const [assets, streets] = await Promise.all([
    numeric ? fetch(`/api/search?q=${encodeURIComponent(q)}`).then(r=>r.ok?r.json():[]) : Promise.resolve([]),
    q.length >= 3 ? fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then(r=>r.ok?r.json():[]) : Promise.resolve([])
  ]);
  const items=[...assets,...streets];
  results.innerHTML=items.length?items.map((item,i)=>item.kind==='street'
    ? `<button class="result" data-i="${i}"><b>${escapeHtml(item.name)}</b><small>Rua / endereço</small></button>`
    : `<button class="result" data-i="${i}"><b>${escapeHtml(item.operational_number)} · ${escapeHtml(displayAssetType(item.asset_type))}</b><small>Alimentador ${escapeHtml(item.feeder)}</small></button>`).join(''):'<div class="result">Nenhum item encontrado.</div>';
  results.classList.add('show'); results.querySelectorAll('[data-i]').forEach(button=>button.onclick=()=>{const item=items[Number(button.dataset.i)];map.setView([item.latitude,item.longitude],item.kind==='street'?16:17);if(item.kind==='street'){L.popup().setLatLng([item.latitude,item.longitude]).setContent(`<b>${escapeHtml(item.name)}</b>`).openOn(map);}else{L.popup().setLatLng([item.latitude,item.longitude]).setContent(popup(item)).openOn(map);document.querySelector(`[data-route-id="${item.id}"]`)?.addEventListener('click',()=>routeTo(item));}results.classList.remove('show');});
}
const panel = document.querySelector('#panel'), panelToggle = document.querySelector('#panelToggle');
panelToggle.onclick = () => {
  const collapsed = panel.classList.toggle('collapsed');
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.setAttribute('aria-label', collapsed ? 'Expandir painel de filtros' : 'Recolher painel de filtros');
  panelToggle.querySelector('span').textContent = collapsed ? '›' : '‹';
};
document.querySelector('#searchButton').onclick=search; document.querySelector('#search').addEventListener('keydown',e=>{if(e.key==='Enter')search()}); map.on('moveend',queueLoad); initialize();

function createTelemetryId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function telemetryId(storage, key) {
  try {
    let value = storage.getItem(key);
    if (!value) { value = createTelemetryId(); storage.setItem(key, value); }
    return value;
  } catch { return createTelemetryId(); }
}
const telemetryVisitorId = telemetryId(localStorage, 'cpfl-visitor-id');
const telemetrySessionId = telemetryId(sessionStorage, 'cpfl-session-id');
const telemetryPayload = JSON.stringify({ sessionId: telemetrySessionId, visitorId: telemetryVisitorId });
function sendHeartbeat(keepalive = false) {
  return fetch('/api/telemetry/heartbeat', { method:'POST', headers:{'content-type':'application/json'}, body:telemetryPayload, keepalive }).catch(() => {});
}
sendHeartbeat();
setInterval(() => { if (!document.hidden) sendHeartbeat(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sendHeartbeat(); });
window.addEventListener('pagehide', () => { navigator.sendBeacon('/api/telemetry/heartbeat', new Blob([telemetryPayload], { type:'application/json' })); });
