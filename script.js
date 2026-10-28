"use strict";

/* =========================
   ROUTESAFE CONFIGURATION
========================= */

const CITIES = [
  { name: "Visakhapatnam", lat: 17.6868, lon: 83.2185 },
  { name: "Vijayawada", lat: 16.5062, lon: 80.6480 },
  { name: "Guntur", lat: 16.3067, lon: 80.4365 },
  { name: "Tirupati", lat: 13.6288, lon: 79.4192 },
  { name: "Nellore", lat: 14.4426, lon: 79.9865 },
  { name: "Kurnool", lat: 15.8281, lon: 78.0373 },
  { name: "Kadapa", lat: 14.4673, lon: 78.8242 },
  { name: "Anantapur", lat: 14.6819, lon: 77.6006 },
  { name: "Rajamahendravaram", lat: 17.0005, lon: 81.8040 },
  { name: "Kakinada", lat: 16.9891, lon: 82.2475 },
  { name: "Eluru", lat: 16.7107, lon: 81.0952 },
  { name: "Ongole", lat: 15.5057, lon: 80.0499 },
  { name: "Srikakulam", lat: 18.2949, lon: 83.8938 },
  { name: "Vizianagaram", lat: 18.1067, lon: 83.3956 },
  { name: "Machilipatnam", lat: 16.1809, lon: 81.1300 },
  { name: "Chittoor", lat: 13.2172, lon: 79.1003 },
  { name: "Hindupur", lat: 13.8281, lon: 77.4914 },
  { name: "Proddatur", lat: 14.7502, lon: 78.5481 },
  { name: "Amalapuram", lat: 16.5787, lon: 82.0061 }
];

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://nominatim.openstreetmap.org/search";
const ROUTING_URL = "https://router.project-osrm.org/route/v1/driving";
const INCIDENT_STORAGE_KEY = "routesafe.incidents.v1";

const $ = id => document.getElementById(id);

let selectedCity = CITIES[2];
let weatherData = null;
let weatherUpdatedAt = null;

let map;
let cityLayer;
let incidentLayer;
let zoneLayer;
let routeLayer;

let routes = [];
let activeRouteIndex = 0;
let currentRoute = null;
let currentInstructionIndex = 0;

let navigationWatchId = null;
let navigationActive = false;
let navigationPaused = false;
let lastAnnouncedInstruction = -1;

const weatherCache = new Map();
const notifiedWeatherAlerts = new Set();
let weatherNotificationsEnabled = false;

/* =========================
   INITIALIZATION
========================= */

function init() {
  populateCities();
  initMap();
  updateConnectionStatus();
  renderIncidents();
  loadWeather(selectedCity);

  // Refresh weather while the page is open.
  window.setInterval(() => {
    if (navigator.onLine && document.visibilityState === "visible") {
      loadWeather(selectedCity);
    }
  }, 15 * 60 * 1000);

  $("citySelect").addEventListener("change", event => {
    const city = CITIES.find(item => item.name === event.target.value);
    if (!city) return;

    selectedCity = city;
    map.setView([city.lat, city.lon], 10);
    loadWeather(city);
  });

  $("refreshBtn").addEventListener("click", () => {
    loadWeather(selectedCity, true);
  });

  $("alertSession").addEventListener("change", renderDynamicWeatherAlerts);
  $("enableNotifications").addEventListener("click", enableWeatherNotifications);

  $("resetMap").addEventListener("click", resetMap);

  $("showCities").addEventListener("change", toggleMapLayers);
  $("showIncidents").addEventListener("change", toggleMapLayers);
  $("showRoute").addEventListener("change", toggleMapLayers);

  $("routeForm").addEventListener("submit", handleRouteSearch);
  $("useLocation").addEventListener("click", useCurrentLocation);

  $("incidentForm").addEventListener("submit", submitIncident);
  $("incidentFilter").addEventListener("change", renderIncidents);

  $("voiceToggle").addEventListener("click", toggleVoice);
  $("readWeather").addEventListener("click", readWeather);
  $("readForecast").addEventListener("click", readForecast);
  $("muteVoice").addEventListener("click", stopSpeech);

  $("startNavigation").addEventListener("click", startNavigation);
  $("pauseNavigation").addEventListener("click", pauseNavigation);
  $("stopNavigation").addEventListener("click", stopNavigation);
  $("repeatInstruction").addEventListener("click", repeatInstruction);

  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.warn("Service worker registration failed:", error);
    });
  }
}

function populateCities() {
  const select = $("citySelect");
  select.replaceChildren();

  CITIES.forEach(city => {
    const option = document.createElement("option");
    option.value = city.name;
    option.textContent = city.name;
    select.appendChild(option);
  });

  select.value = selectedCity.name;
}

/* =========================
   INTERACTIVE MAP
========================= */

function initMap() {
  map = L.map("map").setView(
    [selectedCity.lat, selectedCity.lon],
    8
  );

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">' +
      "OpenStreetMap contributors</a>"
  }).addTo(map);

  cityLayer = L.layerGroup().addTo(map);
  incidentLayer = L.layerGroup().addTo(map);
  zoneLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  CITIES.forEach(city => {
    const marker = L.circleMarker([city.lat, city.lon], {
      radius: city.name === selectedCity.name ? 8 : 5,
      color: "#41d9e8",
      weight: 2,
      fillColor: "#287bff",
      fillOpacity: 0.9
    });

    marker.bindPopup(
      `<strong>${escapeHTML(city.name)}</strong><br>` +
      "Choose this city in the dashboard to view its weather."
    );

    marker.on("click", () => {
      $("citySelect").value = city.name;
      selectedCity = city;
      loadWeather(city);
    });

    marker.addTo(cityLayer);
  });

  // Click the map to choose an origin or destination.
  map.on("click", event => {
    const { lat, lng } = event.latlng;

    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Selected map location";

    const coords = document.createElement("p");
    coords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    const originButton = document.createElement("button");
    originButton.textContent = "Use as starting point";

    const destinationButton = document.createElement("button");
    destinationButton.textContent = "Use as destination";

    originButton.addEventListener("click", () => {
      $("origin").value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      map.closePopup();
    });

    destinationButton.addEventListener("click", () => {
      $("destination").value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      map.closePopup();
    });

    content.append(title, coords, originButton, document.createElement("br"),
      destinationButton);

    L.popup().setLatLng(event.latlng).setContent(content).openOn(map);
  });

  renderIncidents();
}

function resetMap() {
  stopNavigation();
  map.closePopup();
  routeLayer.clearLayers();
  routes = [];
  currentRoute = null;

  $("routeResults").replaceChildren();
  $("navigationControls").classList.add("hidden");

  map.setView([selectedCity.lat, selectedCity.lon], 8);
  $("routeMessage").textContent = "Map reset.";
}

function toggleMapLayers() {
  setLayerVisibility(cityLayer, $("showCities").checked);
  setLayerVisibility(incidentLayer, $("showIncidents").checked);
  setLayerVisibility(routeLayer, $("showRoute").checked);
}

function setLayerVisibility(layer, visible) {
  if (visible && !map.hasLayer(layer)) map.addLayer(layer);
  if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
}

/* =========================
   WEATHER DATA
========================= */

async function loadWeather(city, forceRefresh = false) {
  $("refreshBtn").disabled = true;
  $("lastUpdated").textContent = "Updating weather...";

  try {
    if (!navigator.onLine) {
      const cached = weatherCache.get(city.name);

      if (cached) {
        weatherData = cached.data;
        weatherUpdatedAt = cached.updatedAt;
        renderWeather(weatherData, city);
        $("lastUpdated").textContent =
          `Cached data · ${formatDate(weatherUpdatedAt)}`;
        return;
      }

      throw new Error("Offline and no weather data is cached in this session.");
    }

    const url = new URL(WEATHER_URL);

    url.search = new URLSearchParams({
      latitude: city.lat,
      longitude: city.lon,
      current: [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "precipitation",
        "rain",
        "showers",
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m"
      ].join(","),
      hourly: [
        "temperature_2m",
        "precipitation_probability",
        "precipitation",
        "wind_speed_10m",
        "weather_code"
      ].join(","),
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "precipitation_sum",
        "weather_code",
        "uv_index_max"
      ].join(","),
      timezone: "auto",
      forecast_days: "7"
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        cache: forceRefresh ? "no-store" : "default"
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Weather service returned HTTP ${response.status}.`);
    }

    const data = await response.json();

    if (!data.current || !data.hourly || !data.daily) {
      throw new Error("Weather service returned incomplete data.");
    }

    weatherData = data;
    weatherUpdatedAt = new Date();

    weatherCache.set(city.name, {
      data,
      updatedAt: weatherUpdatedAt
    });

    renderWeather(data, city);
    $("lastUpdated").textContent =
      `Updated ${formatDate(weatherUpdatedAt)}`;

  } catch (error) {
    console.error("Weather error:", error);

    const cached = weatherCache.get(city.name);

    if (cached) {
      weatherData = cached.data;
      weatherUpdatedAt = cached.updatedAt;
      renderWeather(cached.data, city);
      $("lastUpdated").textContent =
        `Cached · ${formatDate(cached.updatedAt)}`;
    } else {
      $("lastUpdated").textContent = "Weather unavailable";
      $("temperature").textContent = "--°C";
      $("feelsLike").textContent = "No current data available";
      $("humidity").textContent = "--%";
      $("wind").innerHTML = '-- <small>km/h</small>';
      $("windDirection").textContent = "Unavailable";
      $("rain").innerHTML = '-- <small>mm</small>';
      $("rainProbability").textContent = "Unavailable";
      $("hourlyForecast").textContent = "Forecast unavailable.";
      $("dailyForecast").textContent = "Forecast unavailable.";
      renderDynamicWeatherAlerts();
    }
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function renderWeather(data, city) {
  const current = data.current;

  $("temperature").textContent =
    formatNumber(current.temperature_2m) + "°C";

  $("feelsLike").textContent =
    `Feels like ${formatNumber(current.apparent_temperature)}°C`;

  $("humidity").textContent =
    formatNumber(current.relative_humidity_2m) + "%";

  $("wind").innerHTML =
    `${formatNumber(current.wind_speed_10m)} <small>km/h</small>`;

  $("windDirection").textContent =
    `Direction ${formatNumber(current.wind_direction_10m)}°`;

  $("rain").innerHTML =
    `${formatNumber(current.precipitation)} <small>mm</small>`;

  $("rainProbability").textContent =
    `Rain probability ${formatNumber(data.hourly.precipitation_probability?.[0])}%`;

  renderHourly(data.hourly);
  renderDaily(data.daily);
  renderDynamicWeatherAlerts();

  $("voiceStatus").textContent =
    `${city.name}: ${weatherDescription(current.weather_code)}. ` +
    `Current temperature ${current.temperature_2m}°C.`;

  const temp = Number(current.temperature_2m);
  $("temperature").style.color =
    temp >= 40 ? "var(--red)" :
    temp >= 35 ? "var(--orange)" : "var(--text)";
}

function renderHourly(hourly) {
  const container = $("hourlyForecast");
  container.replaceChildren();

  const now = Date.now();
  let start = hourly.time.findIndex(
    time => new Date(time).getTime() >= now
  );

  if (start < 0) start = 0;

  for (let i = start; i < Math.min(start + 8, hourly.time.length); i++) {
    const card = document.createElement("div");
    card.className = "hour-card";

    const time = document.createElement("div");
    time.className = "hour-time";
    time.textContent = new Date(hourly.time[i]).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });

    const temp = document.createElement("div");
    temp.className = "hour-temp";
    temp.textContent = `${formatNumber(hourly.temperature_2m[i])}°`;

    const conditions = document.createElement("div");
    conditions.className = "hour-time";
    conditions.textContent = weatherDescription(hourly.weather_code[i]);

    const rain = document.createElement("div");
    rain.className = "hour-rain";
    rain.textContent =
      `Rain ${formatNumber(hourly.precipitation_probability[i])}%`;

    card.append(time, temp, conditions, rain);
    container.appendChild(card);
  }
}

function renderDaily(daily) {
  const container = $("dailyForecast");
  container.replaceChildren();

  daily.time.forEach((date, i) => {
    const row = document.createElement("div");
    row.className = "daily-row";

    const day = document.createElement("div");
    day.className = "day-name";
    day.textContent = i === 0 ? "Today" :
      new Date(date + "T12:00:00").toLocaleDateString([], {
        weekday: "short"
      });

    const condition = document.createElement("div");
    condition.textContent = weatherEmoji(daily.weather_code[i]);
    condition.title = weatherDescription(daily.weather_code[i]);

    const min = document.createElement("div");
    min.className = "min-temp";
    min.textContent = `${formatNumber(daily.temperature_2m_min[i])}°`;

    const max = document.createElement("div");
    max.className = "max-temp";
    max.textContent = `${formatNumber(daily.temperature_2m_max[i])}°`;

    const bar = document.createElement("div");
    bar.className = "temp-bar";
    bar.title =
      `Rain probability: ${formatNumber(daily.precipitation_probability_max[i])}%`;

    row.append(day, condition, min, max, bar);
    container.appendChild(row);
  });
}

function weatherDescription(code) {
  const descriptions = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Freezing drizzle",
    57: "Heavy freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Severe thunderstorm with hail"
  };

  return descriptions[code] || "Conditions unavailable";
}

function weatherEmoji(code) {
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if ([3, 45, 48].includes(code)) return "☁️";
  if (code >= 51 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

/* =========================
   LOCATION SEARCH
========================= */

async function geocode(query) {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Enter a location.");

  const coordinateMatch = trimmed.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
  );

  if (coordinateMatch) {
    const lat = Number(coordinateMatch[1]);
    const lon = Number(coordinateMatch[2]);

    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error("The coordinates are outside valid ranges.");
    }

    return { lat, lon, name: trimmed };
  }

  const city = CITIES.find(
    item => item.name.toLowerCase() === trimmed.toLowerCase()
  );

  if (city) return { ...city, name: city.name };

  const url = new URL(GEOCODING_URL);
  url.search = new URLSearchParams({
    q: trimmed,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1"
  });

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("The location search service is unavailable.");
  }

  const results = await response.json();

  if (!results.length) {
    throw new Error(
      `Location "${trimmed}" was not found. Try a more specific address or nearby town.`
    );
  }

  return {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
    name: results[0].display_name
  };
}

/* =========================
   ROAD ROUTING
========================= */

async function handleRouteSearch(event) {
  event.preventDefault();
  stopNavigation();

  $("routeBtn").disabled = true;
  $("routeBtn").textContent = "Searching...";
  $("routeMessage").className = "message";
  $("routeMessage").textContent = "Finding locations and road routes...";
  $("routeResults").replaceChildren();
  $("navigationControls").classList.add("hidden");

  try {
    const originText = $("origin").value;
    const destinationText = $("destination").value;
    const mode = $("travelMode").value;

    // The public OSRM endpoint configured below supports driving routes.
    if (mode !== "driving") {
      throw new Error(
        "This routing endpoint currently provides driving routes only. " +
        "Walking and cycling require a routing service configured for those modes."
      );
    }

    const [origin, destination] = await Promise.all([
      geocode(originText),
      geocode(destinationText)
    ]);

    const url = new URL(
      `${ROUTING_URL}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}`
    );

    url.search = new URLSearchParams({
      overview: "full",
      geometries: "geojson",
      steps: "true",
      alternatives: "true",
      continue_straight: "false"
    });

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Routing service returned HTTP ${response.status}.`);
    }

    const data = await response.json();

    if (data.code !== "Ok" || !data.routes?.length) {
      throw new Error(
        "No route was returned. Check the locations or try another destination."
      );
    }

    routes = data.routes;
    activeRouteIndex = 0;
    currentInstructionIndex = 0;

    currentRoute = {
      origin,
      destination,
      mode,
      route: routes[0]
    };

    drawRoutes();
    renderRouteOptions();
    renderTurnList();

    $("navigationControls").classList.remove("hidden");
    $("routeMessage").className = "message success";
    $("routeMessage").textContent =
      `Found ${routes.length} available road route(s). ` +
      "Reported hazards are not comprehensively checked by this routing service.";

    map.fitBounds(
      L.latLngBounds([
        [origin.lat, origin.lon],
        [destination.lat, destination.lon]
      ]),
      { padding: [45, 45] }
    );

  } catch (error) {
    console.error("Routing error:", error);
    $("routeMessage").className = "message error";
    $("routeMessage").textContent = error.message;
  } finally {
    $("routeBtn").disabled = false;
    $("routeBtn").textContent = "Find available routes →";
  }
}

function drawRoutes() {
  routeLayer.clearLayers();

  routes.forEach((route, index) => {
    const coordinates = route.geometry.coordinates.map(
      ([lon, lat]) => [lat, lon]
    );

    const line = L.polyline(coordinates, {
      color: index === activeRouteIndex ? "#41d9e8" : "#687b99",
      weight: index === activeRouteIndex ? 7 : 4,
      opacity: index === activeRouteIndex ? 0.95 : 0.65
    }).addTo(routeLayer);

    line.on("click", () => selectRoute(index));
  });

  const firstRoute = routes[activeRouteIndex];

  if (firstRoute) {
    const coordinates = firstRoute.geometry.coordinates;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];

    L.marker([first[1], first[0]])
      .bindPopup("Starting point")
      .addTo(routeLayer);

    L.marker([last[1], last[0]])
      .bindPopup("Destination")
      .addTo(routeLayer);
  }

  toggleMapLayers();
}

function renderRouteOptions() {
  const container = $("routeResults");
  container.replaceChildren();

  routes.forEach((route, index) => {
    const card = document.createElement("div");
    card.className = "route-option";

    if (index === activeRouteIndex) card.classList.add("selected");

    const title = document.createElement("h3");
    title.textContent = index === 0 ? "Suggested route" : `Alternative ${index}`;

    const distance = document.createElement("p");
    distance.textContent = `Distance: ${(route.distance / 1000).toFixed(1)} km`;

    const duration = document.createElement("p");
    duration.textContent = `Estimated time: ${formatDuration(route.duration)}`;

    const arrival = document.createElement("p");
    arrival.className = "route-meta";
    arrival.textContent =
      `Estimated arrival: ${new Date(Date.now() + route.duration * 1000)
        .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    const safety = document.createElement("p");
    safety.textContent =
      "Hazard exposure is not independently verified. Road closures and flooding may be missing.";

    const button = document.createElement("button");
    button.className = "btn btn-outline";
    button.textContent =
      index === activeRouteIndex ? "Selected route" : "Select route";
    button.disabled = index === activeRouteIndex;
    button.addEventListener("click", () => selectRoute(index));

    card.append(title, distance, duration, arrival, safety, button);
    container.appendChild(card);
  });
}

function selectRoute(index) {
  if (!routes[index]) return;

  activeRouteIndex = index;
  currentInstructionIndex = 0;
  lastAnnouncedInstruction = -1;
  currentRoute.route = routes[index];

  drawRoutes();
  renderRouteOptions();
  renderTurnList();

  if (navigationActive) announceCurrentInstruction();
}

function renderTurnList() {
  const list = $("turnList");
  if (!list) return;

  list.replaceChildren();

  const steps = currentRoute?.route?.legs?.[0]?.steps || [];

  if (!steps.length) {
    const item = document.createElement("li");
    item.textContent = "No turn-by-turn steps are available for this route.";
    list.appendChild(item);
    return;
  }

  steps.forEach((step, index) => {
    const item = document.createElement("li");
    const maneuver = step.maneuver || {};
    const action = [
      maneuver.type?.replaceAll("_", " "),
      maneuver.modifier
    ].filter(Boolean).join(" ");

    const road = step.name || "unnamed road";
    const distance = Number(step.distance || 0);

    const distanceText = distance >= 1000
      ? `${(distance / 1000).toFixed(1)} km`
      : `${Math.round(distance)} m`;

    item.textContent =
      `${index + 1}. ${action || "Continue"} on ${road}` +
      (distance ? ` for ${distanceText}` : "");

    if (index === currentInstructionIndex) item.classList.add("active");
    list.appendChild(item);
  });
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return hours ? `${hours} hr ${remainder} min` : `${remainder} min`;
}

/* =========================
   GPS AND VOICE NAVIGATION
========================= */

function useCurrentLocation() {
  if (!navigator.geolocation) {
    $("routeMessage").textContent =
      "Your browser does not support location access.";
    return;
  }

  $("routeMessage").textContent = "Requesting location permission...";

  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;

      $("origin").value =
        `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

      map.setView([latitude, longitude], 15);

      L.circleMarker([latitude, longitude], {
        radius: 8,
        color: "#35d49a",
        fillColor: "#35d49a",
        fillOpacity: 0.8
      }).bindPopup("Your reported current location").addTo(map);

      $("routeMessage").textContent =
        "Starting location filled from your current GPS position.";
    },
    error => {
      $("routeMessage").className = "message error";
      $("routeMessage").textContent =
        `Location unavailable: ${error.message}. Enter a location manually.`;
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

function startNavigation() {
  if (!currentRoute?.route) {
    $("nextInstruction").textContent = "Calculate a route first.";
    return;
  }

  if (!navigator.geolocation) {
    $("nextInstruction").textContent =
      "GPS is unavailable. Route instructions can be read manually.";
    announceCurrentInstruction();
    return;
  }

  navigationActive = true;
  navigationPaused = false;
  currentInstructionIndex = 0;
  lastAnnouncedInstruction = -1;

  $("pauseNavigation").textContent = "Ⅱ Pause";

  renderTurnList();
  announceCurrentInstruction();

  if (navigationWatchId !== null) {
    navigator.geolocation.clearWatch(navigationWatchId);
  }

  navigationWatchId = navigator.geolocation.watchPosition(
    handleNavigationPosition,
    error => {
      $("nextInstruction").textContent =
        `GPS update unavailable: ${error.message}`;
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 15000
    }
  );
}

function handleNavigationPosition(position) {
  if (!navigationActive || navigationPaused || !currentRoute?.route) return;

  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const steps = currentRoute.route.legs?.[0]?.steps || [];

  if (!steps.length) return;

  let bestIndex = currentInstructionIndex;
  let bestDistance = Infinity;

  // Prototype proximity check against upcoming manoeuvre points.
  for (
    let i = currentInstructionIndex;
    i < Math.min(steps.length, currentInstructionIndex + 6);
    i++
  ) {
    const location = steps[i].maneuver?.location;
    if (!location) continue;

    const distance = haversineMeters(
      lat, lon, location[1], location[0]
    );

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  if (bestDistance < 90 && bestIndex > currentInstructionIndex) {
    currentInstructionIndex = bestIndex;
    renderTurnList();
    announceCurrentInstruction();
  }

  if (bestDistance > 250 && currentInstructionIndex > 0) {
    $("nextInstruction").textContent =
      "You may be off the planned route. Stop safely and recalculate if needed.";
  }
}

function pauseNavigation() {
  if (!navigationActive) return;

  navigationPaused = !navigationPaused;

  $("pauseNavigation").textContent =
    navigationPaused ? "▶ Resume" : "Ⅱ Pause";

  if (!navigationPaused) announceCurrentInstruction();
  else stopSpeech();
}

function stopNavigation() {
  navigationActive = false;
  navigationPaused = false;

  if (navigationWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(navigationWatchId);
    navigationWatchId = null;
  }

  if ($("pauseNavigation")) {
    $("pauseNavigation").textContent = "Ⅱ Pause";
  }

  if ($("nextInstruction")) {
    $("nextInstruction").textContent = "Navigation stopped.";
  }

  stopSpeech();
}

function getCurrentInstruction() {
  const steps = currentRoute?.route?.legs?.[0]?.steps || [];

  if (!steps.length) return "No turn-by-turn instructions were returned.";

  if (currentInstructionIndex >= steps.length) {
    return "You have reached the final route instruction.";
  }

  const step = steps[currentInstructionIndex];
  const type = step.maneuver?.type || "continue";
  const modifier = step.maneuver?.modifier || "";
  const road = step.name || "the road";
  const distance = Number(step.distance || 0);

  let action = type.replaceAll("_", " ");
  if (modifier) action += ` ${modifier}`;

  return distance > 0
    ? `In ${Math.round(distance)} metres, ${action} onto ${road}.`
    : `${action} onto ${road}.`;
}

function announceCurrentInstruction() {
  const message = getCurrentInstruction();
  $("nextInstruction").textContent = message;

  if (lastAnnouncedInstruction === currentInstructionIndex) return;

  lastAnnouncedInstruction = currentInstructionIndex;
  speak(message);
}

function repeatInstruction() {
  const message = $("nextInstruction").textContent;
  if (message) speak(message);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) *
    Math.cos(radians(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 6371000 * 2 *
    Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =========================
   WEATHER ALERTS BY SESSION
========================= */

function getSessionHours() {
  const session = $("alertSession")?.value || "next24";

  if (session === "current") return 0;

  if (session === "today") {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);

    return Math.max(1, Math.ceil((midnight - now) / 3600000));
  }

  return session === "next48" ? 48 : 24;
}

function collectWeatherAlerts() {
  if (!weatherData?.current || !weatherData?.hourly) return [];

  const session = $("alertSession")?.value || "next24";
  const alerts = [];
  const now = Date.now();

  function add(key, title, severity, message, timeLabel, source) {
    const existing = alerts.find(alert => alert.key === key);
    const rank = { low: 1, medium: 2, high: 3 };

    if (!existing || rank[severity] > rank[existing.severity]) {
      if (existing) alerts.splice(alerts.indexOf(existing), 1);

      alerts.push({
        key, title, severity, message, timeLabel, source
      });
    }
  }

  if (session === "current") {
    const current = weatherData.current;
    const code = Number(current.weather_code);
    const temp = Number(current.temperature_2m);
    const wind = Number(current.wind_speed_10m);
    const precip = Number(current.precipitation);

    if (temp >= 40) {
      add("heat", "Extreme heat", "high",
        `Current temperature is ${temp}°C. Reduce exertion, seek shade and hydrate.`,
        "Now", "Current weather data");
    } else if (temp >= 35) {
      add("heat", "High temperature", "medium",
        `Current temperature is ${temp}°C. Limit strenuous outdoor activity.`,
        "Now", "Current weather data");
    }

    if (wind >= 70) {
      add("wind", "Very strong wind", "high",
        `Current wind speed is ${wind} km/h. Take shelter and check official advice.`,
        "Now", "Current weather data");
    } else if (wind >= 50) {
      add("wind", "Strong wind", "medium",
        `Current wind speed is ${wind} km/h. Use caution outdoors and on exposed roads.`,
        "Now", "Current weather data");
    }

    if (code >= 95) {
      add("storm", "Thunderstorm conditions", "high",
        "Thunderstorm weather code is reported. Avoid exposed areas and follow local advisories.",
        "Now", "Current weather code");
    } else if ([45, 48].includes(code)) {
      add("fog", "Fog / reduced visibility", "medium",
        "Fog is indicated. Slow down and use appropriate lights.",
        "Now", "Current weather code");
    }

    if (precip >= 7) {
      add("rain", "Heavy precipitation", "high",
        `Current precipitation is ${precip} mm. Do not drive through floodwater.`,
        "Now", "Current weather data");
    }
  } else {
    const hours = getSessionHours();
    const times = weatherData.hourly.time || [];

    let startIndex = times.findIndex(
      time => new Date(time).getTime() >= now - 3600000
    );

    if (startIndex < 0) startIndex = 0;

    const end = Math.min(times.length, startIndex + hours);

    for (let i = startIndex; i < end; i++) {
      const temp = Number(weatherData.hourly.temperature_2m?.[i]);
      const rainProb =
        Number(weatherData.hourly.precipitation_probability?.[i]);
      const rainMm = Number(weatherData.hourly.precipitation?.[i]);
      const wind = Number(weatherData.hourly.wind_speed_10m?.[i]);
      const code = Number(weatherData.hourly.weather_code?.[i]);

      const when = times[i]
        ? new Date(times[i]).toLocaleString([], {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit"
          })
        : "Forecast period";

      if (Number.isFinite(temp) && temp >= 40) {
        add("heat", "Extreme heat", "high",
          `Forecast temperature reaches ${temp}°C. Reduce outdoor exertion and hydrate.`,
          when, "Hourly forecast");
      } else if (Number.isFinite(temp) && temp >= 35) {
        add("heat", "High temperature", "medium",
          `Forecast temperature reaches ${temp}°C. Seek shade and take breaks.`,
          when, "Hourly forecast");
      }

      if (Number.isFinite(wind) && wind >= 70) {
        add("wind", "Very strong wind", "high",
          `Forecast wind reaches ${wind} km/h. Check official advice before travelling.`,
          when, "Hourly forecast");
      } else if (Number.isFinite(wind) && wind >= 50) {
        add("wind", "Strong wind", "medium",
          `Forecast wind reaches ${wind} km/h. Use caution on exposed roads.`,
          when, "Hourly forecast");
      }

      if (code >= 95) {
        add("storm", "Thunderstorm risk", "high",
          "Thunderstorm conditions appear in the forecast. Avoid exposed areas.",
          when, "Hourly forecast");
      } else if ([45, 48].includes(code)) {
        add("fog", "Fog / reduced visibility", "medium",
          "Fog appears in the forecast. Allow extra stopping distance.",
          when, "Hourly forecast");
      }

      if (
        Number.isFinite(rainProb) &&
        rainProb >= 80 &&
        Number.isFinite(rainMm) &&
        rainMm >= 7
      ) {
        add("rain", "Heavy rain potential", "high",
          `Rain probability ${rainProb}% with ${rainMm} mm forecast for an hour. Flooding is not confirmed.`,
          when, "Hourly forecast");
      } else if (Number.isFinite(rainProb) && rainProb >= 60) {
        add("rain", "Rain likely", "medium",
          `Rain probability reaches ${rainProb}%. Wet roads and reduced visibility are possible.`,
          when, "Hourly forecast");
      }

      if (code >= 71 && code <= 86) {
        add("snow", "Snow / ice conditions", "medium",
          "Snow-related weather code appears in the forecast. This may be irrelevant to local conditions.",
          when, "Hourly forecast");
      }

      if (Number.isFinite(temp) && temp <= 5) {
        add("cold", "Very cold conditions", "medium",
          `Forecast temperature reaches ${temp}°C. Watch for cold exposure and possible ice where relevant.`,
          when, "Hourly forecast");
      }
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function renderDynamicWeatherAlerts() {
  const summary = $("liveAlertSummary");
  const container = $("dynamicAlertList");

  if (!summary || !container) return;

  if (!weatherData?.current) {
    summary.className = "message";
    summary.textContent =
      "Weather data is unavailable. No live alert assessment can be made.";

    container.replaceChildren();
    updateWeatherZone(null);
    return;
  }

  const alerts = collectWeatherAlerts();

  const sessionLabel =
    $("alertSession").selectedOptions[0]?.textContent || "Selected period";

  summary.className =
    `message ${
      alerts.some(a => a.severity === "high") ? "error" :
      alerts.length ? "" : "success"
    }`;

  summary.textContent =
    `${selectedCity.name} · ${sessionLabel}: ` +
    `${alerts.length} threshold alert${alerts.length === 1 ? "" : "s"} detected. ` +
    "These are forecast-derived estimates, not official warnings.";

  container.replaceChildren();

  if (!alerts.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      "No configured alert thresholds were triggered. This does not guarantee safe conditions.";
    container.appendChild(empty);
  } else {
    alerts.forEach(alert => {
      const card = document.createElement("article");
      card.className = `alert-card ${alert.severity}`;

      const heading = document.createElement("h3");
      heading.textContent = alert.title;

      const tag = document.createElement("span");
      tag.className = "alert-tag";
      tag.textContent = alert.severity.toUpperCase();

      const message = document.createElement("p");
      message.textContent = alert.message;

      const meta = document.createElement("p");
      meta.textContent =
        `${alert.timeLabel} · ${alert.source} · ${selectedCity.name}`;

      card.append(heading, tag, message, meta);
      container.appendChild(card);
    });
  }

  const highest =
    alerts.some(a => a.severity === "high") ? "high" :
    alerts.some(a => a.severity === "medium") ? "medium" : "low";

  updateWeatherZone(highest);

  if (weatherNotificationsEnabled) {
    notifyNewWeatherAlerts(alerts);
  }
}

function updateWeatherZone(level) {
  if (!zoneLayer || !map) return;

  zoneLayer.clearLayers();
  if (level === null) return;

  const config = level === "high"
    ? {
        color: "#ff667c",
        radius: 9000,
        label: "High concern (forecast threshold)"
      }
    : level === "medium"
      ? {
          color: "#ffb454",
          radius: 6500,
          label: "Caution (forecast threshold)"
        }
      : {
          color: "#35d49a",
          radius: 4000,
          label: "Watch / no configured threshold triggered"
        };

  // Illustrative city-level radius, not an official hazard boundary.
  L.circle([selectedCity.lat, selectedCity.lon], {
    radius: config.radius,
    color: config.color,
    weight: 2,
    dashArray: "7 6",
    fillColor: config.color,
    fillOpacity: 0.08
  })
    .bindPopup(
      `<strong>${escapeHTML(selectedCity.name)} weather zone</strong><br>` +
      `${escapeHTML(config.label)}<br>` +
      "Illustrative city-level radius; not an official hazard boundary."
    )
    .addTo(zoneLayer);
}

async function enableWeatherNotifications() {
  if (!("Notification" in window)) {
    $("liveAlertSummary").textContent =
      "This browser does not support desktop notifications. Alerts remain visible on the page.";
    return;
  }

  if (Notification.permission === "denied") {
    $("liveAlertSummary").textContent =
      "Notifications are blocked in browser settings. Alerts remain visible on the page.";
    return;
  }

  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();

  if (permission !== "granted") {
    $("liveAlertSummary").textContent =
      "Notification permission was not granted. Alerts remain visible on the page.";
    return;
  }

  weatherNotificationsEnabled = true;
  $("enableNotifications").textContent = "Notifications enabled";
  $("enableNotifications").disabled = true;

  notifyNewWeatherAlerts(collectWeatherAlerts());
}

function notifyNewWeatherAlerts(alerts) {
  if (!weatherNotificationsEnabled || Notification.permission !== "granted") {
    return;
  }

  alerts.forEach(alert => {
    const key =
      `${selectedCity.name}|${$("alertSession").value}|${alert.key}|${alert.severity}`;

    if (notifiedWeatherAlerts.has(key)) return;
    notifiedWeatherAlerts.add(key);

    try {
      new Notification(`RouteSafe: ${alert.title}`, {
        body: `${selectedCity.name}: ${alert.message}`,
        tag: key
      });
    } catch (error) {
      console.warn("Notification could not be displayed:", error);
    }
  });
}

/* =========================
   INCIDENT REPORTING
========================= */

function getIncidents() {
  try {
    const data = JSON.parse(
      localStorage.getItem(INCIDENT_STORAGE_KEY) || "[]"
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveIncidents(incidents) {
  try {
    localStorage.setItem(
      INCIDENT_STORAGE_KEY,
      JSON.stringify(incidents)
    );
    return true;
  } catch (error) {
    console.error("Incident storage error:", error);
    return false;
  }
}

async function submitIncident(event) {
  event.preventDefault();

  const file = $("incidentPhoto").files[0];

  if (file) {
    const allowed = ["image/jpeg", "image/png", "image/webp"];

    if (!allowed.includes(file.type)) {
      alert("Use a JPEG, PNG or WebP image.");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      alert("The image must be smaller than 2 MB.");
      return;
    }
  }

  const incident = {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: $("incidentType").value,
    severity: $("incidentSeverity").value,
    location: $("incidentLocation").value.trim(),
    description: $("incidentDescription").value.trim(),
    reportedAt: new Date().toISOString(),
    status: "New",
    photoName: file ? file.name : null,
    source: "User-submitted",
    latitude: null,
    longitude: null
  };

  // Geocode the incident location for map display if possible.
  try {
    const place = await geocode(incident.location);
    incident.latitude = place.lat;
    incident.longitude = place.lon;
    incident.location = place.name;
  } catch (error) {
    console.warn("Incident coordinates unavailable:", error.message);
  }

  const incidents = getIncidents();
  incidents.unshift(incident);

  if (!saveIncidents(incidents)) {
    alert("Could not save the report. Browser storage may be full.");
    return;
  }

  $("incidentForm").reset();
  renderIncidents();

  alert(
    file
      ? "Incident saved locally. The photo filename was recorded, but the photo itself was not stored."
      : "Incident saved locally. Other users cannot see this report."
  );
}

function renderIncidents() {
  if (!incidentLayer) return;

  incidentLayer.clearLayers();

  const incidents = getIncidents();
  const filter = $("incidentFilter").value;

  const visible = incidents.filter(incident =>
    filter === "All" || incident.status === filter
  );

  const container = $("incidentList");
  container.replaceChildren();

  // Add geocoded incident markers.
  incidents.forEach(incident => {
    if (
      Number.isFinite(incident.latitude) &&
      Number.isFinite(incident.longitude)
    ) {
      L.marker([incident.latitude, incident.longitude])
        .bindPopup(
          `<strong>${escapeHTML(incident.type)}</strong><br>` +
          `${escapeHTML(incident.location)}<br>` +
          `Severity: ${escapeHTML(incident.severity)}<br>` +
          `Status: ${escapeHTML(incident.status)}<br>` +
          "User report — not independently verified"
        )
        .addTo(incidentLayer);
    }
  });

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No reports match this filter.";
    container.appendChild(empty);
    return;
  }

  visible.forEach(incident => {
    const card = document.createElement("article");
    card.className = "incident-item";

    const details = document.createElement("div");

    const heading = document.createElement("h3");
    heading.textContent = incident.type;

    const badge = document.createElement("span");
    badge.className = `severity ${incident.severity}`;
    badge.textContent = incident.severity;

    const location = document.createElement("p");
    location.textContent = `Location: ${incident.location}`;

    const time = document.createElement("p");
    time.textContent =
      `Reported: ${new Date(incident.reportedAt).toLocaleString()}`;

    const status = document.createElement("p");
    status.textContent =
      `Status: ${incident.status} · User-submitted, unverified`;

    details.append(heading, badge, location, time, status);

    if (incident.description) {
      const description = document.createElement("p");
      description.textContent = incident.description;
      details.appendChild(description);
    }

    if (incident.photoName) {
      const photo = document.createElement("p");
      photo.textContent = `Photo selected: ${incident.photoName} (not stored)`;
      details.appendChild(photo);
    }

    const actions = document.createElement("div");
    actions.className = "incident-actions";

    const locate = document.createElement("button");
    locate.className = "btn btn-outline";
    locate.textContent = "View on map";
    locate.disabled =
      !Number.isFinite(incident.latitude) ||
      !Number.isFinite(incident.longitude);

    locate.addEventListener("click", () => {
      map.setView([incident.latitude, incident.longitude], 15);

      L.popup()
        .setLatLng([incident.latitude, incident.longitude])
        .setContent(escapeHTML(incident.type))
        .openOn(map);
    });

    const statusButton = document.createElement("button");
    statusButton.className = "btn btn-outline";
    statusButton.textContent =
      incident.status === "Resolved" ? "Mark new" : "Mark resolved";

    statusButton.addEventListener("click", () => {
      updateIncidentStatus(
        incident.id,
        incident.status === "Resolved" ? "New" : "Resolved"
      );
    });

    const remove = document.createElement("button");
    remove.className = "btn btn-outline";
    remove.textContent = "Delete";

    remove.addEventListener("click", () => {
      if (confirm("Delete this local incident report?")) {
        saveIncidents(
          getIncidents().filter(item => item.id !== incident.id)
        );
        renderIncidents();
      }
    });

    actions.append(locate, statusButton, remove);
    card.append(details, actions);
    container.appendChild(card);
  });
}

function updateIncidentStatus(id, status) {
  const incidents = getIncidents().map(incident =>
    incident.id === id ? { ...incident, status } : incident
  );

  saveIncidents(incidents);
  renderIncidents();
}

/* =========================
   VOICE WEATHER ASSISTANT
========================= */

function speak(text) {
  if (!("speechSynthesis" in window)) {
    $("voiceStatus").textContent = text;
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = $("speechLanguage").value;
  utterance.rate = Number($("speechRate").value) || 1;

  utterance.onstart = () => {
    $("voiceStatus").textContent = `Speaking: ${text}`;
  };

  utterance.onend = () => {
    $("voiceStatus").textContent = "Voice announcement finished.";
  };

  utterance.onerror = () => {
    $("voiceStatus").textContent =
      "Speech is unavailable. Read the displayed text instead.";
  };

  window.speechSynthesis.speak(utterance);
}

function stopSpeech() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  $("voiceStatus").textContent = "Speech stopped.";
}

function toggleVoice() {
  const button = $("voiceToggle");
  const enabled = button.dataset.enabled !== "true";

  button.dataset.enabled = String(enabled);
  button.textContent = enabled ? "🔊 Voice On" : "🔇 Voice Off";

  if (!enabled) stopSpeech();
  else readWeather();
}

function readWeather() {
  if (!weatherData?.current) {
    speak("Current weather data is unavailable.");
    return;
  }

  const current = weatherData.current;
  const rainProbability =
    weatherData.hourly.precipitation_probability?.[0];

  const updateTime = weatherUpdatedAt
    ? formatDate(weatherUpdatedAt)
    : "unknown";

  speak(
    `RouteSafe weather update for ${selectedCity.name}. ` +
    `The current temperature is ${current.temperature_2m} degrees Celsius. ` +
    `Feels like ${current.apparent_temperature} degrees. ` +
    `Wind speed is ${current.wind_speed_10m} kilometres per hour. ` +
    `Relative humidity is ${current.relative_humidity_2m} percent. ` +
    `Precipitation is ${current.precipitation} millimetres. ` +
    `Forecast precipitation probability is ${rainProbability ?? "unavailable"} percent. ` +
    `Weather last retrieved at ${updateTime}.`
  );
}

function readForecast() {
  if (!weatherData?.daily) {
    speak("The daily forecast is unavailable.");
    return;
  }

  const daily = weatherData.daily;

  const message = daily.time.map((date, index) => {
    const day = new Date(date + "T12:00:00").toLocaleDateString([], {
      weekday: "long"
    });

    return `${day}: minimum ${daily.temperature_2m_min[index]} degrees, ` +
      `maximum ${daily.temperature_2m_max[index]} degrees, ` +
      `${weatherDescription(daily.weather_code[index])}, ` +
      `precipitation probability ${daily.precipitation_probability_max[index]} percent.`;
  }).join(" ");

  speak(`Seven day forecast for ${selectedCity.name}. ${message}`);
}

/* =========================
   HELPER FUNCTIONS
========================= */

function updateConnectionStatus() {
  const status = $("connectionStatus");

  if (navigator.onLine) {
    status.textContent = "● Online";
    status.className = "status online";
  } else {
    status.textContent = "● Offline";
    status.className = "status offline";
  }
}

function formatNumber(value) {
  return Number.isFinite(Number(value))
    ? Number(value).toFixed(1)
    : "--";
}

function formatDate(value) {
  return new Date(value).toLocaleString([], {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

document.addEventListener("DOMContentLoaded", init);