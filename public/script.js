// ---------------------------------------
// 0. Utility: set up paths to your GeoJSON
// ---------------------------------------
// Adjust these if your filenames are different:
const curbUrl = "./data/paid_curb_spaces.geojson";
const garagesUrl = "./data/public_garages.geojson";

// ---------------------------------------
// 1. Leaflet Map Setup
// ---------------------------------------
const map = L.map("map", {
  center: [47.608, -122.335], // Central Seattle
  zoom: 11,                   // Initial view: All Seattle
  zoomControl: false,
  preferCanvas: true
});

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Layers & data
let curbLayer = null;
let garageLayer = null;
let curbCount = 0;
let garageCount = 0;
// Per-paid-area stats for the "parking personalities" chart
let areaStats = new Map(); // key: paid area string → { area, curb, garage }
let areaBounds = new Map();  // per-paid-area Leaflet bounds for zoom
let selectedAreaName = null;

// Whether to visually highlight non-parkable curb segments in red
let showRestrictionHighlight = false;
// When true, hide restricted curbs entirely so only "available" ones remain
let filterAvailableOnly = false;
// When true (Step 10), use categorical colors (Paid, No Park, Load, Other)
let showCategoryColoring = false;


// Simple haversine distance in km (for mapping garages to nearest paid area)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
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


// Helper: decide if a curb segment is basically "not parkable" for an ordinary driver
function isRestrictedCurb(feature) {
  const props = feature.properties || {};
  const category = (props.CATEGORY || "").toString().toUpperCase();
  const spaceType = (props.SPACETYPEDESC || "").toString().toUpperCase();

  // Category codes that are clearly not general-purpose parking
  const nonParkingCategories = new Set([
    "NP",   // No Parking
    "NS",   // No Stopping
    "BUS",  // Bus zones
    "BIKE", // Bike zones
    "LOAD", // Loading only
    "GOVT",
    "CS",
    "CARPOOL",
    "DP"
  ]);

  if (nonParkingCategories.has(category)) {
    return true;
  }

  // Extra text-based safety net
  const noParkKeywords = [
    "NO PARKING",
    "NO STOPPING",
    "BUS ZONE",
    "BUS ONLY",
    "TRANSIT ONLY",
    "TOW AWAY",
    "LOAD ONLY",
    "LOADING ONLY",
    "PARKLET"
  ];

  return noParkKeywords.some((kw) => spaceType.includes(kw));
}

// Get standardized category for a feature
function getCategoryLabel(category, spaceTypeDesc) {
  const cat = (category || "").toString().toUpperCase();
  const desc = (spaceTypeDesc || "").toString().toUpperCase();

  // Map to standard categories
  if (cat === "PAID" || desc.includes("PAID") || desc.includes("PAY STATION")) {
    return "PAID PARKING";
  }
  if (cat === "NP" || cat === "NS" || desc.includes("NO PARKING") || desc.includes("NO STOPPING")) {
    return "NO PARKING";
  }
  if (cat === "LOAD" || desc.includes("LOADING") || desc.includes("LOAD")) {
    return "LOADING / UNLOADING";
  }
  // Everything else goes to OTHERS
  return "OTHERS";
}

// Style function for curb segments.
function curbStyle(feature) {
  const props = feature.properties || {};
  
  // A. If Step 10: Categorical coloring
  if (showCategoryColoring) {
    // 🚀 OPTIMIZED: Use the pre-calculated color we made in Step 2
    const color = props._baseColor || "#757575"; 
    
    // Check selection (using simple string comparison)
    const myArea = (props.PAIDAREA || "Others").toString();
    
    // If an area is selected, and this isn't it, make it grey
    if (selectedAreaName && myArea !== selectedAreaName) {
      return {
        color: "#ddd", 
        weight: 1,
        opacity: 0.5,
        fillOpacity: 0.1
      };
    }

    return {
      color: color,
      weight: 2,
      opacity: 1,
      fillOpacity: 0.5
    };
  }

  // B. Standard logic (Steps 1-9)
  const restricted = isRestrictedCurb(feature);

  // If the toggle is ON, hide restricted segments entirely
  if (filterAvailableOnly && restricted) {
    return {
      color: "transparent",
      weight: 0,
      opacity: 0,
      fillOpacity: 0
    };
  }

  // Otherwise: blue by default, red if restriction highlighting is on
  let color = "#2468e8"; // default blue (available)

  if (showRestrictionHighlight && restricted) {
    color = "#cc0000"; // red for non-parkable segments
  }

  return {
    color,
    weight: 1,
    opacity: 0.9,
    fillOpacity: 0.3
  };
}


// Convenient bounds for downtown-ish focus
const downtownBounds = L.latLngBounds(
  [47.595, -122.355],
  [47.625, -122.315]
);

// Caption + hover DOM elements
const captionEl = document.getElementById("map-caption-text");
const hoverBodyEl = document.getElementById("hover-info-body");


// Toggle button (section 3) to show only available curb spaces
const availableToggleButton = document.getElementById("available-toggle");
if (availableToggleButton) {
  availableToggleButton.addEventListener("click", () => {
    // Flip the filter flag
    filterAvailableOnly = !filterAvailableOnly;

    // When filtering off, go back to blue+red view in section 3
    if (!filterAvailableOnly) {
      showRestrictionHighlight = true;
    }

    // Update button state & label
    availableToggleButton.setAttribute(
      "aria-pressed",
      filterAvailableOnly ? "true" : "false"
    );
    availableToggleButton.textContent = filterAvailableOnly
      ? "Show all curb segments"
      : "Show only available curb spaces";

    // Re-apply style to all curb features
    if (curbLayer) {
      curbLayer.setStyle(curbStyle);
    }
  });
}

// ---------------------------------------
// 2. Load GeoJSON and build layers
// ---------------------------------------
function formatProps(feature) {
  if (!feature || !feature.properties) return "No details available.";

  const props = feature.properties;

  // Try to guess some common useful fields if present:
  const name =
    props.NAME ||
    props.FACILITY_N ||
    props.BlockfaceID ||
    props.BLOCKFACE ||
    props.location ||
    null;

  const type =
    props.PARKING_TY || props.STREETUSE || props.SPACE_TYPE || props.type || null;

  const rate =
    props.RATE ||
    props.DAILYMAX ||
    props.HOURLY_RAT ||
    props.PARKING_RA ||
    null;

  const lines = [];

  if (name) lines.push(`<strong>${name}</strong>`);
  if (type) lines.push(`Type: ${type}`);
  if (rate) lines.push(`Rate: ${rate}`);

  if (lines.length === 0) {
    // fall back: show first 3 key/value pairs
    const keys = Object.keys(props).slice(0, 3);
    if (keys.length === 0) return "No properties.";
    keys.forEach((k) => {
      lines.push(`${k}: ${props[k]}`);
    });
  }

  return lines.join("<br/>");
}

function updateHoverInfo(htmlText) {
  hoverBodyEl.innerHTML = htmlText;
}

// Build per-paid-area stats and assign each garage to a nearest paid area
function computeAreaStats(curbData, garageData) {
  areaStats = new Map();
  areaBounds = new Map();   // ⬅️ reset bounds here

  // 1) Precompute "centroids" for curb segments with a PAIDAREA
  const curbCentroids = [];

  (curbData.features || []).forEach((f) => {
    const props = f.properties || {};
    let area = (props.PAIDAREA || "").toString().trim();
    if (!area || area.toUpperCase() === "N/A") {
      area = "Others";
    }

    // ---- build bounds for this area ----
    let bounds = areaBounds.get(area);
    if (!bounds) {
      bounds = L.latLngBounds();
      areaBounds.set(area, bounds);
    }

    const geom = f.geometry;
    if (geom && geom.type === "LineString" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
      const coords = geom.coordinates;

      // extend bounds with all coordinates
      coords.forEach((c) => {
        const [lng, lat] = c;
        bounds.extend([lat, lng]);
      });

      // centroid for garage assignment
      const mid = coords[Math.floor(coords.length / 2)];
      curbCentroids.push({ area, lng: mid[0], lat: mid[1] });
    }

    // Count curb segments per area
    let entry = areaStats.get(area);
    if (!entry) {
      entry = { area, curb: 0, garage: 0 };
      areaStats.set(area, entry);
    }
    entry.curb += 1;
  });

  // 2) Assign each garage to the nearest curb centroid (within ~0.5 km)
  (garageData.features || []).forEach((f) => {
    const geom = f.geometry;
    if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) return;

    const [lng, lat] = geom.coordinates;
    let bestArea = "Others";
    let bestDist = Infinity;

    curbCentroids.forEach((c) => {
      const d = haversineKm(lat, lng, c.lat, c.lng);
      if (d < bestDist) {
        bestDist = d;
        bestArea = c.area;
      }
    });

    if (bestDist > 0.5) {
      bestArea = "Others";
    }

    if (!f.properties) f.properties = {};
    f.properties._PAIDAREA = bestArea;

    let entry = areaStats.get(bestArea);
    if (!entry) {
      entry = { area: bestArea, curb: 0, garage: 0 };
      areaStats.set(bestArea, entry);
    }
    entry.garage += 1;

    // extend bounds with garage point too
    let bounds = areaBounds.get(bestArea);
    if (!bounds) {
      bounds = L.latLngBounds();
      areaBounds.set(bestArea, bounds);
    }
    bounds.extend([lat, lng]);
  });
}


function buildPersonalityChart(focusAreaName) {
  const svg = d3.select("#personality-chart");
  if (svg.empty()) return;

  // 1. Get the container width dynamically
  const container = svg.node().parentNode;
  const containerWidth = container ? container.getBoundingClientRect().width : 640;
  
  // 2. Increase height slightly for a bigger look
  const height = 400;

  // 3. Update margins: Keep bottom at 120 so labels are not cut off
  const margin = { top: 40, right: 80, bottom: 120, left: 60 };

  // Set SVG dimensions
  svg.attr("width", containerWidth).attr("height", height);
  svg.selectAll("*").remove();

  // ---------- DATA PREP ----------
  let rows = Array.from(areaStats.values()).filter(
    d => (d.curb || 0) + (d.garage || 0) > 0
  );

  // fixed order – clicking won't reorder
  rows.sort((a, b) => (b.curb + b.garage) - (a.curb + a.garage));

  rows = rows.map(d => {
    const total = d.curb + d.garage;
    const curbProp   = total > 0 ? d.curb   / total : 0;
    const garageProp = total > 0 ? d.garage / total : 0;
    return { ...d, curbProp, garageProp };
  });

  const x = d3.scaleBand()
    .domain(rows.map(d => d.area))
    .range([margin.left, containerWidth - margin.right]) // Use dynamic width
    .padding(0.2);

  const y = d3.scaleLinear()
    .domain([0, 1])
    .range([height - margin.bottom, margin.top]);

  const color = d3.scaleOrdinal()
    .domain(["curb", "garage"])
    .range(["#2468e8", "#7b1fa2"]);

  const g = svg.append("g");

  // ---------- AXES ----------
  g.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).tickSizeOuter(0))
    .selectAll("text")
    .attr("transform", "rotate(-35)")
    .style("text-anchor", "end")
    .attr("font-size", 10);

  g.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3.axisLeft(y)
        .ticks(5)
        .tickFormat(v => `${v * 100}%`)
        .tickSizeOuter(0)
    );

  g.append("text")
    .attr("x", margin.left - 40)
    .attr("y", (margin.top + height - margin.bottom) / 2)
    .attr(
      "transform",
      `rotate(-90, ${margin.left - 40}, ${(margin.top + height - margin.bottom) / 2})`
    )
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "#333")
    .text("Share of supply (curb vs garages)");

  // hint text
  g.append("text")
    .attr("x", margin.left)
    .attr("y", margin.top - 20)
    .attr("text-anchor", "start")
    .attr("font-size", 11)
    .attr("fill", "#555")
    .text("Hover to see percentages • Click a bar to zoom to that area on the map");

  // ---------- HTML TOOLTIP ----------
  const tooltip = d3
    .select("body")
    .selectAll(".parking-bar-tooltip")
    .data([null])
    .join("div")
    .attr("class", "parking-bar-tooltip");

  function showTooltip(event, d) {
    const curbPct   = d.curbProp   * 100;
    const garagePct = d.garageProp * 100;

    tooltip
      .style("display", "block")
      .style("left", event.clientX + 10 + "px")
      .style("top",  event.clientY + 10 + "px")
      .text(
        `Paid area ${d.area} • ` +
        `Curb: ${curbPct.toFixed(1)}% (${d.curb.toLocaleString()} segs) • ` +
        `Garages: ${garagePct.toFixed(1)}% (${d.garage.toLocaleString()})`
      );
  }

  function hideTooltip() {
    tooltip.style("display", "none");
  }

  // ---------- BARS (100% STACKED) ----------
  const areaGroups = g
    .selectAll(".area-group")
    .data(rows)
    .join("g")
    .attr("class", "area-group")
    .attr("transform", d => `translate(${x(d.area)},0)`);

  areaGroups.each(function (d) {
    const group   = d3.select(this);
    const isFocus = focusAreaName && d.area === focusAreaName;
    const opacity = isFocus || !focusAreaName ? 1 : 0.35;
    const outline = isFocus ? 2 : 0;

    // curb (bottom)
    const curbY0 = 0;
    const curbY1 = d.curbProp;
    group
      .append("rect")
      .attr("x", 0)
      .attr("width", x.bandwidth())
      .attr("y", y(curbY1))
      .attr("height", y(curbY0) - y(curbY1))
      .attr("fill", color("curb"))
      .attr("opacity", opacity)
      .attr("stroke", isFocus ? "#222" : "none")
      .attr("stroke-width", outline)
      .style("cursor", "pointer")
      .on("click", () => setSelectedArea(d.area))
      .on("mousemove", (event) => showTooltip(event, d))
      .on("mouseleave", hideTooltip);

    // garages (top)
    const garY0 = d.curbProp;
    const garY1 = garY0 + d.garageProp;
    group
      .append("rect")
      .attr("x", 0)
      .attr("width", x.bandwidth())
      .attr("y", y(garY1))
      .attr("height", y(garY0) - y(garY1))
      .attr("fill", color("garage"))
      .attr("opacity", opacity)
      .attr("stroke", isFocus ? "#222" : "none")
      .attr("stroke-width", outline)
      .style("cursor", "pointer")
      .on("click", () => setSelectedArea(d.area))
      .on("mousemove", (event) => showTooltip(event, d))
      .on("mouseleave", hideTooltip);
  });
}


// Helper to update the chart + caption when an area is chosen
function setSelectedArea(areaName) {
  // Toggle selection: if clicking the same area, deselect it
  if (selectedAreaName === areaName) {
    selectedAreaName = null;
  } else {
    selectedAreaName = areaName;
  }
  
  // Rebuild relevant charts to show highlight
  buildPersonalityChart(selectedAreaName);
  
  // If we are on Step 10, also highlight the ridgeline
  if (document.querySelector('.step[data-step="10"].is-active')) {
     buildRidgelineChart();
     
     // Also update map styles to grey out non-selected
     if (curbLayer) curbLayer.setStyle(curbStyle);
  }

  const captionEl = document.getElementById("personality-selection-caption");
  if (captionEl) {
    if (!selectedAreaName) {
      captionEl.textContent =
        "Showing the top paid areas by total supply. Click the map or bars to focus on a specific area.";
    } else {
      captionEl.textContent = `Showing curb vs. garage supply for paid area ${selectedAreaName}.`;
    }
  }

  // ⬇️ zoom the Leaflet map to that area's bounds (if we have them)
  if (selectedAreaName && areaBounds.has(selectedAreaName)) {
    const bounds = areaBounds.get(selectedAreaName);
    if (bounds && bounds.isValid && bounds.isValid()) {
      map.flyToBounds(bounds, {
        duration: 0.7,
        padding: [30, 30]
      });
    }
  } else if (!selectedAreaName) {
    // Zoom back out if deselected
    // REVERTED: Use Zoom 11 to match default "All Seattle"
    map.flyTo([47.608, -122.335], 11);
    
    // Reset map styles if returning to default
    if (curbLayer) curbLayer.setStyle(curbStyle);
  }
}


function buildLayers(curbData, garageData) {
  curbCount = curbData.features?.length || 0;
  garageCount = garageData.features?.length || 0;

  // Store curb data for ridgeline chart
  curbDataForRidgeline = curbData;
  garageDataForRidgeline = garageData; // Store garage data too

  // Paid curb spaces layer
  curbLayer = L.geoJSON(curbData, {
    style: curbStyle,   // ⬅️ use our function here
    onEachFeature: (feature, layer) => {
      layer.on({
        mouseover: (e) => {
          const target = e.target;
          
          // If available only, skip restricted
          if (filterAvailableOnly && isRestrictedCurb(feature)) return;
          
          target.setStyle({
            weight: 3,
            fillOpacity: 0.8
          });
          
          let colorLabel = "Curb segment";
          if(showCategoryColoring) {
            colorLabel = getCategoryLabel(feature.properties.CATEGORY, feature.properties.SPACETYPEDESC);
          }

          updateHoverInfo(
            `<span style="color:${target.options.color};font-weight:bold;">${colorLabel}</span><br/>${formatProps(
              feature
            )}`
          );
        },
        mouseout: (e) => {
          curbLayer.resetStyle(e.target);
          updateHoverInfo("Hover over a curb segment or garage to see details.");
        },
        click: () => {
          const area =
            (feature.properties?.PAIDAREA || "Others").toString();
          setSelectedArea(area);
        }
      });
    }
  });


  // Public garages layer
  garageLayer = L.geoJSON(garageData, {
  pointToLayer: (feature, latlng) =>
    L.circleMarker(latlng, {
      radius: 4,
      color: "#7b1fa2",
      fillColor: "#7b1fa2",
      fillOpacity: 0.9,
      weight: 1
    }),
  onEachFeature: (feature, layer) => {
    layer.on({
      mouseover: () => {
        layer.setStyle({
          radius: 6,
          weight: 2
        });
        updateHoverInfo(
          `<span style="color:#7b1fa2;font-weight:bold;">Public garage</span><br/>${formatProps(
            feature
          )}`
        );
      },
      mouseout: () => {
        layer.setStyle({
          radius: 4,
          weight: 1
        });
        updateHoverInfo("Hover over a curb segment or garage to see details.");
      },
      click: () => {
          const area =
            (feature.properties?._PAIDAREA || "Others").toString();
          setSelectedArea(area);
        }
    });
  }
});

  // Once layers exist, we can build the mini-chart
  buildMiniChart();
  // Build per-paid-area stats and the personalities chart
  computeAreaStats(curbData, garageData);
  buildPersonalityChart(selectedAreaName);
  // Build the ridgeline chart
  buildRidgelineChart();
}

// ---------------------------------------
// 3. D3 mini chart: Curb vs Garage counts
// ---------------------------------------
function buildMiniChart() {
  const svg = d3.select("#mini-chart-svg");
  svg.selectAll("*").remove(); // clear if rebuilding
  // 1. Get the actual width of the container (since we changed HTML to 100%)
  const width = svg.node().getBoundingClientRect().width;
  const height = +svg.attr("height");
  // 2. Increase 'right' margin from 10 to 50 to make room for the text labels
  const margin = { top: 10, right: 50, bottom: 30, left: 90 };

  const data = [
    { label: "Curb segments", value: curbCount },
    { label: "Garages", value: garageCount }
  ];

  const x = d3
    .scaleLinear()
    .domain([0, d3.max(data, (d) => d.value) || 1])
    .nice()
    .range([margin.left, width - margin.right]);

  const y = d3
    .scaleBand()
    .domain(data.map((d) => d.label))
    .range([margin.top, height - margin.bottom])
    .padding(0.3);

  const xAxis = (g) =>
    g
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(
        d3
          .axisBottom(x)
          .ticks(3)
          .tickSizeOuter(0)
      )

  const yAxis = (g) =>
    g
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).tickSizeOuter(0));

  svg.append("g").call(xAxis);
  svg.append("g").call(yAxis);

  const bars = svg
    .selectAll(".bar")
    .data(data)
    .enter()
    .append("rect")
    .attr("class", (d) => `bar bar-${d.label.replace(/\s+/g, "").toLowerCase()}`)
    .attr("y", (d) => y(d.label))
    .attr("x", margin.left)
    .attr("height", y.bandwidth())
    .attr("width", 0)
    .attr("fill", (d) =>
      d.label === "Curb segments" ? "#2468e8" : "#9333EA"
    );

  // simple bar grow-in animation
  bars
    .transition()
    .duration(800)
    .attr("width", (d) => x(d.value) - margin.left);

  // text labels on bars
  svg
    .selectAll(".bar-label")
    .data(data)
    .enter()
    .append("text")
    .attr("class", "bar-label")
    .attr("x", (d) => x(d.value) + 4)
    .attr("y", (d) => y(d.label) + y.bandwidth() / 2 + 4)
    .attr("font-size", 10)
    .text((d) => d.value.toLocaleString());
}

// small helper to pulse chart on certain steps
function highlightChart(kind) {
  d3.selectAll(".bar")
    .transition()
    .duration(200)
    .attr("opacity", (d) => {
      if (!kind) return 1;
      if (kind === "curb" && d.label === "Curb segments") return 1;
      if (kind === "garage" && d.label === "Garages") return 1;
      return 0.25;
    });
}

// ---------------------------------------
// ⭐ 4.5 HOTSPOTS
// ---------------------------------------
const hotspotLayer = document.getElementById("hotspot-layer");

// Move the hotspot layer inside the Leaflet map container so it gets clipped automatically
map.getContainer().appendChild(hotspotLayer);

const hotspotLatLngs = [
  [47.6095, -122.3343],
  [47.6138, -122.3425],
  [47.6038, -122.3311],
  [47.6112, -122.3208],
  [47.5987, -122.3319]
];

let activeHotspotCoords = [];

function createHotspots() {
  activeHotspotCoords = hotspotLatLngs; // store them
  hotspotLayer.innerHTML = "";
  hotspotLayer.style.display = "block";
  redrawHotspots();
}

function removeHotspots() {
  hotspotLayer.style.display = "none";
  hotspotLayer.innerHTML = "";
}

function redrawHotspots() {
  if (!hotspotLayer || hotspotLayer.style.display === "none") return;

  hotspotLayer.innerHTML = "";

  activeHotspotCoords.forEach((coords) => {
    const point = map.latLngToContainerPoint(coords);

    const div = document.createElement("div");
    div.className = "hotspot";
    div.style.left = point.x + "px";
    div.style.top = point.y + "px";

    hotspotLayer.appendChild(div);
  });
}

// ⭐ Ensure hotspots follow the map when it moves
map.on("move", redrawHotspots);
map.on("zoom", redrawHotspots);

// ---------------------------------------
// 4. Scrollama setup
// ---------------------------------------
const scroller = scrollama();
const steps = document.querySelectorAll(".step");

function setActiveStep(element) {
  steps.forEach((step) => step.classList.remove("is-active"));
  element.classList.add("is-active");
}

function handleStepEnter(response) {
  const stepEl = response.element;
  const stepNum = Number(stepEl.dataset.step);

  removeHotspots();
  setActiveStep(stepEl);

  // --- View Toggle Logic ---
  const mapView = document.getElementById("map-view");
  const animView = document.getElementById("animation-view");
  const legendStd = document.getElementById("legend-standard");
  const legendCat = document.getElementById("legend-category");

  // Step 11: Show Animation, Hide Map
  if (stepNum === 11) {
    mapView.classList.add("is-hidden");
    animView.classList.remove("is-hidden");
    return;
  } else {
    mapView.classList.remove("is-hidden");
    animView.classList.add("is-hidden");
  }

  // --- Map Layer Logic (Steps 1-10) ---

  // Reset defaults
  if (curbLayer && map.hasLayer(curbLayer)) map.removeLayer(curbLayer);
  if (garageLayer && map.hasLayer(garageLayer)) map.removeLayer(garageLayer);
  
  showRestrictionHighlight = false;
  showCategoryColoring = false; // Off by default except step 10
  
  // Default Legend
  if(legendStd) legendStd.style.display = "block";
  if(legendCat) legendCat.style.display = "none";

  let caption = "Initial view of central Seattle. Scroll to reveal curb spaces and garages.";
  highlightChart(null);

  if (stepNum === 1) {
    // CHANGED: Use Zoom 11 to match default "All Seattle"
    map.flyTo([47.608, -122.335], 11, { duration: 0.7 });
    caption = "Starting view: base map of Seattle.";
  }

  if (stepNum === 2) {
    if (curbLayer) {
      curbLayer.setStyle(curbStyle);
      curbLayer.addTo(map);
    }
    highlightChart("curb");
    caption = "Paid curb spaces (blue) highlight where the city actively manages curbside parking.";
  }

  if (stepNum === 3) {
    showRestrictionHighlight = true;
    if (curbLayer) {
      curbLayer.addTo(map);
      curbLayer.setStyle(curbStyle);
    }
    highlightChart("curb");
    caption = "Red curb segments show restricted blocks.";
  }

  if (stepNum === 4) {
    showRestrictionHighlight = true;
    if (garageLayer) garageLayer.addTo(map);
    highlightChart("garage");
    caption = "Public garages (red points) show off-street parking supply.";
  }

  if (stepNum === 5) {
    showRestrictionHighlight = true;
    if (curbLayer) {
      curbLayer.addTo(map);
      curbLayer.setStyle(curbStyle);
    }
    if (garageLayer) garageLayer.addTo(map);
    
    // REVERTED: Removed the zoom to 13, stays at previous zoom (likely 11)
    
    caption = "Curb segments and garage points overlap.";
  }

  if (stepNum === 6) {
    showRestrictionHighlight = true;
    if (curbLayer) {
      curbLayer.addTo(map);
      curbLayer.setStyle(curbStyle);
    }
    if (garageLayer) garageLayer.addTo(map);
    createHotspots();
    caption = "Parking hotspots appear.";
  }

  if (stepNum === 7) {
    showRestrictionHighlight = true;
    if (curbLayer) {
      curbLayer.addTo(map);
      curbLayer.setStyle(curbStyle);
    }
    if (garageLayer) garageLayer.addTo(map);
    map.flyToBounds(downtownBounds, { duration: 0.8, padding: [20, 20] });
    caption = "Zoomed into downtown.";
  }

  if (stepNum === 8) {
    showRestrictionHighlight = true;
    if (curbLayer) {
      curbLayer.addTo(map);
      curbLayer.setStyle(curbStyle);
    }
    if (garageLayer) garageLayer.addTo(map);
    // REVERTED: Zoom to 11
    map.flyTo([47.608, -122.335], 11, { duration: 0.7 });
    caption = "Visualizing where supply exists across the city.";
  }

  if (stepNum === 9) {
    // ⭐ DISCONNECT: Reset selection state for Step 9 so it starts fresh
    selectedAreaName = null;
    
    // Add standard layers
    if (curbLayer) {
      curbLayer.setStyle(curbStyle).addTo(map);
    }
    if (garageLayer) garageLayer.addTo(map);
    
    // Zoom back to default because we reset the selection
    // REVERTED: Use Zoom 11
    map.flyTo([47.608, -122.335], 11);
    
    // Build chart with null (fresh state)
    buildPersonalityChart(null);
    
    caption = "Explore parking personalities by clicking the map or chart.";
  }

  // ⭐ Step 10: Deep Dive / Category Coloring
  if (stepNum === 10) {
    // ⭐ DISCONNECT: Reset selection state for Step 10 so it starts all grey
    selectedAreaName = null;
    
    showCategoryColoring = true; // Use 4-color scheme
    
    // Switch Legend
    if(legendStd) legendStd.style.display = "none";
    if(legendCat) legendCat.style.display = "block";

    // Add layers
    if (curbLayer) {
      curbLayer.setStyle(curbStyle);
      curbLayer.addTo(map);
    }
    if (garageLayer) garageLayer.addTo(map);
    
    // Zoom back to default because we reset the selection
    // REVERTED: Use Zoom 11
    map.flyTo([47.608, -122.335], 11);

    caption = "Deep Dive: Click any bar or map area to highlight it and see the full category breakdown.";
    
    // Reset selection if not set, or ensure zoom
    buildRidgelineChart();
  }

  captionEl.textContent = caption;
}

function handleResize() {
  scroller.resize();
}

function initScrollama() {
  scroller
    .setup({
      step: ".step",
      offset: 0.6,
      debug: false
    })
    .onStepEnter(handleStepEnter);

  window.addEventListener("resize", handleResize);
}

// ---------------------------------------
// Ridgeline Chart: Curb Regulation Categories & Garages
// ---------------------------------------
let curbDataForRidgeline = null;
let garageDataForRidgeline = null;

function buildRidgelineChart() {
  const svg = d3.select("#ridgeline-chart");
  if (svg.empty() || !curbDataForRidgeline) return;

  svg.selectAll("*").remove();
  d3.selectAll(".ridgeline-tooltip").remove();

  const container = d3.select("#ridgeline-container").node();
  const containerWidth = container ? container.getBoundingClientRect().width : 500;
  
  const margin = { top: 40, right: 30, bottom: 20, left: 140 };
  const width = containerWidth - margin.left - margin.right;

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // --- DATA PROCESSING ---
  
  // 1. Curb Categories Data
  const categoryMap = new Map();
  const areaSet = new Set();
  
  (curbDataForRidgeline.features || []).forEach((f) => {
    const props = f.properties || {};
    let area = (props.PAIDAREA || "").toString().trim();
    if (!area || area.toUpperCase() === "N/A") area = "Others";
    areaSet.add(area);

    const category = getCategoryLabel(props.CATEGORY, props.SPACETYPEDESC);
    const key = `${area}|${category}`;
    categoryMap.set(key, (categoryMap.get(key) || 0) + 1);
  });

  // 2. Reuse `areaStats` for garage counts
  
  const areas = Array.from(areaSet).sort();
  const curbCategories = ["PAID PARKING", "NO PARKING", "LOADING / UNLOADING", "OTHERS"];

  // Build the unified data array
  const chartData = areas.map(area => {
    // Curb Data
    const totalCurb = curbCategories.reduce((sum, cat) => sum + (categoryMap.get(`${area}|${cat}`) || 0), 0);
    const curbBreakdown = curbCategories.map(cat => ({
      category: cat,
      count: categoryMap.get(`${area}|${cat}`) || 0,
      proportion: totalCurb > 0 ? (categoryMap.get(`${area}|${cat}`) || 0) / totalCurb : 0
    }));

    // Garage Data
    const garageEntry = areaStats.get(area);
    const garageCount = garageEntry ? garageEntry.garage : 0;
    
    return { 
      area, 
      curbBreakdown, 
      totalCurb, 
      garageCount 
    };
  });

  // Filter & Sort by Total Volume (Curb + Garage)
  const filteredData = chartData.filter(d => (d.totalCurb + d.garageCount) > 0);
  filteredData.sort((a, b) => b.totalCurb - a.totalCurb);

  // --- RENDER CONFIG ---
  const rowHeight = 40;
  const height = Math.max(filteredData.length * rowHeight, 400);

  svg.attr("width", containerWidth).attr("height", height + margin.top + margin.bottom);

  // Scales
  const yScale = d3.scaleBand()
    .domain(filteredData.map(d => d.area))
    .range([0, height])
    .padding(0.2);

  // Layout: Left 65% for Curb, Right 30% for Garages, 5% gap
  const curbWidth = width * 0.65;
  const garageStart = width * 0.70;
  const garageWidth = width * 0.30;

  const xScaleCurb = d3.scaleLinear().domain([0, 1]).range([0, curbWidth]); // 0 to 100%
  
  const maxGarage = d3.max(filteredData, d => d.garageCount) || 10;
  const xScaleGarage = d3.scaleLinear().domain([0, maxGarage]).range([0, garageWidth]);

  // Draw Y Axis Labels (Areas)
  const yAxisGroup = g.append("g").call(d3.axisLeft(yScale).tickSize(0));
  yAxisGroup.select(".domain").remove();
  
  yAxisGroup.selectAll("text")
    .attr("font-size", "11px")
    .attr("font-weight", d => d === selectedAreaName ? "bold" : "normal") 
    .attr("fill", d => d === selectedAreaName ? "#2468e8" : "#333")
    .style("cursor", "pointer")
    .on("click", (e, d) => setSelectedArea(d)); 

  // Color Scales
  const curbColorScale = d3.scaleOrdinal()
    .domain(curbCategories)
    .range(["#2468e8", "#cc0000", "#ff9900", "#757575"]); // Blue, Red, Orange, Grey

  // Tooltip
  const tooltip = d3.select("body").append("div")
    .attr("class", "ridgeline-tooltip")
    .style("opacity", 0)
    .style("position", "absolute");

  // --- DRAWING LOOP ---
  filteredData.forEach(d => {
    const rowGroup = g.append("g")
      .attr("transform", `translate(0, ${yScale(d.area)})`);
      
    // Is this row active?
    // If NO selection exists, they are ALL gray (as requested "grey first")
    // If SELECTION exists, only the selected one is colored.
    const isActive = (selectedAreaName && d.area === selectedAreaName);
    
    // Background click rect
    rowGroup.append("rect")
      .attr("width", width + margin.left)
      .attr("height", yScale.bandwidth())
      .attr("x", -margin.left)
      .attr("fill", "transparent")
      .style("cursor", "pointer")
      .on("click", () => setSelectedArea(d.area));

    // --- LEFT: CURB STACKED BAR ---
    let currentX = 0;
    d.curbBreakdown.forEach(seg => {
      const segWidth = xScaleCurb(seg.proportion);
      const isSegActive = isActive; 
      
      rowGroup.append("rect")
        .attr("x", currentX)
        .attr("y", 0)
        .attr("width", segWidth)
        .attr("height", yScale.bandwidth())
        // If active: use category color. If inactive: use grey #cccccc.
        .attr("fill", isSegActive ? curbColorScale(seg.category) : "#cccccc")
        .attr("stroke", "#fff") // separation line
        .attr("stroke-width", 1)
        .style("pointer-events", "none");
        
      currentX += segWidth;
    });

    // --- RIGHT: GARAGE BAR ---
    const barWidth = xScaleGarage(d.garageCount);
    const isGarActive = isActive;

    rowGroup.append("rect")
      .attr("x", garageStart)
      .attr("y", 0)
      .attr("width", barWidth)
      .attr("height", yScale.bandwidth())
      // If active: purple. If inactive: grey #cccccc.
      .attr("fill", isGarActive ? "#7b1fa2" : "#cccccc")
      .style("pointer-events", "none");

    // Garage Value Label (only if active or large enough?)
    // Let's show it always but maybe grey text if inactive
    if (barWidth > 0) {
      rowGroup.append("text")
        .attr("x", garageStart + barWidth + 5)
        .attr("y", yScale.bandwidth() / 2 + 4)
        .text(d.garageCount)
        .attr("font-size", "10px")
        .attr("fill", isGarActive ? "#333" : "#999");
    }

    // --- HOVER TOOLTIP (Aggregated) ---
    rowGroup
      .on("mouseover", (e) => {
         const list = d.curbBreakdown.map(s => `
           <div style="display:flex;align-items:center;gap:4px;">
             <span style="display:inline-block;width:8px;height:8px;background:${curbColorScale(s.category)};border-radius:2px;"></span>
             ${s.category}: <strong>${(s.proportion*100).toFixed(1)}%</strong>
           </div>`).join("");
         
         tooltip.html(`
           <strong>${d.area}</strong><br/>
           <div style="margin-top:4px;border-bottom:1px solid #555;padding-bottom:4px;margin-bottom:4px;">
             Garages: <strong>${d.garageCount}</strong>
           </div>
           Curb Segments: <strong>${d.totalCurb}</strong><br/>
           ${list}
         `)
           .style("opacity", 1)
           .style("left", (e.pageX + 15) + "px")
           .style("top", (e.pageY - 10) + "px");
      })
      .on("mouseout", () => tooltip.style("opacity", 0));
  });

  // --- LEGEND (Custom Headers) ---
  const headerGroup = svg.append("g")
     .attr("transform", `translate(${margin.left}, 0)`);
  
  // Left Header
  headerGroup.append("text")
    .attr("x", 0)
    .attr("y", -20)
    .text("Curb Category Breakdown (100%)")
    .attr("font-size", "10px")
    .attr("font-weight", "bold")
    .attr("fill", "#555");
    
  // Right Header
  headerGroup.append("text")
    .attr("x", garageStart)
    .attr("y", -20)
    .text("Public Garage Count")
    .attr("font-size", "10px")
    .attr("font-weight", "bold")
    .attr("fill", "#555");
}

// ---------------------------------------
// 5. Fetch data & kick everything off
// ---------------------------------------
Promise.all([fetch(curbUrl), fetch(garagesUrl)])
  .then(async ([resCurb, resGar]) => {
    if (!resCurb.ok) throw new Error("Failed to load curb data");
    if (!resGar.ok) throw new Error("Failed to load garages data");
    const curbData = await resCurb.json();
    const garageData = await resGar.json();

    curbData.features.forEach(f => {
      const p = f.properties;
      // Store the category string directly on the feature
      p._cachedCategory = getCategoryLabel(p.CATEGORY, p.SPACETYPEDESC);
      // Determine the base color once and store it
      if (p._cachedCategory === "PAID PARKING") p._baseColor = "#2468e8";
      else if (p._cachedCategory === "NO PARKING") p._baseColor = "#cc0000";
      else if (p._cachedCategory === "LOADING / UNLOADING") p._baseColor = "#ff9900";
      else p._baseColor = "#757575";
    });

    buildLayers(curbData, garageData);
  })
  .catch((err) => {
    console.error(err);
    captionEl.textContent =
      "Error loading GeoJSON data. Check the console and file paths.";
  });

// Play / replay animations per scenario panel
const scenarioPanels = document.querySelectorAll(".scenario-panel");

scenarioPanels.forEach((panel) => {
  const btn = panel.querySelector(".scenario-play-btn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    // Remove .playing to reset any running animation
    panel.classList.remove("playing");

    // Force reflow so CSS animations can restart
    // (reading offsetWidth is a classic trick for this)
    // eslint-disable-next-line no-unused-expressions
    panel.offsetWidth;

    // Add .playing to trigger animations for this panel only
    panel.classList.add("playing");
  });
});


// Initialize scroll behavior after DOM is ready
initScrollama();