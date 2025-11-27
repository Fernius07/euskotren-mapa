function parseCsv(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].trim().split(',').map(h => h.replace(/"/g, ''));
    const data = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].trim().split(',');
        const obj = {};
        for (let j = 0; j < headers.length; j++) {
            const value = values[j] ? values[j].replace(/"/g, '') : '';
            obj[headers[j]] = value;
        }
        data.push(obj);
    }
    return data;
}

async function loadGtfsData(basePath = './gtfs/') {
    const files = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt', 'calendar.txt', 'calendar_dates.txt'];
    const promises = files.map(file => 
        fetch(basePath + file)
            .then(res => {
                if (!res.ok) throw new Error(`No se pudo cargar ${file}`);
                return res.text();
            })
            .then(text => parseCsv(text))
    );

    try {
        const [stops, routes, trips, stopTimes, shapes, calendar, calendarDates] = await Promise.all(promises);
        
        console.log("Datos GTFS cargados y parseados:", { stops, routes, trips, stopTimes, shapes, calendar, calendarDates });

        return { stops, routes, trips, stopTimes, shapes, calendar, calendarDates };
    } catch (error) {
        console.error("Error al cargar los datos GTFS:", error);
        alert("Fallo al cargar los datos GTFS. Revisa la consola para más detalles y asegúrate de que los archivos están en la carpeta /gtfs.");
        return null;
    }
}

function timeToSeconds(timeString) {
    const [h, m, s] = timeString.split(':').map(Number);
    return h * 3600 + m * 60 + s;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Radio de la Tierra en metros
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // en metros
}
