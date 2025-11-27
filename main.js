document.addEventListener('DOMContentLoaded', () => {
    // Referencias a elementos del DOM
    const svg = document.getElementById('map-svg');
    const stationSearchInput = document.getElementById('station-search');
    const searchResults = document.getElementById('search-results');
    const trainListContent = document.getElementById('train-list-content');
    const currentTimeDisplay = document.getElementById('current-time');
    
    // Estado de la aplicación
    let gtfsData = null;
    let activeTrips = [];
    let shapes = {};
    let stops = {};
    let routes = {};
    let trips = {};
    
    let viewBox = { x: 0, y: 0, width: 1000, height: 1000 };
    let isPanning = false;
    let startPoint = { x: 0, y: 0 };
    let selectedStopId = null;

    // --- 1. INICIALIZACIÓN ---
    async function initialize() {
        gtfsData = await loadGtfsData();
        if (!gtfsData) return;

        processGtfsData();
        setupMap();
        drawMap();
        
        stationSearchInput.addEventListener('input', handleStationSearch);
        setupPanAndZoom();
        
        requestAnimationFrame(animate); // Iniciar el bucle de animación
    }

    // --- 2. PROCESAMIENTO DE DATOS GTFS ---
    function processGtfsData() {
        // Indexar datos para un acceso rápido
        gtfsData.stops.forEach(s => stops[s.stop_id] = s);
        gtfsData.routes.forEach(r => routes[r.route_id] = r);
        gtfsData.trips.forEach(t => trips[t.trip_id] = t);
        
        // Agrupar puntos de 'shapes' por shape_id
        gtfsData.shapes.forEach(p => {
            if (!shapes[p.shape_id]) {
                shapes[p.shape_id] = [];
            }
            shapes[p.shape_id].push({
                lat: parseFloat(p.shape_pt_lat),
                lon: parseFloat(p.shape_pt_lon),
                seq: parseInt(p.shape_pt_sequence),
                dist: parseFloat(p.shape_dist_traveled) || 0
            });
        });

        // Ordenar y calcular distancias si no están presentes
        for (const shapeId in shapes) {
            shapes[shapeId].sort((a, b) => a.seq - b.seq);
            if (shapes[shapeId].every(p => p.dist === 0)) {
                let cumulativeDist = 0;
                for (let i = 1; i < shapes[shapeId].length; i++) {
                    const prev = shapes[shapeId][i-1];
                    const curr = shapes[shapeId][i];
                    cumulativeDist += haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
                    curr.dist = cumulativeDist;
                }
            }
        }
        
        // Identificar viajes activos para el día de hoy
        findActiveTrips();
    }
    
    function findActiveTrips() {
        const now = new Date();
        const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
        const todayStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;

        const activeServices = new Set();
        // Servicios regulares
        gtfsData.calendar.forEach(c => {
            if (c[dayOfWeek] === '1' && c.start_date <= todayStr && c.end_date >= todayStr) {
                activeServices.add(c.service_id);
            }
        });
        // Excepciones (adiciones/eliminaciones)
        gtfsData.calendar_dates.forEach(cd => {
            if (cd.date === todayStr) {
                if (cd.exception_type === '1') {
                    activeServices.add(cd.service_id);
                } else if (cd.exception_type === '2') {
                    activeServices.delete(cd.service_id);
                }
            }
        });

        // Filtrar viajes por servicios activos y obtener sus paradas
        const activeTripIds = gtfsData.trips.filter(t => activeServices.has(t.service_id)).map(t => t.trip_id);
        
        const stopTimesByTrip = {};
        gtfsData.stop_times.forEach(st => {
            if (!stopTimesByTrip[st.trip_id]) {
                stopTimesByTrip[st.trip_id] = [];
            }
            stopTimesByTrip[st.trip_id].push({
                stop_id: st.stop_id,
                time: timeToSeconds(st.arrival_time),
                seq: parseInt(st.stop_sequence),
                dist: parseFloat(st.shape_dist_traveled) || 0
            });
        });
        
        activeTripIds.forEach(tripId => {
            const tripInfo = trips[tripId];
            const tripStops = stopTimesByTrip[tripId];
            if (tripInfo && tripStops && tripStops.length > 0) {
                tripStops.sort((a, b) => a.seq - b.seq);
                activeTrips.push({
                    id: tripId,
                    shape_id: tripInfo.shape_id,
                    route_id: tripInfo.route_id,
                    headsign: tripInfo.trip_headsign,
                    stop_times: tripStops
                });
            }
        });
        
        console.log(`Encontrados ${activeTrips.length} viajes activos para hoy.`);
    }

    // --- 3. RENDERIZADO DEL MAPA ---
    let projection;

    function setupMap() {
        // Calcular los límites del mapa para centrar y escalar
        const allPoints = Object.values(shapes).flat();
        if (allPoints.length === 0) return;

        const minLon = Math.min(...allPoints.map(p => p.lon));
        const maxLon = Math.max(...allPoints.map(p => p.lon));
        const minLat = Math.min(...allPoints.map(p => p.lat));
        const maxLat = Math.max(...allPoints.map(p => p.lat));

        const mapWidth = svg.clientWidth;
        const mapHeight = svg.clientHeight;
        const scaleX = mapWidth / (maxLon - minLon);
        const scaleY = mapHeight / (maxLat - minLat);
        const scale = Math.min(scaleX, scaleY) * 0.9; // 90% del espacio
        
        projection = (lon, lat) => {
            const x = (lon - minLon) * scale;
            const y = (maxLat - lat) * scale; // Invertir Y
            return { x, y };
        };

        const projectedWidth = (maxLon - minLon) * scale;
        const projectedHeight = (maxLat - minLat) * scale;
        viewBox.x = -(mapWidth - projectedWidth) / 2;
        viewBox.y = -(mapHeight - projectedHeight) / 2;
        viewBox.width = mapWidth;
        viewBox.height = mapHeight;
        
        svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
    }

    function drawMap() {
        svg.innerHTML = ''; // Limpiar mapa
        const linesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        linesGroup.id = 'lines-group';
        const stationsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        stationsGroup.id = 'stations-group';
        
        // Dibujar líneas (shapes)
        for (const shapeId in shapes) {
            const pathData = shapes[shapeId].map(p => {
                const { x, y } = projection(p.lon, p.lat);
                return `${x},${y}`;
            }).join(' ');

            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', pathData);
            polyline.setAttribute('class', 'line');
            linesGroup.appendChild(polyline);
        }

        // Dibujar estaciones (stops)
        for (const stopId in stops) {
            const stop = stops[stopId];
            if (!stop.stop_lon || !stop.stop_lat) continue;

            const { x, y } = projection(parseFloat(stop.stop_lon), parseFloat(stop.stop_lat));

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', x);
            circle.setAttribute('cy', y);
            circle.setAttribute('r', 5);
            circle.setAttribute('class', 'station');
            circle.dataset.stopId = stopId;
            
            circle.addEventListener('click', () => handleStationClick(stopId));
            
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', x);
            label.setAttribute('y', y - 10);
            label.setAttribute('class', 'station-label');
            label.textContent = stop.stop_name;
            
            stationsGroup.appendChild(circle);
            stationsGroup.appendChild(label);
        }

        svg.appendChild(linesGroup);
        svg.appendChild(stationsGroup);

        const trainsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        trainsGroup.id = 'trains-group';
        svg.appendChild(trainsGroup);
    }
    
    // --- 4. LÓGICA DE ANIMACIÓN ---
    function animate() {
        const now = new Date();
        const secondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        currentTimeDisplay.textContent = now.toLocaleTimeString();

        const trainsGroup = document.getElementById('trains-group');
        if (!trainsGroup) return;
        
        const activeTrainPositions = [];
        
        activeTrips.forEach(trip => {
            const tripStops = trip.stop_times;
            const startTime = tripStops[0].time;
            const endTime = tripStops[tripStops.length - 1].time;
            
            if (secondsSinceMidnight >= startTime && secondsSinceMidnight <= endTime) {
                // Encontrar el segmento actual (entre dos paradas)
                let prevStop, nextStop;
                for (let i = 0; i < tripStops.length - 1; i++) {
                    if (secondsSinceMidnight >= tripStops[i].time && secondsSinceMidnight < tripStops[i+1].time) {
                        prevStop = tripStops[i];
                        nextStop = tripStops[i+1];
                        break;
                    }
                }

                if (prevStop && nextStop) {
                    const segmentDuration = nextStop.time - prevStop.time;
                    const timeIntoSegment = secondsSinceMidnight - prevStop.time;
                    const progress = timeIntoSegment / segmentDuration;

                    // Interpolar posición en la polilínea (shape)
                    const shape = shapes[trip.shape_id];
                    if (shape) {
                        const prevStopDist = prevStop.dist;
                        const nextStopDist = nextStop.dist;
                        const currentDist = prevStopDist + (nextStopDist - prevStopDist) * progress;

                        const pos = getPositionOnShape(shape, currentDist);
                        if (pos) {
                           activeTrainPositions.push({ id: trip.id, x: pos.x, y: pos.y, route_id: trip.route_id });
                        }
                    }
                }
            }
        });

        updateTrainElements(trainsGroup, activeTrainPositions);

        requestAnimationFrame(animate);
    }

    function getPositionOnShape(shape, distance) {
        if (!shape || shape.length < 2) return null;

        // Encontrar el segmento de la polilínea que contiene la distancia
        let prevPoint, nextPoint;
        for (let i = 1; i < shape.length; i++) {
            if (shape[i].dist >= distance) {
                prevPoint = shape[i-1];
                nextPoint = shape[i];
                break;
            }
        }

        if (prevPoint && nextPoint) {
            const segmentDist = nextPoint.dist - prevPoint.dist;
            const distIntoSegment = distance - prevPoint.dist;
            const progress = (segmentDist > 0) ? (distIntoSegment / segmentDist) : 0;
            
            const p1 = projection(prevPoint.lon, prevPoint.lat);
            const p2 = projection(nextPoint.lon, nextPoint.lat);

            return {
                x: p1.x + (p2.x - p1.x) * progress,
                y: p1.y + (p2.y - p1.y) * progress,
            };
        }
        return null; // Fuera de rango
    }
    
    function updateTrainElements(group, trainPositions) {
        const existingTrains = new Map();
        group.querySelectorAll('.train').forEach(t => existingTrains.set(t.id, t));
        
        trainPositions.forEach(train => {
            let trainEl = existingTrains.get(`train-${train.id}`);
            if (!trainEl) {
                trainEl = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                trainEl.id = `train-${train.id}`;
                trainEl.setAttribute('class', 'train');
                trainEl.setAttribute('r', 6);
                const routeInfo = routes[train.route_id];
                if (routeInfo && routeInfo.route_color) {
                    trainEl.style.fill = `#${routeInfo.route_color}`;
                }
                group.appendChild(trainEl);
            }
            
            trainEl.setAttribute('cx', train.x);
            trainEl.setAttribute('cy', train.y);

            existingTrains.delete(trainEl.id);
        });

        // Eliminar trenes que ya no están activos
        existingTrains.forEach(trainEl => trainEl.remove());
    }

    // --- 5. INTERACTIVIDAD ---
    function handleStationClick(stopId) {
        // Deseleccionar anterior
        if (selectedStopId) {
            const prevStationEl = svg.querySelector(`.station[data-stop-id="${selectedStopId}"]`);
            if (prevStationEl) prevStationEl.classList.remove('selected');
        }
        
        // Seleccionar nueva
        const stationEl = svg.querySelector(`.station[data-stop-id="${stopId}"]`);
        if (stationEl) stationEl.classList.add('selected');
        selectedStopId = stopId;
        
        updateSidebarWithStationInfo(stopId);
    }
    
    function handleStationSearch(event) {
        const query = event.target.value.toLowerCase();
        searchResults.innerHTML = '';
        if (query.length < 3) return;

        const matchedStops = gtfsData.stops.filter(s => s.stop_name.toLowerCase().includes(query)).slice(0, 50);

        matchedStops.forEach(stop => {
            const li = document.createElement('li');
            li.textContent = stop.stop_name;
            li.dataset.stopId = stop.stop_id;
            li.addEventListener('click', () => {
                handleStationClick(stop.stop_id);
                stationSearchInput.value = stop.stop_name;
                searchResults.innerHTML = '';
            });
            searchResults.appendChild(li);
        });
    }
    
    function updateSidebarWithStationInfo(stopId) {
        const stop = stops[stopId];
        if (!stop) return;

        const now = new Date();
        const secondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

        const upcomingDepartures = [];

        activeTrips.forEach(trip => {
            trip.stop_times.forEach(st => {
                if (st.stop_id === stopId && st.time > secondsSinceMidnight) {
                    const route = routes[trip.route_id];
                    upcomingDepartures.push({
                        time: st.time,
                        headsign: trip.headsign,
                        route_short_name: route ? route.route_short_name : 'N/A',
                        route_color: route ? route.route_color : 'gray'
                    });
                }
            });
        });
        
        upcomingDepartures.sort((a,b) => a.time - b.time);
        
        trainListContent.innerHTML = '';
        if (upcomingDepartures.length === 0) {
            trainListContent.innerHTML = `<p class="placeholder">No hay próximos trenes para esta estación.</p>`;
            return;
        }

        upcomingDepartures.slice(0, 10).forEach(dep => {
            const departureTime = new Date(dep.time * 1000).toISOString().substr(11, 5);
            const item = document.createElement('div');
            item.className = 'train-item';
            item.innerHTML = `
                <div class="train-item-header">
                    <span class="train-destination">${dep.headsign}</span>
                    <span class="train-time">${departureTime}</span>
                </div>
                <div class="train-line" style="background-color: #${dep.route_color}">${dep.route_short_name}</div>
            `;
            trainListContent.appendChild(item);
        });
    }

    // --- 6. CONTROLES DE PAN & ZOOM ---
    function setupPanAndZoom() {
        const mapContainer = document.getElementById('map-container');
        
        mapContainer.addEventListener('mousedown', e => {
            isPanning = true;
            startPoint = { x: e.clientX, y: e.clientY };
            mapContainer.style.cursor = 'grabbing';
        });

        mapContainer.addEventListener('mousemove', e => {
            if (!isPanning) return;
            const endPoint = { x: e.clientX, y: e.clientY };
            const dx = (startPoint.x - endPoint.x) * (viewBox.width / mapContainer.clientWidth);
            const dy = (startPoint.y - endPoint.y) * (viewBox.height / mapContainer.clientHeight);
            viewBox.x += dx;
            viewBox.y += dy;
            svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
            startPoint = endPoint;
        });

        mapContainer.addEventListener('mouseup', () => {
            isPanning = false;
            mapContainer.style.cursor = 'grab';
        });
        mapContainer.addEventListener('mouseleave', () => {
            isPanning = false;
            mapContainer.style.cursor = 'grab';
        });

        mapContainer.addEventListener('wheel', e => {
            e.preventDefault();
            const zoomFactor = 1.1;
            const { clientX, clientY } = e;
            
            const point = svg.createSVGPoint();
            point.x = clientX;
            point.y = clientY;
            const { x: svgX, y: svgY } = point.matrixTransform(svg.getScreenCTM().inverse());

            const scale = e.deltaY < 0 ? 1 / zoomFactor : zoomFactor;

            viewBox.x = svgX + (viewBox.x - svgX) * scale;
            viewBox.y = svgY + (viewBox.y - svgY) * scale;
            viewBox.width *= scale;
            viewBox.height *= scale;
            
            svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
        });

        document.getElementById('zoom-in').addEventListener('click', () => zoom(0.8));
        document.getElementById('zoom-out').addEventListener('click', () => zoom(1.2));
        document.getElementById('zoom-reset').addEventListener('click', () => {
            setupMap(); // Recalcula la vista inicial
        });
    }

    function zoom(scale) {
        const centerX = viewBox.x + viewBox.width / 2;
        const centerY = viewBox.y + viewBox.height / 2;
        viewBox.width *= scale;
        viewBox.height *= scale;
        viewBox.x = centerX - viewBox.width / 2;
        viewBox.y = centerY - viewBox.height / 2;
        svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
    }

    // Iniciar la aplicación
    initialize();
});
