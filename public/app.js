const map = L.map('map', { zoomControl: false }).setView([-22.35, -47.75], 8);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const layer = L.layerGroup().addTo(map), status = document.querySelector('#status'), filters = document.querySelector('#filters'), feedersBox = document.querySelector('#feeders'), results = document.querySelector('#results');
let typeSet = new Set(), feederSet = new Set(), timer, routeControl, currentLocationMarker, currentLocationAccuracy;
const colors = { Transformador:'#0f7593', Fusível:'#de7a22', Chave:'#6e57a5', Religador:'#ca4163', Regulador:'#3a8d52', Capacitor:'#be8b14' };
const typeLabels = { Chave: 'Chave Faca' };
function displayAssetType(type) { return typeLabels[type] || type; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function icon(type) { const c = colors[type] || '#0f7593'; return L.divIcon({ className:'asset-marker', iconSize:[10,10], iconAnchor:[5,5], html:`<span style="display:block;width:100%;height:100%;border-radius:50%;background:${c}"></span>` }); }
function googleMapsUrl(item) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${item.latitude},${item.longitude}`)}&travelmode=driving`; }
function popup(item) { return `<b>${escapeHtml(displayAssetType(item.asset_type))}</b><br>Número operativo: <strong>${escapeHtml(item.operational_number)}</strong><br>Alimentador: ${escapeHtml(item.feeder)}<div class="route-actions"><button class="route-button" data-route-id="${item.id}">Traçar no mapa</button><a class="google-route" href="${googleMapsUrl(item)}" target="_blank" rel="noopener">Abrir no Google Maps</a></div>`; }
function marker(item) { const point = L.marker([item.latitude,item.longitude], {icon:icon(item.asset_type), riseOnHover:true}).bindTooltip(`${displayAssetType(item.asset_type)} · ${item.operational_number}`, { direction:'top', offset:[0,-6] }).bindPopup(popup(item)); point.on('popupopen',()=>document.querySelector(`[data-route-id="${item.id}"]`)?.addEventListener('click',()=>routeTo(item))); return point; }
function queueLoad(){ clearTimeout(timer); timer=setTimeout(loadAssets,180); }
function refreshTypeSet() { typeSet = new Set([...filters.querySelectorAll('input:checked')].map(x=>x.value)); }
async function loadAssets() {
  if (!typeSet.size) { layer.clearLayers(); status.textContent='Selecione ao menos um tipo de equipamento.'; return; }
  if (map.getZoom() < 11) { layer.clearLayers(); status.textContent='Aproxime o mapa para carregar os ativos desta região.'; return; }
  const b = map.getBounds(), params = new URLSearchParams({west:b.getWest(),east:b.getEast(),south:b.getSouth(),north:b.getNorth(),limit:1800,types:[...typeSet].join(',')});
  if (feederSet.size) params.set('feeders', [...feederSet].join(','));
  const response = await fetch(`/api/assets?${params}`); if (!response.ok) return;
  const {items,truncated} = await response.json(); layer.clearLayers();
  for (const item of items) marker(item).addTo(layer);
  status.textContent = `${items.length.toLocaleString('pt-BR')} ativos nesta área${truncated ? ' — aproxime o mapa para ver todos.' : '.'}`;
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
  feedersBox.innerHTML = feeders.map(f=>`<label class="feeder-filter" data-feeder="${escapeHtml(f.feeder).toLowerCase()}"><input type="checkbox" value="${escapeHtml(f.feeder)}">${escapeHtml(f.feeder)} <small>(${f.count.toLocaleString('pt-BR')})</small></label>`).join('');
  filters.addEventListener('change',()=>{refreshTypeSet();queueLoad()});
  feedersBox.addEventListener('change',()=>{feederSet=new Set([...feedersBox.querySelectorAll('input:checked')].map(x=>x.value));queueLoad()});
  document.querySelector('#feederSearch').addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();feedersBox.querySelectorAll('.feeder-filter').forEach(el=>el.hidden=!!q&&!el.dataset.feeder.includes(q));});
  queueLoad();
}
async function search() {
  const q=document.querySelector('#search').value.trim(); if(q.length<2){results.classList.remove('show');return;}
  const items=await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  results.innerHTML=items.length?items.map((item,i)=>`<button class="result" data-i="${i}"><b>${escapeHtml(item.operational_number)} · ${escapeHtml(displayAssetType(item.asset_type))}</b><small>Alimentador ${escapeHtml(item.feeder)}</small></button>`).join(''):'<div class="result">Nenhum item encontrado.</div>';
  results.classList.add('show'); results.querySelectorAll('[data-i]').forEach(button=>button.onclick=()=>{const item=items[Number(button.dataset.i)];map.setView([item.latitude,item.longitude],17);L.popup().setLatLng([item.latitude,item.longitude]).setContent(popup(item)).openOn(map);document.querySelector(`[data-route-id="${item.id}"]`)?.addEventListener('click',()=>routeTo(item));results.classList.remove('show');});
}
document.querySelector('#searchButton').onclick=search; document.querySelector('#search').addEventListener('keydown',e=>{if(e.key==='Enter')search()}); map.on('moveend',queueLoad); initialize();
