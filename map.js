
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// =====================================
// MAPBOX SETUP
// =====================================

mapboxgl.accessToken =
  'pk.eyJ1Ijoia3Jpc3Rlbi1vbGVzb24iLCJhIjoiY213azgybDJzMDJnNTJ4bjF0Ynl1b3hhZiJ9.csD0-eX52x3vPi_d4ABp1Q';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18
});

map.addControl(
  new mapboxgl.NavigationControl(),
  'top-left'
);

const svg = d3.select('#map svg');
const slider = document.querySelector('#time-slider');
const selectedTime = document.querySelector('#selected-time');
const anyTimeLabel = document.querySelector('#any-time');
const status = document.querySelector('#status');

// =====================================
// COLORS AND SCALES
// =====================================

const departureColor = '#2678b9';
const balancedColor = '#a188ac';
const arrivalColor = '#f38a30';

const stationFlow = d3.scaleQuantize()
  .domain([0, 1])
  .range([0, 0.5, 1]);

// =====================================
// HELPER FUNCTIONS
// =====================================

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  const date = new Date(2024, 2, 1, hours, mins);

  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getCoords(station) {
  const point = map.project([
    station.lon,
    station.lat
  ]);

  return {
    cx: point.x,
    cy: point.y
  };
}

// Check whether a trip time is within one hour
// of the selected time, including across midnight.
function withinTimeWindow(time, selected) {
  if (selected === -1) return true;

  const difference = Math.abs(time - selected);

  return Math.min(
    difference,
    1440 - difference
  ) <= 60;
}

// =====================================
// CALCULATE STATION TRAFFIC
// =====================================

function computeStationTraffic(stations, trips, timeFilter = -1) {
  const departures = new Map();
  const arrivals = new Map();

  for (const trip of trips) {
    const startTime = minutesSinceMidnight(trip.started_at);
    const endTime = minutesSinceMidnight(trip.ended_at);

    if (withinTimeWindow(startTime, timeFilter)) {
      const id = trip.start_station_id;

      departures.set(
        id,
        (departures.get(id) ?? 0) + 1
      );
    }

    if (withinTimeWindow(endTime, timeFilter)) {
      const id = trip.end_station_id;

      arrivals.set(
        id,
        (arrivals.get(id) ?? 0) + 1
      );
    }
  }

  return stations.map(station => {
    const id = String(station.short_name);

    const arriving = arrivals.get(id) ?? 0;
    const departing = departures.get(id) ?? 0;

    return {
      ...station,
      arrivals: arriving,
      departures: departing,
      totalTraffic: arriving + departing
    };
  });
}

// =====================================
// ADD BIKE LANES
// =====================================

async function addBikeLanes(id, url) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const geojson = await response.json();

    map.addSource(id, {
      type: 'geojson',
      data: geojson
    });

    map.addLayer({
      id: id,
      type: 'line',
      source: id,
      paint: {
        'line-color': '#24a36d',
        'line-width': 3,
        'line-opacity': 0.65
      }
    });

  } catch (error) {
    console.warn(`Unable to load ${id}:`, error);
  }
}

// =====================================
// LOAD MAP AND DATA
// =====================================

map.on('load', async () => {

  // Load Boston and Cambridge bike lanes
  await Promise.all([
    addBikeLanes(
      'boston-bikes',
      'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson'
    ),

    addBikeLanes(
      'cambridge-bikes',
      'https://data.cambridgema.gov/resource/9aey-9g9p.geojson?$limit=5000'
    )
  ]);

  try {
    status.textContent = 'Loading Bluebikes data...';

    // =====================================
    // IMPORT STATION AND TRIP DATA
    // =====================================

    const [stationJson, trips] = await Promise.all([
      d3.json(
        'https://dsc106.com/labs/lab07/data/bluebikes-stations.json'
      ),

      d3.csv(
        'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
        trip => ({
          ...trip,
          started_at: new Date(
            trip.started_at.replace(' ', 'T')
          ),
          ended_at: new Date(
            trip.ended_at.replace(' ', 'T')
          )
        })
      )
    ]);

    // Extract station array
    const rawStations =
      stationJson.data?.stations ??
      stationJson.stations ??
      stationJson;

    // Normalize station coordinates and IDs
    const stations = rawStations.map(station => ({
      ...station,

      lon: Number(
        station.lon ??
        station.Long ??
        station.longitude ??
        station.Lon
      ),

      lat: Number(
        station.lat ??
        station.Lat ??
        station.latitude
      ),

      short_name: String(
        station.short_name ??
        station.Number ??
        station.number ??
        ''
      )
    })).filter(station =>
      Number.isFinite(station.lon) &&
      Number.isFinite(station.lat)
    );

    // =====================================
    // INITIAL TRAFFIC
    // =====================================

    const initialStations = computeStationTraffic(
      stations,
      trips
    );

    // Scale circle area proportionally to traffic
    const radiusScale = d3.scaleSqrt()
      .domain([
        0,
        d3.max(initialStations, d => d.totalTraffic) || 1
      ])
      .range([0, 25]);

    // =====================================
    // CREATE STATION CIRCLES
    // =====================================

    const circles = svg
      .selectAll('circle')
      .data(initialStations, d => d.short_name)
      .join('circle');

    // =====================================
    // POSITION STATIONS ON MAP
    // =====================================

    function updatePositions() {
      circles
        .attr('cx', d => getCoords(d).cx)
        .attr('cy', d => getCoords(d).cy);
    }

    // =====================================
    // UPDATE MAP BASED ON TIME FILTER
    // =====================================

    function updateScatterPlot() {
      const timeFilter = Number(slider.value);

      // Update time display
      if (timeFilter === -1) {
        selectedTime.textContent = '';
        anyTimeLabel.style.display = 'block';
      } else {
        selectedTime.textContent = formatTime(timeFilter);
        anyTimeLabel.style.display = 'none';
      }

      // Recalculate station traffic
      const filteredStations = computeStationTraffic(
        stations,
        trips,
        timeFilter
      );

      // Adjust marker sizes
      radiusScale.range(
        timeFilter === -1
          ? [0, 25]
          : [3, 50]
      );

      // =====================================
      // UPDATE CIRCLES
      // =====================================

      circles
        .data(filteredStations, d => d.short_name)

        // Circle radius
        .attr('r', d =>
          d.totalTraffic === 0
            ? 0
            : radiusScale(d.totalTraffic)
        )

        // Circle color based on traffic direction
        .attr('fill', d => {
          if (d.totalTraffic === 0) {
            return balancedColor;
          }

          const ratio = stationFlow(
            d.departures / d.totalTraffic
          );

          if (ratio === 1) return departureColor;
          if (ratio === 0) return arrivalColor;

          return balancedColor;
        })

        // Add tooltips
        .each(function(d) {
          d3.select(this)
            .selectAll('title')
            .data([d])
            .join('title')
            .text(station =>
              `${station.name ?? station.NAME ?? 'Bluebikes station'}
Total trips: ${station.totalTraffic}
Departures: ${station.departures}
Arrivals: ${station.arrivals}`
            );
        });

      updatePositions();
    }

    // =====================================
    // MAP INTERACTIONS
    // =====================================

    map.on('move', updatePositions);
    map.on('zoom', updatePositions);
    map.on('resize', updatePositions);
    map.on('moveend', updatePositions);

    // Update visualization when slider moves
    slider.addEventListener(
      'input',
      updateScatterPlot
    );

    // Initial visualization
    updateScatterPlot();

    status.textContent =
      `${stations.length} stations and ` +
      `${trips.length.toLocaleString()} rides loaded`;

  } catch (error) {
    console.error('Data loading error:', error);

    status.textContent =
      'Error loading bike data. Check the browser console.';
  }
});

