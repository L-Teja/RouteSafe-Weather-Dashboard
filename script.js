"use strict";

/* =========================================
   ROUTESAFE CONFIGURATION
========================================= */

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

const ROUTING_URLS = {
  driving: "https://router.project-osrm.org/route/v1/driving",
  cycling: "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
  walking: "https://routing.openstreetmap.de/routed-foot/route/v1/driving"
};

const INCIDENT_KEY = "routesafe.incidents.v2";
const $ = id => document.getElementById(id);

let selectedCity = CITIES.find(city => city.name === "Guntur");
let weatherData = null;
let weatherUpdatedAt = null;

let map;
let cityLayer;
let incidentLayer;
let zoneLayer;
let routeLayer;
let userLocationMarker = null;

let routes = [];
let selectedRouteIndex = 0;
let currentRoute = null;
let currentStepIndex = 0;

let gpsWatchId = null;
let navigationRunning = false;
let navigationPaused = false;
let lastSpokenStep = -1;

let voiceRecognition = null;
let voiceListening = false;
let notificationsEnabled = false;

const weatherCache = new Map();
const notifiedAlerts = new Set();

/* =========================================
   STARTUP
========================================= */

document.addEventListener("DOMContentLoaded", init);

function init() {
  populateCities();
  initMap();
  bindEvents();
  updateConnectionStatus();
  renderIncidents();
  loadWeather(selectedCity);

  if ("serviceWorker" in navigator &&
      ["http:", "https:"].includes(location.protocol)) {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.warn("Service worker registration failed:", error);
    });
  }

  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);

  window.setInterval(() => {
    if (navigator.onLine && document.visibilityState === "visible") {
      loadWeather(selectedCity);
    }
  }, 15 * 60 * 1000);
}

function bindEvents() {
  $("citySelect").addEventListener("change", () => {
    const city = CITIES.find(item => item.name === $("citySelect").value);
    if (!city) return;

    selectedCity = city;
    map.setView([city.lat, city.lon], 13);
    loadWeather(city);
  });

  $("refreshBtn").addEventListener("click", () => {
    loadWeather(selectedCity, true);
  });

  $("routeForm").addEventListener("submit", handleRouteSearch);
  $("useLocation").addEventListener("click", useCurrentLocation);
  $("resetMap").addEventListener("click", resetMap);

  $("showCities").addEventListener("change", toggleMapLayers);
  $("showIncidents").addEventListener("change", toggleMapLayers);
  $("showRoute").addEventListener("change", toggleMapLayers);

  $("incidentForm").addEventListener("submit", submitIncident);
  $("incidentFilter").addEventListener("change", renderIncidents);

  $("alertSession").addEventListener("change", renderWeatherAlerts);
  $("enableNotifications").addEventListener("click", enableNotifications);

  $("readWeather").addEventListener("click", readWeather);
  $("readForecast").addEventListener("click", readForecast);
  $("muteVoice").addEventListener("click", stopSpeech);
  $("voiceToggle").addEventListener("click", toggleVoiceCommands);

  $("startNavigation").addEventListener("click", startNavigation);
  $("pauseNavigation").addEventListener("click", pauseNavigation);
  $("stopNavigation").addEventListener("click", stopNavigation);
  $("repeatInstruction").addEventListener("click", repeatInstruction);
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

/* =========================================
   MAP AND STREET LAYERS
========================================= */

function initMap() {
  map = L.map("map").setView(
    [selectedCity.lat, selectedCity.lon],
    13
  );

  const streets = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">' +
        "OpenStreetMap contributors</a>"
    }
  );

  const humanitarian = L.tileLayer(
    "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors, HOT"
    }
  );

  streets.addTo(map);

  L.control.layers({
    "OpenStreetMap streets": streets,
    "Humanitarian map": humanitarian
  }).addTo(map);

  L.control.scale({ imperial: false }).addTo(map);

  cityLayer = L.layerGroup().addTo(map);
  incidentLayer = L.layerGroup().addTo(map);
  zoneLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  CITIES.forEach(city => {
    const marker = L.circleMarker([city.lat, city.lon], {
      radius: city.name === selectedCity.name ? 8 : 5,
      color: "#41d9e8",
      fillColor: "#287bff",
      fillOpacity: 0.9,
      weight: 2
    });

    marker.bindPopup(`<strong>${escapeHTML(city.name)}</strong>`);

    marker.on("click", () => {
      selectedCity = city;
      $("citySelect").value = city.name;
      map.setView([city.lat, city.lon], 13);
      loadWeather(city);
    });

    marker.addTo(cityLayer);
  });

  map.on("click", event => {
    const lat = event.latlng.lat;
    const lon = event.latlng.lng;

    const popup = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = "Selected map point";

    const coordinates = document.createElement("p");
    coordinates.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

    const originButton = document.createElement("button");
    originButton.textContent = "Set as start";
    originButton.onclick = () => {
      $("origin").value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      map.closePopup();
    };

    const destinationButton = document.createElement("button");
    destinationButton.textContent = "Set as destination";
    destinationButton.onclick = () => {
      $("destination").value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      map.closePopup();
    };

    popup.append(
      heading,
      coordinates,
      originButton,
      document.createElement("br"),
      destinationButton
    );

    L.popup().setLatLng(event.latlng).setContent(popup).openOn(map);
  });
}

function toggleMapLayers() {
  setLayerVisible(cityLayer, $("showCities").checked);
  setLayerVisible(incidentLayer, $("showIncidents").checked);
  setLayerVisible(routeLayer, $("showRoute").checked);
}

function setLayerVisible(layer, visible) {
  if (!map || !layer) return;

  if (visible && !map.hasLayer(layer)) map.addLayer(layer);
  if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
}

function resetMap() {
  stopNavigation();
  routeLayer.clearLayers();

  routes = [];
  currentRoute = null;

  $("routeResults").replaceChildren();
  $("navigationControls").classList.add("hidden");
  $("routeMessage").textContent = "Map reset.";

  map.setView([selectedCity.lat, selectedCity.lon], 13);
}

/* =========================================
   WEATHER API
========================================= */

async function loadWeather(city, forceRefresh = false) {
  $("refreshBtn").disabled = true;
  $("lastUpdated").textContent = "Updating weather…";

  try {
    if (!navigator.onLine) {
      const cached = weatherCache.get(city.name);
      if (!cached) throw new Error("You are offline and no cached data is available.");

      weatherData = cached.data;
      weatherUpdatedAt = cached.updatedAt;
      renderWeather(city);
      $("lastUpdated").textContent =
        `Cached data · ${formatDate(weatherUpdatedAt)}`;
      return;
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
        "weather_code",
        "wind_speed_10m",
        "wind_direction_10m"
      ].join(","),
      hourly: [
        "temperature_2m",
        "precipitation_probability",
        "precipitation",
        "weather_code",
        "wind_speed_10m"
      ].join(","),
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "weather_code",
        "uv_index_max"
      ].join(","),
      forecast_days: "7",
      timezone: "auto"
    });

    const response = await fetch(url, {
      cache: forceRefresh ? "no-store" : "default"
    });

    if (!response.ok) {
      throw new Error(`Weather service error: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.current || !data.hourly || !data.daily) {
      throw new Error("Weather data is incomplete.");
    }

    weatherData = data;
    weatherUpdatedAt = new Date();

    weatherCache.set(city.name, {
      data,
      updatedAt: weatherUpdatedAt
    });

    renderWeather(city);
    $("lastUpdated").textContent = `Updated ${formatDate(weatherUpdatedAt)}`;

  } catch (error) {
    console.error(error);
    const cached = weatherCache.get(city.name);

    if (cached) {
      weatherData = cached.data;
      weatherUpdatedAt = cached.updatedAt;
      renderWeather(city);
      $("lastUpdated").textContent =
        `Showing cached data · ${formatDate(cached.updatedAt)}`;
    } else {
      $("lastUpdated").textContent = "Weather unavailable";
      $("temperature").textContent = "--°C";
      $("feelsLike").textContent = "No current data";
      $("humidity").textContent = "--%";
      $("wind").textContent = "-- km/h";
      $("windDirection").textContent = "--";
      $("rain").textContent = "-- mm";
      $("rainProbability").textContent = "--";
      $("weatherDescription").textContent = "Unable to load weather";
      $("weatherEmoji").textContent = "🌡️";
      $("hourlyForecast").textContent = "Forecast unavailable.";
      $("dailyForecast").textContent = "Forecast unavailable.";
      renderWeatherAlerts();
    }
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function renderWeather(city) {
  if (!weatherData) return;

  const current = weatherData.current;
  const code = Number(current.weather_code);
  const temperature = Number(current.temperature_2m);

  $("weatherDescription").textContent = weatherDescription(code);
  $("weatherEmoji").textContent = weatherEmoji(code);
  $("temperature").textContent = `${formatNumber(temperature)}°C`;
  $("feelsLike").textContent =
    `Feels like ${formatNumber(current.apparent_temperature)}°C`;
  $("humidity").textContent =
    `${formatNumber(current.relative_humidity_2m)}%`;
  $("wind").innerHTML =
    `${formatNumber(current.wind_speed_10m)} <small>km/h</small>`;
  $("windDirection").textContent =
    `Direction ${formatNumber(current.wind_direction_10m)}°`;
  $("rain").innerHTML =
    `${formatNumber(current.precipitation)} <small>mm</small>`;

  $("rainProbability").textContent =
    `Rain probability ${formatNumber(
      weatherData.hourly.precipitation_probability?.[0]
    )}%`;

  $("temperature").style.color =
    temperature >= 40 ? "var(--red)" :
    temperature >= 35 ? "var(--orange)" : "var(--text)";

  $("voiceStatus").textContent =
    `${city.name}: ${weatherDescription(code)}, ${temperature}°C.`;

  renderHourly(weatherData.hourly);
  renderDaily(weatherData.daily);
  renderWeatherAlerts();
}

function renderHourly(hourly) {
  const container = $("hourlyForecast");
  container.replaceChildren();

  let start = hourly.time.findIndex(
    time => new Date(time).getTime() >= Date.now()
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

    const icon = document.createElement("div");
    icon.textContent = weatherEmoji(hourly.weather_code[i]);

    const temp = document.createElement("div");
    temp.className = "hour-temp";
    temp.textContent = `${formatNumber(hourly.temperature_2m[i])}°`;

    const condition = document.createElement("div");
    condition.className = "hour-time";
    condition.textContent = weatherDescription(hourly.weather_code[i]);

    const rain = document.createElement("div");
    rain.className = "hour-rain";
    rain.textContent =
      `Rain ${formatNumber(hourly.precipitation_probability[i])}%`;

    card.append(time, icon, temp, condition, rain);
    container.appendChild(card);
  }
}

function renderDaily(daily) {
  const container = $("dailyForecast");
  container.replaceChildren();

  daily.time.forEach((date, index) => {
    const row = document.createElement("div");
    row.className = "daily-row";

    const day = document.createElement("div");
    day.className = "day-name";
    day.textContent = index === 0
      ? "Today"
      : new Date(`${date}T12:00:00`).toLocaleDateString([], {
          weekday: "short"
        });

    const icon = document.createElement("div");
    icon.textContent = weatherEmoji(daily.weather_code[index]);

    const min = document.createElement("div");
    min.className = "min-temp";
    min.textContent = `${formatNumber(daily.temperature_2m_min[index])}°`;

    const max = document.createElement("div");
    max.className = "max-temp";
    max.textContent = `${formatNumber(daily.temperature_2m_max[index])}°`;

    const bar = document.createElement("div");
    bar.className = "temp-bar";
    bar.title =
      `Rain probability ${formatNumber(daily.precipitation_probability_max[index])}%`;

    row.append(day, icon, min, max, bar);
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

/* =========================================
   LOCATION SEARCH / GEOCODING
========================================= */

async function geocode(query) {
  const value = query.trim();
  if (!value) throw new Error("Enter a starting point or destination.");

  const match = value.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
  );

  if (match) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);

    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error("Invalid coordinates.");
    }

    return { lat, lon, name: value };
  }

  const city = CITIES.find(
    item => item.name.toLowerCase() === value.toLowerCase()
  );

  if (city) return { ...city, name: city.name };

  const url = new URL(GEOCODING_URL);
  url.search = new URLSearchParams({
    q: value,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1"
  });

  const response = await fetch(url);

  if (!response.ok) throw new Error("Location search is unavailable.");

  const results = await response.json();
  if (!results.length) {
    throw new Error(`Could not find "${value}". Try a more specific address.`);
  }

  return {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
    name: results[0].display_name
  };
}

/* =========================================
   DRIVING / CYCLING / WALKING ROUTES
========================================= */

async function handleRouteSearch(event) {
  event.preventDefault();
  stopNavigation();

  const submitButton = $("routeForm").querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Searching…";

  $("routeMessage").className = "status-message";
  $("routeMessage").textContent = "Searching for locations and routes…";
  $("routeResults").replaceChildren();
  $("navigationControls").classList.add("hidden");
  routeLayer.clearLayers();

  try {
    const mode = $("travelMode").value;
    const router = ROUTING_URLS[mode];

    if (!router) throw new Error("Select driving, cycling or walking.");

    const [origin, destination] = await Promise.all([
      geocode($("origin").value),
      geocode($("destination").value)
    ]);

    const url = new URL(
      `${router}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}`
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
      throw new Error(
        `Routing service returned HTTP ${response.status}. Try again later.`
      );
    }

    const data = await response.json();

    if (data.code !== "Ok" || !data.routes?.length) {
      throw new Error(
        "No route found for this mode. Try different locations or another mode."
      );
    }

    routes = data.routes;
    selectedRouteIndex = 0;
    currentStepIndex = 0;

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
    $("routeMessage").textContent =
      `Found ${routes.length} ${mode} route option(s). ` +
      "Check road signs and local conditions. Weather forecasts do not confirm road closures or flooding.";

    const points = routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    map.fitBounds(L.latLngBounds(points), { padding: [35, 35] });

  } catch (error) {
    console.error("Route search error:", error);
    $("routeMessage").textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Find route";
  }
}

function drawRoutes() {
  routeLayer.clearLayers();

  routes.forEach((route, index) => {
    const coordinates = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

    const line = L.polyline(coordinates, {
      color: index === selectedRouteIndex ? "#41d9e8" : "#7185a2",
      weight: index === selectedRouteIndex ? 7 : 4,
      opacity: index === selectedRouteIndex ? 0.95 : 0.65
    }).addTo(routeLayer);

    line.on("click", () => selectRoute(index));
  });

  const route = routes[selectedRouteIndex];
  if (route) {
    const coordinates = route.geometry.coordinates;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];

    L.marker([first[1], first[0]]).bindPopup("Starting point").addTo(routeLayer);
    L.marker([last[1], last[0]]).bindPopup("Destination").addTo(routeLayer);
  }

  toggleMapLayers();
}

function renderRouteOptions() {
  const container = $("routeResults");
  container.replaceChildren();

  routes.forEach((route, index) => {
    const card = document.createElement("article");
    card.className = "route-option";

    if (index === selectedRouteIndex) card.classList.add("selected");

    const title = document.createElement("h3");
    title.textContent = index === 0 ? "Suggested route" : `Alternative route ${index + 1}`;

    const distance = document.createElement("p");
    distance.textContent = `Distance: ${(route.distance / 1000).toFixed(1)} km`;

    const duration = document.createElement("p");
    duration.textContent = `Estimated time: ${formatDuration(route.duration)}`;

    const arrival = document.createElement("p");
    arrival.textContent =
      `Estimated arrival: ${new Date(Date.now() + route.duration * 1000)
        .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    const disclaimer = document.createElement("p");
    disclaimer.textContent =
      "Route estimates depend on available map data and may not reflect closures or hazards.";

    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.textContent = index === selectedRouteIndex ? "Selected" : "Select route";
    button.disabled = index === selectedRouteIndex;
    button.addEventListener("click", () => selectRoute(index));

    card.append(title, distance, duration, arrival, disclaimer, button);
    container.appendChild(card);
  });
}

function selectRoute(index) {
  if (!routes[index] || !currentRoute) return;

  selectedRouteIndex = index;
  currentRoute.route = routes[index];
  currentStepIndex = 0;
  lastSpokenStep = -1;

  drawRoutes();
  renderRouteOptions();
  renderTurnList();

  if (navigationRunning && !navigationPaused) announceCurrentInstruction();
}

function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

function renderTurnList() {
  const list = $("turnList");
  list.replaceChildren();

  const steps = currentRoute?.route?.legs?.[0]?.steps || [];

  if (!steps.length) {
    const item = document.createElement("li");
    item.textContent = "No turn-by-turn instructions are available.";
    list.appendChild(item);
    return;
  }

  steps.forEach((step, index) => {
    const item = document.createElement("li");
    const maneuver = step.maneuver || {};
    const action = [maneuver.type, maneuver.modifier].filter(Boolean).join(" ");
    const road = step.name || "unnamed road";
    const distance = Number(step.distance || 0);

    item.textContent =
      `${index + 1}. ${action || "Continue"} on ${road} · ` +
      `${distance >= 1000 ? (distance / 1000).toFixed(1) + " km" : Math.round(distance) + " m"}`;

    if (index === currentStepIndex) item.classList.add("active");
    list.appendChild(item);
  });
}

/* =========================================
   GPS NAVIGATION
========================================= */

function useCurrentLocation() {
  if (!navigator.geolocation) {
    $("routeMessage").textContent = "Geolocation is not supported by this browser.";
    return;
  }

  $("routeMessage").textContent = "Requesting location permission…";

  navigator.geolocation.getCurrentPosition(
    position => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      $("origin").value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      map.setView([lat, lon], 15);

      if (userLocationMarker) map.removeLayer(userLocationMarker);

      userLocationMarker = L.circleMarker([lat, lon], {
        radius: 8,
        color: "#ffffff",
        fillColor: "#35d49a",
        fillOpacity: 1,
        weight: 2
      }).addTo(map);

      userLocationMarker.bindPopup("Your current GPS location");
      $("routeMessage").textContent = "Starting point set to your current location.";
    },
    error => {
      $("routeMessage").textContent =
        `Could not get location: ${error.message}. Enter it manually.`;
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

function startNavigation() {
  if (!currentRoute?.route) {
    $("nextInstruction").textContent = "Find a route first.";
    return;
  }

  if (!navigator.geolocation) {
    $("nextInstruction").textContent = "GPS is unavailable in this browser.";
    announceCurrentInstruction();
    return;
  }

  navigationRunning = true;
  navigationPaused = false;
  currentStepIndex = 0;
  lastSpokenStep = -1;

  $("pauseNavigation").textContent = "Ⅱ Pause";
  announceCurrentInstruction();
  renderTurnList();

  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);

  gpsWatchId = navigator.geolocation.watchPosition(
    onGPSUpdate,
    error => {
      $("nextInstruction").textContent =
        `GPS update unavailable: ${error.message}`;
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

function onGPSUpdate(position) {
  if (!navigationRunning || navigationPaused || !currentRoute?.route) return;

  const lat = position.coords.latitude;
  const lon = position.coords.longitude;

  if (!userLocationMarker) {
    userLocationMarker = L.circleMarker([lat, lon], {
      radius: 8,
      color: "#fff",
      fillColor: "#287bff",
      fillOpacity: 1,
      weight: 2
    }).addTo(map);
  } else {
    userLocationMarker.setLatLng([lat, lon]);
  }

  const steps = currentRoute.route.legs?.[0]?.steps || [];
  if (!steps.length) return;

  let nearestIndex = currentStepIndex;
  let nearestDistance = Infinity;

  for (let i = currentStepIndex; i < Math.min(steps.length, currentStepIndex + 6); i++) {
    const location = steps[i].maneuver?.location;
    if (!location) continue;

    const distance = haversineMeters(lat, lon, location[1], location[0]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }

  if (nearestDistance < 45 && nearestIndex > currentStepIndex) {
    currentStepIndex = nearestIndex;
    renderTurnList();
    announceCurrentInstruction();
  }

  if (nearestDistance > 250 && currentStepIndex > 0) {
    $("nextInstruction").textContent =
      "You may be off the planned route. Stop safely and check the map.";
  }
}

function pauseNavigation() {
  if (!navigationRunning) return;

  navigationPaused = !navigationPaused;
  $("pauseNavigation").textContent = navigationPaused ? "▶ Resume" : "Ⅱ Pause";

  if (navigationPaused) {
    stopSpeech();
    $("nextInstruction").textContent = "Navigation paused.";
  } else {
    announceCurrentInstruction();
  }
}

function stopNavigation() {
  navigationRunning = false;
  navigationPaused = false;

  if (gpsWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }

  if ($("pauseNavigation")) $("pauseNavigation").textContent = "Ⅱ Pause";
  stopSpeech();
}

function getCurrentInstruction() {
  const steps = currentRoute?.route?.legs?.[0]?.steps || [];
  const step = steps[currentStepIndex];

  if (!step) return "You have reached the end of the route instructions.";

  const maneuver = step.maneuver || {};
  const type = String(maneuver.type || "continue").replaceAll("_", " ");
  const modifier = maneuver.modifier ? ` ${maneuver.modifier}` : "";
  const road = step.name ? ` onto ${step.name}` : "";
  const distance = Number(step.distance || 0);

  if (type === "arrive") return "You are arriving at your destination.";

  return distance > 0
    ? `In ${Math.round(distance)} metres, ${type}${modifier}${road}.`
    : `${type}${modifier}${road}.`;
}

function announceCurrentInstruction() {
  const message = getCurrentInstruction();
  $("nextInstruction").textContent = message;

  if (lastSpokenStep !== currentStepIndex) {
    lastSpokenStep = currentStepIndex;
    speak(message);
  }
}

function repeatInstruction() {
  speak($("nextInstruction").textContent || getCurrentInstruction());
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =========================================
   WEATHER ALERTS
========================================= */

function alertHours() {
  const session = $("alertSession").value;

  if (session === "current") return 1;

  if (session === "today") {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return Math.max(1, Math.ceil((midnight - now) / 3600000));
  }

  return session === "next48" ? 48 : 24;
}

function collectAlerts() {
  if (!weatherData?.current || !weatherData?.hourly) return [];

  const alerts = [];
  const current = weatherData.current;

  function add(key, title, severity, message, time) {
    const existing = alerts.find(alert => alert.key === key);
    const rank = { low: 1, medium: 2, high: 3 };

    if (!existing || rank[severity] > rank[existing.severity]) {
      if (existing) alerts.splice(alerts.indexOf(existing), 1);
      alerts.push({ key, title, severity, message, time });
    }
  }

  if ($("alertSession").value === "current") {
    const temp = Number(current.temperature_2m);
    const wind = Number(current.wind_speed_10m);
    const code = Number(current.weather_code);
    const rain = Number(current.precipitation);

    if (temp >= 40) {
      add("heat", "Extreme heat", "high",
        `${temp}°C recorded. Seek shade, hydrate, and avoid strenuous activity.`, "Now");
    } else if (temp >= 35) {
      add("heat", "High temperature", "medium",
        `${temp}°C recorded. Take breaks and drink water.`, "Now");
    }

    if (wind >= 70) {
      add("wind", "Very strong wind", "high",
        `Wind speed is ${wind} km/h. Check official local advisories.`, "Now");
    } else if (wind >= 50) {
      add("wind", "Strong wind", "medium",
        `Wind speed is ${wind} km/h. Use caution on exposed roads.`, "Now");
    }

    if (code >= 95) {
      add("storm", "Thunderstorm", "high",
        "Thunderstorm conditions are reported. Avoid exposed locations.", "Now");
    }

    if ([45, 48].includes(code)) {
      add("fog", "Fog / reduced visibility", "medium",
        "Fog is indicated. Slow down and use appropriate lights.", "Now");
    }

    if (rain >= 7) {
      add("rain", "Heavy precipitation", "high",
        `${rain} mm precipitation reported. Never drive through floodwater.`, "Now");
    }
  } else {
    const hours = alertHours();
    const hourly = weatherData.hourly;
    const times = hourly.time || [];

    let start = times.findIndex(time =>
      new Date(time).getTime() >= Date.now() - 3600000
    );
    if (start < 0) start = 0;

    for (let i = start; i < Math.min(times.length, start + hours); i++) {
      const temp = Number(hourly.temperature_2m?.[i]);
      const wind = Number(hourly.wind_speed_10m?.[i]);
      const rainChance = Number(hourly.precipitation_probability?.[i]);
      const rain = Number(hourly.precipitation?.[i]);
      const code = Number(hourly.weather_code?.[i]);

      const time = new Date(times[i]).toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit"
      });

      if (temp >= 40) {
        add("heat", "Extreme heat", "high",
          `Forecast temperature reaches ${temp}°C.`, time);
      } else if (temp >= 35) {
        add("heat", "High temperature", "medium",
          `Forecast temperature reaches ${temp}°C.`, time);
      }

      if (wind >= 70) {
        add("wind", "Very strong wind", "high",
          `Forecast wind reaches ${wind} km/h.`, time);
      } else if (wind >= 50) {
        add("wind", "Strong wind", "medium",
          `Forecast wind reaches ${wind} km/h.`, time);
      }

      if (code >= 95) {
        add("storm", "Thunderstorm risk", "high",
          "Thunderstorm conditions appear in the forecast.", time);
      }

      if ([45, 48].includes(code)) {
        add("fog", "Fog / reduced visibility", "medium",
          "Fog appears in the forecast.", time);
      }

      if (rainChance >= 80 && rain >= 7) {
        add("rain", "Heavy rain potential", "high",
          `${rainChance}% rain probability, with ${rain} mm forecast.`, time);
      } else if (rainChance >= 60) {
        add("rain", "Rain likely", "medium",
          `${rainChance}% rain probability. Wet roads are possible.`, time);
      }
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function renderWeatherAlerts() {
  const summary = $("liveAlertSummary");
  const container = $("dynamicAlertList");

  if (!weatherData?.current) {
    summary.textContent = "Weather data is unavailable; alerts cannot be assessed.";
    container.replaceChildren();
    updateWeatherZone(null);
    return;
  }

  const alerts = collectAlerts();
  const windowName = $("alertSession").selectedOptions[0]?.textContent || "Selected period";

  summary.textContent =
    `${selectedCity.name} · ${windowName}: ${alerts.length} threshold-based alert(s). ` +
    "These are estimates, not official warnings.";

  container.replaceChildren();

  if (!alerts.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      "No configured alert thresholds were triggered. This does not guarantee safe travel.";
    container.appendChild(empty);
  }

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

    const time = document.createElement("p");
    time.textContent = `${alert.time} · ${selectedCity.name}`;

    card.append(heading, tag, message, time);
    container.appendChild(card);
  });

  const severity = alerts.some(a => a.severity === "high")
    ? "high"
    : alerts.some(a => a.severity === "medium")
      ? "medium"
      : "low";

  updateWeatherZone(severity);

  if (notificationsEnabled) notifyAlerts(alerts);
}

function updateWeatherZone(level) {
  if (!zoneLayer) return;

  zoneLayer.clearLayers();
  if (!level) return;

  const settings = {
    low: { color: "#35d49a", radius: 2500, label: "No configured threshold triggered" },
    medium: { color: "#ffb454", radius: 4500, label: "Caution threshold" },
    high: { color: "#ff667c", radius: 6500, label: "High concern threshold" }
  }[level];

  L.circle([selectedCity.lat, selectedCity.lon], {
    radius: settings.radius,
    color: settings.color,
    fillColor: settings.color,
    fillOpacity: 0.1,
    weight: 2,
    dashArray: "6 5"
  }).bindPopup(
    `${settings.label}. Illustrative city-level radius, not an official hazard boundary.`
  ).addTo(zoneLayer);
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    $("liveAlertSummary").textContent =
      "This browser does not support notifications.";
    return;
  }

  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();

  if (permission !== "granted") {
    $("liveAlertSummary").textContent =
      "Notifications were not enabled. Alerts remain visible on the page.";
    return;
  }

  notificationsEnabled = true;
  $("enableNotifications").textContent = "Notifications enabled";
  notifyAlerts(collectAlerts());
}

function notifyAlerts(alerts) {
  if (!notificationsEnabled || Notification.permission !== "granted") return;

  alerts.forEach(alert => {
    const key = `${selectedCity.name}:${alert.key}:${alert.severity}`;
    if (notifiedAlerts.has(key)) return;

    notifiedAlerts.add(key);

    try {
      new Notification(`RouteSafe: ${alert.title}`, {
        body: `${selectedCity.name}: ${alert.message}`,
        tag: key
      });
    } catch (error) {
      console.warn("Notification failed:", error);
    }
  });
}

/* =========================================
   VOICE WEATHER ASSISTANT
========================================= */

function speak(text) {
  if (!("speechSynthesis" in window)) {
    $("voiceStatus").textContent = text;
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = $("voiceLanguage").value || "en-IN";
  utterance.rate = Number($("speechRate").value) || 1;

  utterance.onstart = () => {
    $("voiceStatus").textContent = `Speaking: ${text}`;
  };

  utterance.onend = () => {
    $("voiceStatus").textContent = "Voice announcement finished.";
  };

  utterance.onerror = () => {
    $("voiceStatus").textContent =
      "Speech output is unavailable. Read the text displayed on screen.";
  };

  window.speechSynthesis.speak(utterance);
}

function stopSpeech() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  $("voiceStatus").textContent = "Speech stopped.";
}

function readWeather() {
  if (!weatherData?.current) {
    speak("Weather information is not available yet.");
    return;
  }

  const current = weatherData.current;
  const chance = weatherData.hourly.precipitation_probability?.[0];

  speak(
    `Weather report for ${selectedCity.name}. ` +
    `Current temperature is ${current.temperature_2m} degrees Celsius. ` +
    `Feels like ${current.apparent_temperature} degrees. ` +
    `Conditions are ${weatherDescription(current.weather_code)}. ` +
    `Humidity is ${current.relative_humidity_2m} percent. ` +
    `Wind speed is ${current.wind_speed_10m} kilometres per hour. ` +
    `Precipitation is ${current.precipitation} millimetres. ` +
    `Rain probability is ${chance ?? "unavailable"} percent.`
  );
}

function readForecast() {
  if (!weatherData?.daily) {
    speak("The forecast is not available.");
    return;
  }

  const daily = weatherData.daily;

  const forecast = daily.time.map((date, index) => {
    const day = new Date(`${date}T12:00:00`).toLocaleDateString([], {
      weekday: "long"
    });

    return `${day}: minimum ${daily.temperature_2m_min[index]} degrees, ` +
      `maximum ${daily.temperature_2m_max[index]} degrees, ` +
      `${weatherDescription(daily.weather_code[index])}, ` +
      `rain probability ${daily.precipitation_probability_max[index]} percent.`;
  }).join(" ");

  speak(`Seven day forecast for ${selectedCity.name}. ${forecast}`);
}

function toggleVoiceCommands() {
  const button = $("voiceToggle");

  if (voiceListening) {
    stopVoiceCommands();
    return;
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    $("voiceStatus").textContent =
      "Voice commands are not supported here. Try Chrome or Edge. Weather read-aloud still works.";
    return;
  }

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.lang = $("voiceLanguage").value || "en-IN";
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = false;

  voiceRecognition.onstart = () => {
    voiceListening = true;
    button.textContent = "🎙 Listening…";
    $("voiceStatus").textContent =
      'Try saying "read weather", "read forecast", or "stop voice".';
  };

  voiceRecognition.onresult = event => {
    const command = event.results[0][0].transcript.toLowerCase();
    $("voiceStatus").textContent = `Heard: ${command}`;

    if (command.includes("forecast")) {
      readForecast();
    } else if (command.includes("weather")) {
      readWeather();
    } else if (command.includes("stop") || command.includes("mute")) {
      stopSpeech();
    } else {
      speak("Please say read weather, read forecast, or stop voice.");
    }
  };

  voiceRecognition.onerror = event => {
    $("voiceStatus").textContent = `Voice command error: ${event.error}`;
  };

  voiceRecognition.onend = () => {
    voiceListening = false;
    button.textContent = "🎙 Voice commands";
  };

  voiceRecognition.start();
}

function stopVoiceCommands() {
  if (voiceRecognition && voiceListening) voiceRecognition.stop();
  voiceListening = false;
  $("voiceToggle").textContent = "🎙 Voice commands";
}

/* =========================================
   COMMUNITY INCIDENT REPORTS
========================================= */

function getIncidents() {
  try {
    const data = JSON.parse(localStorage.getItem(INCIDENT_KEY) || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveIncidents(incidents) {
  try {
    localStorage.setItem(INCIDENT_KEY, JSON.stringify(incidents));
    return true;
  } catch (error) {
    console.error("Could not save reports:", error);
    return false;
  }
}

async function submitIncident(event) {
  event.preventDefault();

  const locationText = $("incidentLocation").value.trim();
  const description = $("incidentDescription").value.trim();

  if (!locationText || !description) {
    $("incidentLocation").focus();
    return;
  }

  const incident = {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: $("incidentType").value,
    location: locationText,
    description,
    reportedAt: new Date().toISOString(),
    status: "New",
    latitude: null,
    longitude: null
  };

  try {
    const place = await geocode(locationText);
    incident.latitude = place.lat;
    incident.longitude = place.lon;
    incident.location = place.name;
  } catch (error) {
    console.warn("Incident location was not geocoded:", error.message);
  }

  const incidents = getIncidents();
  incidents.unshift(incident);

  if (!saveIncidents(incidents)) {
    alert("Could not save the report in browser storage.");
    return;
  }

  $("incidentForm").reset();
  renderIncidents();

  alert(
    "Report saved in this browser. It has not been sent to a server or shared with other users."
  );
}

function renderIncidents() {
  if (!incidentLayer || !$("incidentList")) return;

  incidentLayer.clearLayers();

  const incidents = getIncidents();
  const filter = $("incidentFilter").value;

  const visible = incidents.filter(incident =>
    filter === "all" || incident.type === filter
  );

  incidents.forEach(incident => {
    if (
      Number.isFinite(incident.latitude) &&
      Number.isFinite(incident.longitude)
    ) {
      L.marker([incident.latitude, incident.longitude])
        .bindPopup(
          `<strong>${escapeHTML(incident.type)}</strong><br>` +
          `${escapeHTML(incident.location)}<br>` +
          "User-submitted report; not independently verified."
        )
        .addTo(incidentLayer);
    }
  });

  const container = $("incidentList");
  container.replaceChildren();

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

    const heading = document.createElement("h3");
    heading.textContent = incident.type;

    const location = document.createElement("p");
    location.textContent = `Location: ${incident.location}`;

    const description = document.createElement("p");
    description.textContent = incident.description;

    const time = document.createElement("p");
    time.textContent =
      `Reported: ${new Date(incident.reportedAt).toLocaleString()}`;

    const status = document.createElement("p");
    status.textContent = `Status: ${incident.status} · User report`;

    const actions = document.createElement("div");
    actions.className = "incident-actions";

    const locate = document.createElement("button");
    locate.className = "button button-secondary";
    locate.textContent = "View on map";
    locate.disabled =
      !Number.isFinite(incident.latitude) ||
      !Number.isFinite(incident.longitude);

    locate.addEventListener("click", () => {
      map.setView([incident.latitude, incident.longitude], 16);
    });

    const resolve = document.createElement("button");
    resolve.className = "button button-secondary";
    resolve.textContent =
      incident.status === "Resolved" ? "Mark new" : "Mark resolved";

    resolve.addEventListener("click", () => {
      const updated = getIncidents().map(item =>
        item.id === incident.id
          ? { ...item, status: item.status === "Resolved" ? "New" : "Resolved" }
          : item
      );

      saveIncidents(updated);
      renderIncidents();
    });

    const remove = document.createElement("button");
    remove.className = "button button-danger";
    remove.textContent = "Delete";

    remove.addEventListener("click", () => {
      if (!confirm("Delete this local report?")) return;

      saveIncidents(getIncidents().filter(item => item.id !== incident.id));
      renderIncidents();
    });

    actions.append(locate, resolve, remove);
    card.append(heading, location, description, time, status, actions);
    container.appendChild(card);
  });

  toggleMapLayers();
}

/* =========================================
   CONNECTION AND UTILITIES
========================================= */

function updateConnectionStatus() {
  const status = $("connectionStatus");
  status.textContent = navigator.onLine ? "Online" : "Offline";
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : "--";
}

function formatDate(value) {
  return new Date(value).toLocaleString([], {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}
