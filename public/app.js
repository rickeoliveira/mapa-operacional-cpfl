const map = L.map('map', { zoomControl: false }).setView([-22.35, -47.75], 8);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const layer = L.layerGroup().addTo(map), status = document.querySelector('#status'), filters = document.querySelector('#filters'), feedersBox = document.querySelector('#feeders'), results = document.querySelector('#results');
let typeSet = new Set(), feederSet = new Set(), timer, routeControl;
const colors = { Transformador:'#0f7593', Fusível:'#de7a22', Chave:'#6e57a5', Religador:'#ca4163', Regulador:'#3a8d52', Capacitor:'#be8b14' };
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function icon(type) { const c = colors[type] || '#0f7593'; return L.divIcon({ className:'asset-marker', iconSize:[10,10], iconAnchor:[5,5], html:`<span style="display:block;width:100%;height:100%;border-radius:50%;background:${c}"></span>` }); }
function googleMapsUrl(item) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${item.latitude},${item.longitude}`)}&travelmode=driving`; }
function popup(item) { return `<b>${escapeHtml(item.asset_type)}</b><br>Número operativo: <strong>${escapeHtml(item.operational_number)}</strong><br>Alimentador: ${escapeHtml(item.feeder)}<div class="route-actions"><button class="route-button" data-route-id="${item.id}">Traçar no mapa</button><a class="google-route" href="${googleMapsUrl(item)}" target="_blank" rel="noopener">Abrir no Google Maps</a></div>`; }
function marker(item) { const point = L.marker([item.latitude,item.longitude], {icon:icon(item.asset_type), riseOnHover:true}).bindTooltip(`${item.asset_type} · ${item.operational_number}`, { direction:'top', offset:[0,-6] }).bindPopup(popup(item)); point.on('popupopen',()=>document.querySelector(`[data-route-id="${item.id}"]`)?.addEventListener('click',()=>routeTo(item))); return point; }
function queueLoad(){ clearTimeout(timer); timer=setTimeout(loadAssets,180); }
function refreshTypeSet() { typeSet = new Set([...filters.querySelectorAll('input:checked')].map(x=>x.value)); if (document.querySelector('#showSwitches').checked) typeSet.add('Chave'); }
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
async function initialize() {
  const [types, feeders] = await Promise.all([fetch('/api/types').then(r=>r.json()),fetch('/api/feeders').then(r=>r.json())]);
  typeSet = new Set(types.map(t=>t.asset_type));
  filters.innerHTML = types.filter(t=>t.asset_type!=='Chave').map(t=>`<label class="filter"><input type="checkbox" checked value="${escapeHtml(t.asset_type)}">${escapeHtml(t.asset_type)} <small>(${t.count.toLocaleString('pt-BR')})</small></label>`).join('');
  feedersBox.innerHTML = feeders.map(f=>`<label class="feeder-filter" data-feeder="${escapeHtml(f.feeder).toLowerCase()}"><input type="checkbox" value="${escapeHtml(f.feeder)}">${escapeHtml(f.feeder)} <small>(${f.count.toLocaleString('pt-BR')})</small></label>`).join('');
  filters.addEventListener('change',()=>{refreshTypeSet();queueLoad()}); document.querySelector('#showSwitches').addEventListener('change',()=>{refreshTypeSet();queueLoad()});
  feedersBox.addEventListener('change',()=>{feederSet=new Set([...feedersBox.querySelectorAll('input:checked')].map(x=>x.value));queueLoad()});
  document.querySelector('#feederSearch').addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();feedersBox.querySelectorAll('.feeder-filter').forEach(el=>el.hidden=!!q&&!el.dataset.feeder.includes(q));});
  queueLoad();
}
async function search() {
  const q=document.querySelector('#search').value.trim(); if(q.length<2){results.classList.remove('show');return;}
  const items=await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  results.innerHTML=items.length?items.map((item,i)=>`<button class="result" data-i="${i}"><b>${escapeHtml(item.operational_number)} · ${escapeHtml(item.asset_type)}</b><small>Alimentador ${escapeHtml(item.feeder)}</small></button>`).join(''):'<div class="result">Nenhum item encontrado.</div>';
  results.classList.add('show'); results.querySelectorAll('[data-i]').forEach(button=>button.onclick=()=>{const item=items[Number(button.dataset.i)];map.setView([item.latitude,item.longitude],17);L.popup().setLatLng([item.latitude,item.longitude]).setContent(popup(item)).openOn(map);document.querySelector(`[data-route-id="${item.id}"]`)?.addEventListener('click',()=>routeTo(item));results.classList.remove('show');});
}
document.querySelector('#searchButton').onclick=search; document.querySelector('#search').addEventListener('keydown',e=>{if(e.key==='Enter')search()}); map.on('moveend',queueLoad); initialize();
