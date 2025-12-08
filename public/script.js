// ---------------------------------------
// 0. UTILITY & CONFIGURATION
// ---------------------------------------
// Define paths to the local GeoJSON data files.
const curbUrl = "./data/paid_curb_spaces.geojson";
const garagesUrl = "./data/public_garages.geojson";

// ---------------------------------------
// 1. LEAFLET MAP SETUP
// ---------------------------------------
// Initialize the Leaflet map attached to the 'map' div.
const map = L.map("map", {
  center: [47.608, -122.335], 
  zoom: 13,                   // Kept at 13 as requested
  zoomControl: false          // Disable default zoom controls to place them manually later
});

// Create a custom pane for the radius tool.
// This ensures the radius circle renders ON TOP of map markers/lines but below popups.
map.createPane('radiusPane');
map.getPane('radiusPane').style.zIndex = 620; // Higher than MarkerPane (600)
map.getPane('radiusPane').style.pointerEvents = 'none'; // Allow clicks to pass through the circle to the map below

// Add the base tile layer (OpenStreetMap).
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Add zoom controls to the top-right corner.
L.control.zoom({
  position: "topright"
}).addTo(map);


// ---------------------------------------
// 2. GLOBAL STATE MANAGEMENT
// ---------------------------------------
// Variables to hold Leaflet layer instances.
let curbLayer = null;
let garageLayer = null;

// Counters for total features.
let curbCount = 0;
let garageCount = 0;

// Radius Tool Cache & State
// These arrays hold simplified coordinate data for fast distance calculations.
let allCurbFeatures = [];
let allGarageFeatures = [];
let currentRadius = 400; // Default radius in meters
let lastMouseLatLng = null; // Tracks mouse position for the radius tool

// Radius Tool Layer instance (the visual circle).
let radiusCircle = null;
let isRadiusActive = false; // Flag to check if the user is in the "Radius Tool" step

// Data containers for analysis.
let areaStats = new Map();   // Maps Area Name -> {curb count, garage count}
let areaBounds = new Map();  // Maps Area Name -> Leaflet LatLngBounds

// Visual State Variables
let selectedAreaName = null;      // Currently clicked neighborhood
let showRestrictionHighlight = false; // Toggle red colors for restricted zones
let filterAvailableOnly = false;  // Toggle to hide restricted zones completely
let showCategoryColoring = false; // Toggle multicolor mode based on category

// Hardcoded bounds for the "Downtown" zoom step.
const downtownBounds = [
  [47.595, -122.345], 
  [47.618, -122.325]
];

// ---------------------------------------
// 3. HELPER FUNCTIONS
// ---------------------------------------

// Helper: Haversine formula to calculate distance (in KM) between two lat/lon points.
// Used heavily by the Radius Tool for performance.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Helper: Determine if a curb segment is restricted (No Parking, Bus Zone, etc.).
// Returns true if the category or type description matches specific keywords.
function isRestrictedCurb(feature) {
  const props = feature.properties || {};
  const category = (props.CATEGORY || "").toString().toUpperCase();
  const spaceType = (props.SPACETYPEDESC || "").toString().toUpperCase();
  
  // Hardcoded set of categories that imply no parking.
  const nonParkingCategories = new Set([
    "NP", "NS", "BUS", "BIKE", "LOAD", "GOVT", "CS", "CARPOOL", "DP"
  ]);
  if (nonParkingCategories.has(category)) return true;
  
  // Check description text for specific restriction keywords.
  const noParkKeywords = ["NO PARKING", "NO STOPPING", "BUS ZONE", "BUS ONLY", "TRANSIT ONLY", "TOW AWAY", "LOAD ONLY", "LOADING ONLY", "PARKLET"];
  return noParkKeywords.some((kw) => spaceType.includes(kw));
}

// Helper: Normalize raw data into clean categories for UI display.
function getCategoryLabel(category, spaceTypeDesc) {
  const cat = (category || "").toString().toUpperCase();
  const desc = (spaceTypeDesc || "").toString().toUpperCase();
  if (cat === "PAID" || desc.includes("PAID") || desc.includes("PAY STATION")) return "PAID PARKING";
  if (cat === "NP" || cat === "NS" || desc.includes("NO PARKING") || desc.includes("NO STOPPING")) return "NO PARKING";
  if (cat === "LOAD" || desc.includes("LOADING") || desc.includes("LOAD")) return "LOADING / UNLOADING";
  return "OTHERS";
}

// ---------------------------------------
// 4. STYLE LOGIC
// ---------------------------------------

// Determines the style (color, weight, opacity) of a curb line based on current state.
function curbStyle(feature) {
  const props = feature.properties || {};

  // Mode 1: Category Coloring (Step 10+)
  if (showCategoryColoring) {
    const cat = getCategoryLabel(props.CATEGORY, props.SPACETYPEDESC);
    let color = "#757575"; // Default Gray
    if (cat === "PAID PARKING") color = "#2468e8"; // Blue
    else if (cat === "NO PARKING") color = "#cc0000"; // Red
    else if (cat === "LOADING / UNLOADING") color = "#ff9900"; // Orange
    
    // If a specific area is selected, gray out everything else.
    const myArea = (props.PAIDAREA || "Others").toString();
    const isGrayedOut = selectedAreaName && myArea !== selectedAreaName;
    if (isGrayedOut) {
      return { color: "#ddd", weight: 1, opacity: 0.5, fillOpacity: 0.1 };
    }
    return { color: color, weight: 2, opacity: 1, fillOpacity: 0.5 };
  }

  // Mode 2: Standard / Restriction Logic
  const restricted = isRestrictedCurb(feature);
  
  // If filter is active, hide restricted spots completely.
  if (filterAvailableOnly && restricted) {
    return { color: "transparent", weight: 0, opacity: 0, fillOpacity: 0 };
  }

  let color = "#2468e8"; // Default Blue
  if (showRestrictionHighlight && restricted) {
    color = "#cc0000"; // Highlight Red
  }
  return { color, weight: 1, opacity: 0.9, fillOpacity: 0.3 };
}


// ---------------------------------------
// 5. DOM ELEMENTS & EVENT LISTENERS
// ---------------------------------------
const captionEl = document.getElementById("map-caption-text");
const hoverBodyEl = document.getElementById("hover-info-body");
const availableToggleButton = document.getElementById("available-toggle");

// Toggle button logic for showing/hiding restricted spaces.
if (availableToggleButton) {
  availableToggleButton.addEventListener("click", () => {
    filterAvailableOnly = !filterAvailableOnly;
    // When showing all again, ensure restrictions are highlighted red.
    if (!filterAvailableOnly) showRestrictionHighlight = true;
    
    // Update ARIA attributes and text.
    availableToggleButton.setAttribute("aria-pressed", filterAvailableOnly ? "true" : "false");
    availableToggleButton.textContent = filterAvailableOnly
      ? "Show all curb segments"
      : "Show only available curb spaces";
      
    // Re-render the layer styles.
    if (curbLayer) curbLayer.setStyle(curbStyle);
  });
}

// Generate HTML content for the hover panel/tooltip.
function formatProps(feature) {
  if (!feature || !feature.properties) return "No details available.";
  const p = feature.properties;
  
  // --- 1. GARAGE LOGIC ---
  // Try to find a valid name field for garages.
  const garageName = p.FAC_NAME || p.FACILITY_NAME || p.DEA_FACILITY_NAME || p.FACILITY_N || p.NAME;
  
  if (garageName) {
    const address = p.ADDRESS || p.DEA_ADDRESS || p.Entrances || "";
    const cap = p.TOTAL_CAP ? `${p.TOTAL_CAP} spots` : "";

    return `
      <div style="margin-bottom:4px;"><strong>${garageName}</strong></div>
      <div style="font-size:0.9em; color:#555;">${address}</div>
      ${cap ? `<div style="font-size:0.85em; margin-top:4px;">${cap}</div>` : ""}
    `;
  }

  // --- 2. CURB LOGIC ---
  const neighborhood = p.PAIDAREA || "Seattle Area";
  const category = getCategoryLabel(p.CATEGORY, p.SPACETYPEDESC);

  // Return formatted HTML for curb segments.
  return `
    <div style="font-size:0.9em; color:#555;">${neighborhood}</div>
    <div style="font-size:0.85em; margin-top:4px; color:#2468e8;">${category}</div>
  `;
}

// Updates the right-hand panel (hover-info-body) with HTML.
function updateHoverInfo(htmlText) {
  hoverBodyEl.innerHTML = htmlText;
}

// ---------------------------------------
// 6. ANIMATION / SCENARIO LOGIC (Step 11)
// ---------------------------------------
// Logic for the CSS-based animations (Scenarios).
const playButtons = document.querySelectorAll(".scenario-play-btn");

playButtons.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const scenario = e.target.dataset.scenario; 
    const panel = document.querySelector(`.scenario-panel.scenario-${scenario}`);
    if (!panel) return;

    // Reset animation by removing and re-adding the class (trigger reflow).
    panel.classList.remove("playing");
    void panel.offsetWidth; // Force reflow
    panel.classList.add("playing");
  });
});

// ---------------------------------------
// 7. CRUISING SIMULATION LOGIC (Step 12)
// ---------------------------------------
// DOM elements for the cruising simulation.
const carEl = document.getElementById("cruising-car");
const bubbleEl = document.getElementById("cruising-bubble");
const btnCruiseStart = document.getElementById("btn-cruise-start");
const btnCruiseReset = document.getElementById("btn-cruise-reset");
const statSpots = document.getElementById("stat-spots");
const statTime = document.getElementById("stat-time");
const statStatus = document.getElementById("stat-status");

// Simulation state.
let cruiseTimer = null;
let isCruising = false;
let cruiseStep = 0;
let totalTime = 0;
let spotsChecked = 0;

// Waypoints definition for the car animation.
// t: top (px), l: left (px), msg: text bubble, check: is it a parking attempt?
const waypoints = [
  // Start: Bottom left approach
  { t: 280, l: 145, msg: "Is that one open?", check: false },
  
  // 1. Check Nearest Spot (S7 - Bottom Left)
  { t: 260, l: 130, msg: "Occupied...", check: true },

  // Move to center intersection
  { t: 145, l: 145, msg: "Circling...", check: false },

  // 2. Check S1 (Left)
  { t: 145, l: 80, msg: "Taken!", check: true },

  // Move East to check the other side
  { t: 145, l: 220, msg: "Anything here?", check: false },

  // 3. Check S5 (Right Bottom)
  { t: 155, l: 220, msg: "No luck.", check: true },

  // 4. Check S4 (Right Top)
  { t: 135, l: 220, msg: "Full too?!", check: true },

  // Move BACK to center before going North to avoid hitting the white block
  { t: 135, l: 145, msg: "Turning...", check: false },

  // Move North
  { t: 60, l: 145, msg: "Scanning...", check: false },

  // 5. Check S3 (Top Right)
  { t: 60, l: 155, msg: "Seriously?", check: true },

  // 6. Check S2 (Top Left) - WINNER
  { t: 60, l: 135, msg: "FINALLY!", check: true, win: true }
];

// Reset simulation variables and UI elements.
function resetCruising() {
  clearTimeout(cruiseTimer);
  isCruising = false;
  cruiseStep = 0;
  totalTime = 0;
  spotsChecked = 0;
  
  if(carEl) {
    // Reset to new start position
    carEl.style.top = "280px";
    carEl.style.left = "145px";
    carEl.textContent = "🚗";
  }
  if(bubbleEl) bubbleEl.style.opacity = 0;
  
  if(statSpots) statSpots.textContent = "0";
  if(statTime) statTime.textContent = "0 min";
  if(statStatus) statStatus.textContent = "Idle";
}

// Main loop for the cruising simulation.
function playCruisingSimulation() {
  if(isCruising) return;
  isCruising = true;
  if(statStatus) statStatus.textContent = "Cruising...";
  
  const step = () => {
    // End condition
    if (cruiseStep >= waypoints.length) {
      isCruising = false;
      return;
    }
    const wp = waypoints[cruiseStep];
    
    // Update DOM positions
    carEl.style.top = wp.t + "px";
    carEl.style.left = wp.l + "px";
    bubbleEl.style.top = (wp.t - 30) + "px";
    bubbleEl.style.left = (wp.l + 15) + "px";
    bubbleEl.textContent = wp.msg;
    bubbleEl.style.opacity = 1;

    // Update stats logic
    if (wp.check) {
      spotsChecked++;
      statSpots.textContent = spotsChecked;
      totalTime += 3; // Checking takes time
    } else {
      totalTime += 1; // Driving takes less time
    }
    statTime.textContent = totalTime + " min";

    // Win condition
    if (wp.win) {
      statStatus.textContent = "Parked!";
      carEl.textContent = "✅"; 
      isCruising = false;
      return;
    }
    
    cruiseStep++;
    // Delay logic: parking checks take longer than moving
    const delay = wp.check ? 1200 : 800; 
    cruiseTimer = setTimeout(step, delay);
  };
  step();
}

// Event Listeners for Cruising Sim
if(btnCruiseStart) btnCruiseStart.addEventListener("click", () => {
  resetCruising();
  playCruisingSimulation();
});
if(btnCruiseReset) btnCruiseReset.addEventListener("click", resetCruising);


// ---------------------------------------
// 8. RADIUS TOOL & LOGIC (Step 6)
// ---------------------------------------

// Function to dynamically inject the Radius Slider UI into the DOM.
function injectRadiusUI() {
  const container = document.querySelector(".radius-story-container");
  // Prevent duplicate injection
  if (!container || document.getElementById("radius-slider-container")) return;

  // Create container div
  const controlDiv = document.createElement("div");
  controlDiv.id = "radius-slider-container";
  controlDiv.style.marginBottom = "12px";
  controlDiv.style.borderBottom = "1px solid #eee";
  controlDiv.style.paddingBottom = "8px";

  // Create labels
  const labelRow = document.createElement("div");
  labelRow.style.display = "flex";
  labelRow.style.justifyContent = "space-between";
  labelRow.style.fontSize = "0.85rem";
  labelRow.style.marginBottom = "4px";
  labelRow.style.color = "#333";
  
  const labelTitle = document.createElement("span");
  labelTitle.innerText = "Walk Radius:";
  
  const labelValue = document.createElement("span");
  labelValue.id = "radius-display-val";
  labelValue.innerText = "400m (~5 min)";
  labelValue.style.fontWeight = "bold";

  labelRow.appendChild(labelTitle);
  labelRow.appendChild(labelValue);

  // Create Range Slider
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "100";
  slider.max = "1000";
  slider.step = "50";
  slider.value = "400";
  slider.style.width = "100%";
  slider.style.cursor = "pointer";

  // Slider Event Listener
  slider.addEventListener("input", (e) => {
    currentRadius = Number(e.target.value);
    const mins = Math.round(currentRadius / 80); // Calc walking time (~80m per minute)
    labelValue.innerText = `${currentRadius}m (~${mins} min)`;
    
    // Update map circle visually
    if (radiusCircle) {
      radiusCircle.setRadius(currentRadius);
    }
    
    // Recalculate stats if the mouse is currently on the map
    if (lastMouseLatLng) {
      updateRadiusLogic();
    }
  });

  controlDiv.appendChild(labelRow);
  controlDiv.appendChild(slider);
  
  // Insert before the stats display
  const statsDiv = container.querySelector(".radius-stats");
  if (statsDiv) {
    container.insertBefore(controlDiv, statsDiv);
  } else {
    container.appendChild(controlDiv);
  }
}

// Map Event: Updates the circle position and stats on mousemove.
map.on("mousemove", (e) => {
  if (!isRadiusActive) return;
  lastMouseLatLng = e.latlng;
  
  // Create circle if it doesn't exist
  if (!radiusCircle) {
    radiusCircle = L.circle(e.latlng, {
      radius: currentRadius, 
      color: "#333",
      weight: 3,
      fillColor: "#aaa",
      fillOpacity: 0.1,
      dashArray: "5, 5",
      pane: "radiusPane", // Render on the custom pane
      interactive: false
    }).addTo(map);
  } else {
    // Just move the existing circle
    radiusCircle.setLatLng(e.latlng);
    radiusCircle.setRadius(currentRadius);
  }
  
  updateRadiusLogic();
});

// Map Event: Cleanup when mouse leaves the map.
map.on("mouseout", () => {
  if (!isRadiusActive) return;
  
  if (radiusCircle) {
    map.removeLayer(radiusCircle);
    radiusCircle = null;
  }
  lastMouseLatLng = null;
  updateRadiusChart(0, 0);
});

// Logic: Filters all data points to see what is inside the current radius.
function updateRadiusLogic() {
  if (!lastMouseLatLng) return;
  
  const mouseLat = lastMouseLatLng.lat;
  const mouseLng = lastMouseLatLng.lng;
  
  let localCurb = 0;
  let localGarage = 0;
  const RADIUS_KM = currentRadius / 1000;
  
  // Check Garages (Haversine distance)
  allGarageFeatures.forEach(g => {
    if (haversineKm(mouseLat, mouseLng, g.lat, g.lng) <= RADIUS_KM) localGarage++;
  });
  
  // Check Curb Segments
  allCurbFeatures.forEach(c => {
    if (haversineKm(mouseLat, mouseLng, c.lat, c.lng) <= RADIUS_KM) localCurb++;
  });
  
  updateRadiusChart(localCurb, localGarage);
}

// Logic: Updates the text and D3 Donut chart for the radius tool.
function updateRadiusChart(curbVal, garageVal) {
  const total = curbVal + garageVal;
  
  // Update text
  const curbText = document.getElementById("r-curb-val");
  const garageText = document.getElementById("r-garage-val");
  
  if (curbText) curbText.textContent = curbVal;
  if (garageText) garageText.textContent = garageVal;
  
  // Update D3 Donut Chart
  const svg = d3.select("#radius-svg");
  const width = 100, height = 100, radius = 45;
  svg.attr("width", width).attr("height", height);
  svg.selectAll("*").remove();
  
  const g = svg.append("g").attr("transform", `translate(${width/2},${height/2})`);
  
  if (total === 0) {
    g.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").text("Empty").attr("font-size", "12px").attr("fill", "#666");
    return;
  }
  
  const data = { curb: curbVal, garage: garageVal };
  const color = d3.scaleOrdinal().domain(["curb", "garage"]).range(["#2468e8", "#7b1fa2"]);
  const pie = d3.pie().value(d => d[1]).sort(null);
  const data_ready = pie(Object.entries(data));
  const arc = d3.arc().innerRadius(25).outerRadius(radius);
  
  g.selectAll("path")
   .data(data_ready)
   .join("path")
   .attr("d", arc)
   .attr("fill", d => color(d.data[0]))
   .attr("stroke", "white")
   .style("stroke-width", "2px");
}


// ---------------------------------------
// 9. DATA PROCESSING & CHARTING
// ---------------------------------------

// Pre-process GeoJSON data into useful structures (Counts, Bounds, simplified Arrays).
function computeAreaStats(curbData, garageData) {
  areaStats = new Map();
  areaBounds = new Map();
  
  allCurbFeatures = [];
  allGarageFeatures = [];

  const curbCentroids = [];

  // 1. Process Curb Segments
  (curbData.features || []).forEach((f) => {
    const props = f.properties || {};
    let area = (props.PAIDAREA || "").toString().trim();
    if (!area || area.toUpperCase() === "N/A") area = "Others";

    // Update Bounds
    let bounds = areaBounds.get(area);
    if (!bounds) {
      bounds = L.latLngBounds();
      areaBounds.set(area, bounds);
    }
    const geom = f.geometry;
    if (geom && geom.type === "LineString" && Array.isArray(geom.coordinates)) {
      geom.coordinates.forEach((c) => bounds.extend([c[1], c[0]]));
      
      // Calculate midpoints for finding nearest garages later
      const mid = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
      curbCentroids.push({ area, lng: mid[0], lat: mid[1] });
      // Add to Radius Tool cache
      allCurbFeatures.push({ lat: mid[1], lng: mid[0] });
    }
    
    // Update Counts
    let entry = areaStats.get(area);
    if (!entry) {
      entry = { area, curb: 0, garage: 0 };
      areaStats.set(area, entry);
    }
    entry.curb += 1;
  });

  // 2. Process Garages
  (garageData.features || []).forEach((f) => {
    const geom = f.geometry;
    if (!geom || geom.type !== "Point") return;
    const [lng, lat] = geom.coordinates;
    
    allGarageFeatures.push({ lat, lng });

    // Assign garage to an area based on nearest curb segment
    let bestArea = "Others";
    let bestDist = Infinity;
    
    for (const c of curbCentroids) {
        const d = haversineKm(lat, lng, c.lat, c.lng);
        if (d < bestDist) {
            bestDist = d;
            bestArea = c.area;
        }
    }
    
    // If too far from any curb, keep as "Others"
    if (bestDist > 0.5) bestArea = "Others"; 
    
    // Inject calculated area into feature properties
    if (!f.properties) f.properties = {};
    f.properties._PAIDAREA = bestArea;
    
    // Update Stats & Bounds
    let entry = areaStats.get(bestArea);
    if (!entry) {
      entry = { area: bestArea, curb: 0, garage: 0 };
      areaStats.set(bestArea, entry);
    }
    entry.garage += 1;
    
    let bounds = areaBounds.get(bestArea);
    if (!bounds) {
      bounds = L.latLngBounds();
      areaBounds.set(bestArea, bounds);
    }
    bounds.extend([lat, lng]);
  });
}

// Builds the "Supply Personality" Bar Chart.
function buildPersonalityChart(focusAreaName) {
  const svg = d3.select("#personality-chart");
  if (svg.empty()) return;
  const container = svg.node().parentNode;
  const containerWidth = container ? container.getBoundingClientRect().width : 640;
  const height = 400;
  const margin = { top: 40, right: 80, bottom: 120, left: 60 };
  svg.attr("width", containerWidth).attr("height", height);
  svg.selectAll("*").remove();

  // Prepare data: filter empty rows, sort by total supply
  let rows = Array.from(areaStats.values()).filter(d => (d.curb + d.garage) > 0);
  rows.sort((a, b) => (b.curb + b.garage) - (a.curb + a.garage));
  
  // Calculate proportions
  rows = rows.map(d => {
    const total = d.curb + d.garage;
    return { ...d, curbProp: total > 0 ? d.curb / total : 0, garageProp: total > 0 ? d.garage / total : 0 };
  });

  // Scales
  const x = d3.scaleBand().domain(rows.map(d => d.area)).range([margin.left, containerWidth - margin.right]).padding(0.2);
  const y = d3.scaleLinear().domain([0, 1]).range([height - margin.bottom, margin.top]);
  const color = d3.scaleOrdinal().domain(["curb", "garage"]).range(["#2468e8", "#7b1fa2"]);

  const g = svg.append("g");
  // Axes
  g.append("g").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickSizeOuter(0)).selectAll("text").attr("transform", "rotate(-35)").style("text-anchor", "end").attr("font-size", 10);
  g.append("g").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(v => `${v * 100}%`).tickSizeOuter(0));
  g.append("text").attr("x", margin.left - 40).attr("y", (margin.top + height - margin.bottom) / 2).attr("transform", `rotate(-90, ${margin.left - 40}, ${(margin.top + height - margin.bottom) / 2})`).attr("text-anchor", "middle").attr("font-size", 11).attr("fill", "#333").text("Share of supply (curb vs garages)");

  // Bars
  const areaGroups = g.selectAll(".area-group").data(rows).join("g").attr("transform", d => `translate(${x(d.area)},0)`);
  
  areaGroups.each(function(d) {
    const group = d3.select(this);
    const isFocus = focusAreaName && d.area === focusAreaName;
    const opacity = isFocus || !focusAreaName ? 1 : 0.35;
    const outline = isFocus ? 2 : 0;
    
    // Curb Bar
    group.append("rect").attr("y", y(d.curbProp)).attr("height", y(0) - y(d.curbProp)).attr("width", x.bandwidth()).attr("fill", color("curb")).attr("opacity", opacity).attr("stroke", isFocus?"#222":"none").attr("stroke-width", outline).on("click", () => setSelectedArea(d.area));
    // Garage Bar
    group.append("rect").attr("y", y(d.curbProp + d.garageProp)).attr("height", y(d.curbProp) - y(d.curbProp + d.garageProp)).attr("width", x.bandwidth()).attr("fill", color("garage")).attr("opacity", opacity).attr("stroke", isFocus?"#222":"none").attr("stroke-width", outline).on("click", () => setSelectedArea(d.area));
  });
}

// Global handler for selecting an area (updates map, charts, and text).
function setSelectedArea(areaName) {
  // Toggle selection logic
  selectedAreaName = selectedAreaName === areaName ? null : areaName;
  
  // 1. Update UI / Charts immediately (Fast)
  buildPersonalityChart(selectedAreaName);
  // Only update ridgeline if it's currently visible
  if (document.querySelector('.step[data-step="10"].is-active')) {
     buildRidgelineChart();
  }
  
  const captionEl = document.getElementById("personality-selection-caption");
  if (captionEl) captionEl.textContent = !selectedAreaName ? "Showing top areas..." : `Showing ${selectedAreaName}.`;
  
  // 2. Trigger Map Animation (Priority: Smoothness)
  if (selectedAreaName && areaBounds.has(selectedAreaName)) {
    // Zoom to area bounds
    map.flyToBounds(areaBounds.get(selectedAreaName), { duration: 1.2, padding: [30, 30] });
  } else if (!selectedAreaName) {
    // Reset to default view
    map.flyTo([47.608, -122.335], 13, { duration: 1.2 });
  }

  // 3. Defer the heavy style update
  // Re-styling thousands of curb segments is expensive.
  // We use setTimeout to let the map animation frame start BEFORE we block the thread for styling.
  if (curbLayer) {
    setTimeout(() => {
      curbLayer.setStyle(curbStyle);
    }, 50); 
  }
}

// ---------------------------------------
// 10. LAYER BUILDING & INITIALIZATION
// ---------------------------------------

function buildLayers(curbData, garageData) {
  curbCount = curbData.features?.length || 0;
  garageCount = garageData.features?.length || 0;
  // Save for Ridgeline chart usage
  curbDataForRidgeline = curbData;
  garageDataForRidgeline = garageData;

  // Initialize Curb Layer
  curbLayer = L.geoJSON(curbData, {
    style: curbStyle,
    onEachFeature: (feature, layer) => {
      layer.on({
        mouseover: (e) => {
          if (isRadiusActive) return; // Don't show tooltip if using radius tool
          if (filterAvailableOnly && isRestrictedCurb(feature)) return;
          e.target.setStyle({ weight: 4, fillOpacity: 1 });
          updateHoverInfo(formatProps(feature));
        },
        mouseout: (e) => {
          if (isRadiusActive) return;
          curbLayer.resetStyle(e.target);
          updateHoverInfo("Hover over a curb segment or garage to see details.");
        },
        click: () => {
          const area = (feature.properties?.PAIDAREA || "Others").toString();
          setSelectedArea(area);
        }
      });
    }
  });

  // Initialize Garage Layer (Circle Markers)
  garageLayer = L.geoJSON(garageData, {
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 4, color: "#7b1fa2", fillColor: "#7b1fa2", fillOpacity: 0.9, weight: 1 }),
    onEachFeature: (feature, layer) => {
      layer.on({
        mouseover: () => {
          if (isRadiusActive) return;
          layer.setStyle({ radius: 6, weight: 2 });
          updateHoverInfo(formatProps(feature));
        },
        mouseout: () => {
          if (isRadiusActive) return;
          layer.setStyle({ radius: 4, weight: 1 });
          updateHoverInfo("Hover over a curb segment or garage to see details.");
        },
        click: () => {
          const area = (feature.properties?._PAIDAREA || "Others").toString();
          setSelectedArea(area);
        }
      });
    }
  });

  // Trigger initial builds
  buildMiniChart();
  computeAreaStats(curbData, garageData); // Populates internal data structures
  buildPersonalityChart(selectedAreaName);
  buildRidgelineChart();
}

// Builds the simple bar chart at the beginning (Total Curbs vs Total Garages).
function buildMiniChart() {
  const svg = d3.select("#mini-chart-svg");
  if (svg.empty()) return;
  
  svg.selectAll("*").remove();

  // Use getBoundingClientRect for responsiveness
  const rect = svg.node().getBoundingClientRect();
  const width = rect.width;
  const height = rect.height || +svg.attr("height");
  
  const margin = { top: 10, right: 60, bottom: 30, left: 90 };

  const data = [{ label: "Curb segments", value: curbCount }, { label: "Garages", value: garageCount }];
  const x = d3.scaleLinear().domain([0, d3.max(data, d => d.value) || 1]).nice().range([margin.left, width - margin.right]);
  const y = d3.scaleBand().domain(data.map(d => d.label)).range([margin.top, height - margin.bottom]).padding(0.3);
  
  svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).ticks(3).tickSizeOuter(0)).call(g => g.select(".domain"));
  svg.append("g").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).tickSizeOuter(0));
  
  const bars = svg.selectAll(".bar").data(data).enter().append("rect").attr("class", d => `bar bar-${d.label.replace(/\s+/g, "").toLowerCase()}`).attr("y", d => y(d.label)).attr("x", margin.left).attr("height", y.bandwidth()).attr("width", 0).attr("fill", d => d.label === "Curb segments" ? "#2468e8" : "#9333EA");
  
  // Animate bars
  bars.transition().duration(800).attr("width", d => x(d.value) - margin.left);
  svg.selectAll(".bar-label").data(data).enter().append("text").attr("class", "bar-label").attr("x", d => x(d.value) + 4).attr("y", d => y(d.label) + y.bandwidth() / 2 + 4).attr("font-size", 10).text(d => d.value.toLocaleString());
}

// Highlights specific bars in the Mini Chart.
function highlightChart(kind) {
  d3.selectAll(".bar").transition().duration(200).attr("opacity", d => (!kind || (kind === "curb" && d.label === "Curb segments") || (kind === "garage" && d.label === "Garages")) ? 1 : 0.25);
}

// ---------------------------------------
// 11. HOTSPOTS LAYER
// ---------------------------------------
const hotspotLayer = document.getElementById("hotspot-layer");

// Append layer to map container for absolute positioning
map.getContainer().appendChild(hotspotLayer);

const hotspotLatLngs = [[47.6095, -122.3343], [47.6138, -122.3425], [47.6038, -122.3311], [47.6112, -122.3208], [47.5987, -122.3319]];
let activeHotspotCoords = [];

function createHotspots() { activeHotspotCoords = hotspotLatLngs; hotspotLayer.innerHTML = ""; hotspotLayer.style.display = "block"; redrawHotspots(); }
function removeHotspots() { hotspotLayer.style.display = "none"; hotspotLayer.innerHTML = ""; }

// Re-calculates hotspot div positions when map moves/zooms
function redrawHotspots() {
  if (!hotspotLayer || hotspotLayer.style.display === "none") return;
  hotspotLayer.innerHTML = "";
  activeHotspotCoords.forEach((coords) => {
    const point = map.latLngToContainerPoint(coords);
    const div = document.createElement("div"); div.className = "hotspot"; div.style.left = point.x + "px"; div.style.top = point.y + "px";
    hotspotLayer.appendChild(div);
  });
}
map.on("move", redrawHotspots); map.on("zoom", redrawHotspots);

// ---------------------------------------
// 12. SCROLLAMA (SCROLLYTELLING) LOGIC
// ---------------------------------------
const scroller = scrollama();
const steps = document.querySelectorAll(".step");

// Update visual active state of step elements
function setActiveStep(element) {
  steps.forEach((step) => step.classList.remove("is-active"));
  element.classList.add("is-active");
}

// MAIN LOGIC: Triggers when user scrolls to a new step.
function handleStepEnter(response) {
  const stepEl = response.element;
  const stepNum = Number(stepEl.dataset.step);
  
  removeHotspots();
  setActiveStep(stepEl);

  const mapView = document.getElementById("map-view");
  const animView = document.getElementById("animation-view");
  const legendStd = document.getElementById("legend-standard");
  const legendCat = document.getElementById("legend-category");
  
  const scenarioContainer = document.getElementById("scenario-container");
  const cruisingContainer = document.getElementById("cruising-container");
  
  // Logic for switching between Map View and Animation View (Steps 11 & 12)
  if (stepNum === 11 || stepNum === 12) {
    mapView.classList.add("is-hidden");
    animView.classList.remove("is-hidden");
    
    if (stepNum === 11) {
      if(scenarioContainer) scenarioContainer.classList.remove("is-hidden");
      if(cruisingContainer) cruisingContainer.classList.add("is-hidden");
    } else if (stepNum === 12) {
      if(scenarioContainer) scenarioContainer.classList.add("is-hidden");
      if(cruisingContainer) cruisingContainer.classList.remove("is-hidden");
    }
    return;
  } else {
    // Show Map, Hide Animation
    mapView.classList.remove("is-hidden");
    animView.classList.add("is-hidden");
    if(cruisingContainer) resetCruising(); 
  }

  // Reset layer state before applying step-specific logic
  if (curbLayer && map.hasLayer(curbLayer)) map.removeLayer(curbLayer);
  if (garageLayer && map.hasLayer(garageLayer)) map.removeLayer(garageLayer);
  
  showRestrictionHighlight = false;
  showCategoryColoring = false;
  
  // Special Handling for Radius Tool (Step 6)
  if (stepNum === 6) {
     isRadiusActive = true;
     showRestrictionHighlight = true;
     if (curbLayer) { curbLayer.setStyle(curbStyle); curbLayer.addTo(map); }
     if (garageLayer) garageLayer.addTo(map);
     
     // Set generic hover info since interactivity is limited to the tool
     updateHoverInfo("<strong>Radius Tool Active</strong><br/>Hover over the map to explore local supply.");
  } else {
     isRadiusActive = false;
     if(radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  }

  // Legend visibility defaults
  if(legendStd) legendStd.style.display = "block";
  if(legendCat) legendCat.style.display = "none";

  let caption = "Initial view of central Seattle.";
  highlightChart(null);

  // --- STEP-BY-STEP LOGIC ---
  if (stepNum === 1) {
    map.flyTo([47.608, -122.335], 13, { duration: 0.7 });
  }
  if (stepNum === 2) {
    if (curbLayer) { curbLayer.setStyle(curbStyle); curbLayer.addTo(map); }
    highlightChart("curb");
  }
  if (stepNum === 3) {
    showRestrictionHighlight = true;
    if (curbLayer) { curbLayer.setStyle(curbStyle); curbLayer.addTo(map); }
    highlightChart("curb");
  }
  if (stepNum === 4) {
    showRestrictionHighlight = true;
    if (garageLayer) garageLayer.addTo(map);
    highlightChart("garage");
  }
  if (stepNum === 5) {
    showRestrictionHighlight = true;
    if (curbLayer) { curbLayer.setStyle(curbStyle); curbLayer.addTo(map); }
    if (garageLayer) garageLayer.addTo(map);
  }
  // Step 6 handled above
  if (stepNum === 7) {
    showRestrictionHighlight = true;
    if (curbLayer) { curbLayer.setStyle(curbStyle); curbLayer.addTo(map); }
    if (garageLayer) garageLayer.addTo(map);
    createHotspots();
  }
  if (stepNum === 8) {
    showRestrictionHighlight = true;
    if (curbLayer) { curbLayer.setStyle(curbStyle); curbLayer.addTo(map); }
    if (garageLayer) garageLayer.addTo(map);
    map.flyToBounds(downtownBounds, { duration: 0.8 });
  }
  if (stepNum === 9) {
    // Reset selection and zoom out
    selectedAreaName = null;
    if (curbLayer) { curbLayer.setStyle(curbStyle).addTo(map); }
    if (garageLayer) garageLayer.addTo(map);
    map.flyTo([47.608, -122.335], 13);
    buildPersonalityChart(null);
  }
  if (stepNum === 10) {
    // Enable Category Coloring Mode
    selectedAreaName = null;
    showCategoryColoring = true;
    if(legendStd) legendStd.style.display = "none";
    if(legendCat) legendCat.style.display = "block";
    if (curbLayer) { curbLayer.setStyle(curbStyle); curbLayer.addTo(map); }
    if (garageLayer) garageLayer.addTo(map);
    map.flyTo([47.608, -122.335], 13);
    buildRidgelineChart();
  }
  
  if(captionEl) captionEl.textContent = caption;
}

function handleResize() { scroller.resize(); }
function initScrollama() { scroller.setup({ step: ".step", offset: 0.6 }).onStepEnter(handleStepEnter); window.addEventListener("resize", handleResize); }

// ---------------------------------------
// 13. RIDGELINE CHART LOGIC
// ---------------------------------------
let curbDataForRidgeline = null, garageDataForRidgeline = null;

function buildRidgelineChart() {
  const svg = d3.select("#ridgeline-chart");
  if (svg.empty() || !curbDataForRidgeline) return;
  svg.selectAll("*").remove(); d3.selectAll(".ridgeline-tooltip").remove();
  
  // Calc dimensions
  const container = d3.select("#ridgeline-container").node();
  const width = (container ? container.getBoundingClientRect().width : 500) - 170;
  const margin = { top: 40, right: 30, bottom: 20, left: 140 };
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  
  // Aggregate data for the chart
  const categoryMap = new Map(), areaSet = new Set();
  (curbDataForRidgeline.features || []).forEach((f) => {
    let area = (f.properties?.PAIDAREA || "Others").toString().trim();
    if (!area || area.toUpperCase() === "N/A") area = "Others";
    areaSet.add(area);
    const cat = getCategoryLabel(f.properties?.CATEGORY, f.properties?.SPACETYPEDESC);
    const key = `${area}|${cat}`;
    categoryMap.set(key, (categoryMap.get(key) || 0) + 1);
  });
  
  // Formatting data structure
  const areas = Array.from(areaSet).sort();
  const cats = ["PAID PARKING", "NO PARKING", "LOADING / UNLOADING", "OTHERS"];
  const chartData = areas.map(area => {
    const totalCurb = cats.reduce((sum, cat) => sum + (categoryMap.get(`${area}|${cat}`) || 0), 0);
    const curbBreakdown = cats.map(cat => ({ category: cat, count: categoryMap.get(`${area}|${cat}`) || 0, proportion: totalCurb > 0 ? (categoryMap.get(`${area}|${cat}`) || 0) / totalCurb : 0 }));
    const garageEntry = areaStats.get(area);
    return { area, curbBreakdown, totalCurb, garageCount: garageEntry ? garageEntry.garage : 0 };
  }).filter(d => (d.totalCurb + d.garageCount) > 0).sort((a, b) => b.totalCurb - a.totalCurb);

  // Layout calculations
  const rowHeight = 40, height = Math.max(chartData.length * rowHeight, 400);
  svg.attr("width", width + margin.left + margin.right).attr("height", height + margin.top + margin.bottom);
  const yScale = d3.scaleBand().domain(chartData.map(d => d.area)).range([0, height]).padding(0.2);
  const curbWidth = width * 0.65, garageStart = width * 0.70, garageWidth = width * 0.30;
  const xScaleCurb = d3.scaleLinear().domain([0, 1]).range([0, curbWidth]);
  const xScaleGarage = d3.scaleLinear().domain([0, d3.max(chartData, d => d.garageCount) || 10]).range([0, garageWidth]);
  
  // Axis rendering
  const yAxisGroup = g.append("g").call(d3.axisLeft(yScale).tickSize(0));
  yAxisGroup.select(".domain").remove();
  yAxisGroup.selectAll("text").attr("font-size", "11px").attr("font-weight", d => d === selectedAreaName ? "bold" : "normal").attr("fill", d => d === selectedAreaName ? "#2468e8" : "#333").style("cursor", "pointer").on("click", (e, d) => setSelectedArea(d));
  
  const curbColors = d3.scaleOrdinal().domain(cats).range(["#2468e8", "#cc0000", "#ff9900", "#757575"]);
  const tooltip = d3.select("body").append("div").attr("class", "ridgeline-tooltip").style("opacity", 0).style("position", "absolute");

  // Render Rows
  chartData.forEach(d => {
    const row = g.append("g").attr("transform", `translate(0, ${yScale(d.area)})`);
    const isActive = (selectedAreaName && d.area === selectedAreaName);
    row.append("rect").attr("width", width + margin.left).attr("height", yScale.bandwidth()).attr("x", -margin.left).attr("fill", "transparent").style("cursor", "pointer").on("click", () => setSelectedArea(d.area));
    
    // Stacked Bar for Curb Breakdown
    let curX = 0;
    d.curbBreakdown.forEach(seg => {
      const w = xScaleCurb(seg.proportion);
      row.append("rect").attr("x", curX).attr("y", 0).attr("width", w).attr("height", yScale.bandwidth()).attr("fill", isActive ? curbColors(seg.category) : "#cccccc").attr("stroke", "#fff").attr("stroke-width", 1).style("pointer-events", "none");
      curX += w;
    });

    // Bar for Garages
    const gw = xScaleGarage(d.garageCount);
    row.append("rect").attr("x", garageStart).attr("y", 0).attr("width", gw).attr("height", yScale.bandwidth()).attr("fill", isActive ? "#7b1fa2" : "#cccccc").style("pointer-events", "none");
    if (gw > 0) row.append("text").attr("x", garageStart + gw + 5).attr("y", yScale.bandwidth() / 2 + 4).text(d.garageCount).attr("font-size", "10px").attr("fill", isActive ? "#333" : "#999");
    
    // Tooltip logic
    row.on("mouseover", (e) => {
       const breakdown = d.curbBreakdown.map(c => {
          if (c.proportion < 0.01) return ""; 
          const pct = Math.round(c.proportion * 100);
          const color = curbColors(c.category);
          let label = c.category; 
          if(label === "LOADING / UNLOADING") label = "Loading";
          if(label === "PAID PARKING") label = "Paid";
          if(label === "NO PARKING") label = "No Parking";
          if(label === "OTHERS") label = "Other";
          
          return `<div style="display:flex;align-items:center;gap:5px;font-size:11px;">
                    <span style="width:8px;height:8px;border-radius:50%;background:${color};"></span>
                    <span style="flex:1;">${label}</span>
                    <strong>${pct}%</strong>
                  </div>`;
       }).join("");

       tooltip.html(`
         <div style="margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.2);padding-bottom:4px;">
           <strong>${d.area}</strong>
         </div>
         <div style="margin-bottom:8px;font-size:11px;">
           Garages: <strong>${d.garageCount}</strong>
         </div>
         ${breakdown}
       `)
       .style("opacity", 1)
       .style("left", (e.pageX + 15) + "px")
       .style("top", (e.pageY - 10) + "px");
    }).on("mouseout", () => tooltip.style("opacity", 0));
  });
  
  // Header Labels
  const hg = svg.append("g").attr("transform", `translate(${margin.left}, 0)`);
  hg.append("text").attr("x", 0).attr("y", -20).text("Curb Category Breakdown").attr("font-size", "10px").attr("font-weight", "bold").attr("fill", "#555");
  hg.append("text").attr("x", garageStart).attr("y", -20).text("Garage Count").attr("font-size", "10px").attr("font-weight", "bold").attr("fill", "#555");
}

// ---------------------------------------
// 14. DATA LOADING & START
// ---------------------------------------
Promise.all([fetch(curbUrl), fetch(garagesUrl)])
  .then(async ([resCurb, resGar]) => {
    if (!resCurb.ok) throw new Error("Failed to load curb data");
    if (!resGar.ok) throw new Error("Failed to load garages data");
    
    const curbData = await resCurb.json();
    const garageData = await resGar.json();
    
    // Start building layers once data is ready
    buildLayers(curbData, garageData);
    
    // Inject the slider UI after data loads and DOM is ready
    injectRadiusUI();
  })
  .catch((err) => {
    console.error(err);
    captionEl.textContent = "Error loading GeoJSON data.";
  });

// Start Scrollama
initScrollama();