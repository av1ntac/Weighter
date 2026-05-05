const chart = document.getElementById("chart");
const tooltip = document.getElementById("tooltip");
const statusEl = document.getElementById("status");
const entryForm = document.getElementById("entry-form");
const weightInput = document.getElementById("weight-input");
const dateInput = document.getElementById("date-input");
const timeInput = document.getElementById("time-input");
const userSelect = document.getElementById("user-select");
const API_BASE_URL = String(window.WEIGHT_API_BASE_URL || "").replace(/\/+$/, "");

const WIDTH = 960;
const HEIGHT = 520;
const MARGIN = { top: 32, right: 28, bottom: 56, left: 72 };
const USER_STORAGE_KEY = "weight-tracker-user";
const ZOOM_FACTOR = 0.33;

let zoomStart = null;
let zoomEnd = null;
let allRows = [];
let allDesiredWeights = [];

let dragStartX = null;
let dragStartZoomStart = null;
let dragStartZoomEnd = null;
let wasDragged = false;

initializeEntryForm();
initializeUsers();
entryForm.addEventListener("submit", saveWeight);
document.addEventListener("click", handleDocumentClick);
document.addEventListener("keydown", handleDocumentKeydown);
tooltip.addEventListener("click", handleTooltipClick);
userSelect.addEventListener("change", handleUserChange);
document.getElementById("zoom-in").addEventListener("click", applyZoomIn);
document.getElementById("zoom-out").addEventListener("click", applyZoomOut);
chart.addEventListener("wheel", handleChartWheel, { passive: true });
chart.addEventListener("pointerdown", handleChartPointerDown);
document.addEventListener("pointermove", handleChartPointerMove);
document.addEventListener("pointerup", handleChartPointerUp);
document.addEventListener("pointercancel", handleChartPointerUp);

function buildApiUrl(path, query = {}) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${API_BASE_URL}${normalizedPath}`, window.location.origin);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function initializeEntryForm() {
  const now = new Date();
  dateInput.value = formatDateInputValue(now);
  timeInput.value = formatTimeInputValue(now);
}

async function initializeUsers() {
  statusEl.textContent = "Loading users...";

  try {
    const response = await fetch(buildApiUrl("/api/users"), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const availableUsers = Array.isArray(payload.users) ? payload.users : [];
    const storedUser = sanitizeUserName(window.localStorage.getItem(USER_STORAGE_KEY));
    const availableUserIds = availableUsers.map((user) => sanitizeUserName(user.id)).filter(Boolean);
    const fallbackUser = availableUserIds[0];

    renderUserOptions(availableUsers);

    if (!fallbackUser) {
      userSelect.disabled = true;
      statusEl.textContent = "No user CSV files found.";
      renderEmptyState("No users found");
      return;
    }

    const activeUser = availableUserIds.includes(storedUser) ? storedUser : fallbackUser;
    setActiveUser(activeUser);
    await loadChartFromApi();
  } catch (error) {
    statusEl.textContent = `Unable to load users: ${error.message}`;
    renderEmptyState("No data loaded");
  }
}

async function loadChartFromApi() {
  const activeUser = getActiveUser();

  try {
    const response = await fetch(buildApiUrl("/api/weights", { user: activeUser }), { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 404) {
        statusEl.textContent = `No weight records yet for ${formatUserLabel(activeUser)}. Add the first point to create a CSV file.`;
        allRows = [];
        allDesiredWeights = [];
        zoomStart = null;
        zoomEnd = null;
        renderEmptyState("No data loaded");
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const points = (payload.items || [])
      .map((row) => normalizeRow(row))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);
    const desiredWeights = (payload.desired_weights || [])
      .map((value) => Number.parseFloat(value))
      .filter((value) => !Number.isNaN(value));

    if (!points.length) {
      statusEl.textContent = `No weight records yet for ${formatUserLabel(activeUser)}. Add the first point to populate the chart.`;
      allRows = [];
      allDesiredWeights = [];
      zoomStart = null;
      zoomEnd = null;
      renderEmptyState("No data loaded");
      return;
    }

    const targetLabel = desiredWeights.length
      ? ` ${desiredWeights.length} desired weight line${desiredWeights.length === 1 ? "" : "s"} shown.`
      : "";
    statusEl.textContent = `Loaded ${points.length} records for ${formatUserLabel(activeUser)}.${targetLabel}`;
    allRows = points;
    allDesiredWeights = desiredWeights;
    renderZoomedChart();
  } catch (error) {
    statusEl.textContent = `Unable to load API data: ${error.message}`;
    allRows = [];
    allDesiredWeights = [];
    zoomStart = null;
    zoomEnd = null;
    renderEmptyState("No data loaded");
  }
}

async function saveWeight(event) {
  event.preventDefault();

  const payload = {
    weight: Number.parseFloat(weightInput.value),
    date: dateInput.value,
    time: timeInput.value,
  };

  if (Number.isNaN(payload.weight) || !payload.date || !payload.time) {
    statusEl.textContent = "Enter a valid weight, date, and time before saving.";
    return;
  }

  const submitButton = entryForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  statusEl.textContent = "Saving weight entry...";

  try {
    const activeUser = getActiveUser();
    const requestUrl = buildApiUrl("/api/weights", { user: activeUser });
    const responseWithUser = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!responseWithUser.ok) {
      const errorPayload = await responseWithUser.json().catch(() => ({}));
      throw new Error(errorPayload.detail || `HTTP ${responseWithUser.status}`);
    }

    weightInput.value = "";
    initializeEntryForm();
    await loadChartFromApi();
    statusEl.textContent = `Saved ${payload.weight.toFixed(1)} kg for ${formatUserLabel(activeUser)} on ${payload.date} at ${payload.time}.`;
  } catch (error) {
    statusEl.textContent = `Unable to save weight: ${error.message}`;
  } finally {
    submitButton.disabled = false;
  }
}

function normalizeRow(row) {
  const timestamp = new Date(row.timestamp || `${row.date}T${row.time}`);
  const weight = Number.parseFloat(row.weight);

  if (Number.isNaN(timestamp.getTime()) || Number.isNaN(weight)) {
    return null;
  }

  return {
    id: row.id,
    date: row.date,
    time: row.time,
    weight,
    timestamp,
  };
}

function renderChart(points, desiredWeights = []) {
  const xMin = points[0].timestamp.getTime();
  const xMax = points[points.length - 1].timestamp.getTime();
  const weights = points.map((point) => point.weight).concat(desiredWeights);
  const yMinRaw = Math.min(...weights);
  const yMaxRaw = Math.max(...weights);
  const yPadding = Math.max((yMaxRaw - yMinRaw) * 0.1, 0.5);
  const yMin = yMinRaw - yPadding;
  const yMax = yMaxRaw + yPadding;

  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

  const scaleX = (value) => {
    if (xMax === xMin) {
      return MARGIN.left + innerWidth / 2;
    }
    return MARGIN.left + ((value - xMin) / (xMax - xMin)) * innerWidth;
  };

  const scaleY = (value) => {
    if (yMax === yMin) {
      return MARGIN.top + innerHeight / 2;
    }
    return MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * innerHeight;
  };

  const pathData = points
    .map((point, index) => {
      const x = scaleX(point.timestamp.getTime());
      const y = scaleY(point.weight);
      point.x = x;
      point.y = y;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  const yTicks = buildTicks(yMin, yMax, 5);
  const xTicks = buildDateTicks(points, 5);
  const yearStart = points[0].timestamp.getFullYear();
  const yearEnd = points[points.length - 1].timestamp.getFullYear();
  const yearLabel = yearStart === yearEnd ? String(yearStart) : `${yearStart}–${yearEnd}`;
  const desiredLines = desiredWeights.map((value, index) => ({
    value,
    y: scaleY(value),
    labelY: Math.max(MARGIN.top + 16, scaleY(value) - 8 + index * 0.01),
  }));

  chart.innerHTML = `
    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="transparent"></rect>
    ${yTicks.map((tick) => `
      <g>
        <line x1="${MARGIN.left}" y1="${scaleY(tick.value)}" x2="${WIDTH - MARGIN.right}" y2="${scaleY(tick.value)}" stroke="var(--grid)" stroke-width="1"></line>
        <text x="${MARGIN.left - 12}" y="${scaleY(tick.value) + 5}" text-anchor="end" fill="var(--muted)" font-size="13">${tick.label}</text>
      </g>
    `).join("")}
    ${xTicks.map((tick) => `
      <g>
        <line x1="${tick.x}" y1="${MARGIN.top}" x2="${tick.x}" y2="${HEIGHT - MARGIN.bottom}" stroke="var(--grid)" stroke-width="1"></line>
        <text x="${tick.x}" y="${HEIGHT - MARGIN.bottom + 26}" text-anchor="middle" fill="var(--muted)" font-size="13">${tick.label}</text>
      </g>
    `).join("")}
    <line x1="${MARGIN.left}" y1="${HEIGHT - MARGIN.bottom}" x2="${WIDTH - MARGIN.right}" y2="${HEIGHT - MARGIN.bottom}" stroke="var(--text)" stroke-width="1.5"></line>
    <line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${HEIGHT - MARGIN.bottom}" stroke="var(--text)" stroke-width="1.5"></line>
    <text x="${WIDTH - MARGIN.right}" y="20" text-anchor="end" fill="var(--muted)" font-size="15">${yearLabel}</text>
    <text x="22" y="${HEIGHT / 2}" text-anchor="middle" fill="var(--muted)" font-size="15" transform="rotate(-90 22 ${HEIGHT / 2})">Weight (kg)</text>
    ${desiredLines.map((line) => `
      <g>
        <line
          x1="${MARGIN.left}"
          y1="${line.y}"
          x2="${WIDTH - MARGIN.right}"
          y2="${line.y}"
          stroke="var(--target)"
          stroke-width="2"
          stroke-dasharray="10 8"
        ></line>
        <text
          x="${WIDTH - MARGIN.right - 8}"
          y="${line.labelY}"
          text-anchor="end"
          fill="var(--target)"
          font-size="13"
        >Goal ${line.value.toFixed(1)} kg</text>
      </g>
    `).join("")}
    <path d="${pathData}" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"></path>
    ${points.map((point) => `
      <circle
        class="data-point"
        cx="${point.x}"
        cy="${point.y}"
        r="5.5"
        fill="white"
        stroke="var(--accent)"
        stroke-width="3"
        tabindex="0"
        role="button"
        aria-label="Weight ${point.weight.toFixed(1)} kilograms on ${point.date} at ${point.time}"
        data-id="${point.id}"
        data-date="${point.date}"
        data-time="${point.time}"
        data-weight="${point.weight.toFixed(1)}"
        data-x="${point.x}"
        data-y="${point.y}"
      ></circle>
    `).join("")}
  `;

  chart.querySelectorAll(".data-point").forEach((circle) => {
    circle.addEventListener("click", handlePointClick);
    circle.addEventListener("keydown", handlePointKeydown);
  });

  hideTooltip();
}

function renderEmptyState(message) {
  chart.innerHTML = `
    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="transparent"></rect>
    <text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" fill="var(--muted)" font-size="24">${message}</text>
  `;
  chart.style.cursor = "";
  hideTooltip();
  updateZoomButtons();
}

function renderZoomedChart() {
  if (!allRows.length) return;
  let visible = allRows;
  if (zoomStart !== null && zoomEnd !== null) {
    visible = allRows.filter(
      (r) => r.timestamp.getTime() >= zoomStart && r.timestamp.getTime() <= zoomEnd
    );
  }
  if (visible.length < 2) {
    visible = allRows;
    zoomStart = null;
    zoomEnd = null;
  }
  chart.style.cursor = zoomStart !== null ? "grab" : "";
  updateZoomButtons();
  renderChart(visible, allDesiredWeights);
}

function updateZoomButtons() {
  const zoomInBtn = document.getElementById("zoom-in");
  const zoomOutBtn = document.getElementById("zoom-out");
  if (!zoomInBtn || !zoomOutBtn) return;
  const noData = allRows.length < 2;
  zoomOutBtn.disabled = noData || (zoomStart === null && zoomEnd === null);
  if (noData) { zoomInBtn.disabled = true; return; }
  const currentStart = zoomStart ?? allRows[0].timestamp.getTime();
  const currentEnd = zoomEnd ?? allRows[allRows.length - 1].timestamp.getTime();
  const span = currentEnd - currentStart;
  const nextStart = currentStart + span * ZOOM_FACTOR;
  const nextVisible = allRows.filter(
    (r) => r.timestamp.getTime() >= nextStart && r.timestamp.getTime() <= currentEnd
  );
  zoomInBtn.disabled = nextVisible.length < 2;
}

function applyZoomIn() {
  if (allRows.length < 2) return;
  const currentStart = zoomStart ?? allRows[0].timestamp.getTime();
  const currentEnd = zoomEnd ?? allRows[allRows.length - 1].timestamp.getTime();
  const span = currentEnd - currentStart;
  const newStart = currentStart + span * ZOOM_FACTOR;
  const wouldBeVisible = allRows.filter(
    (r) => r.timestamp.getTime() >= newStart && r.timestamp.getTime() <= currentEnd
  );
  if (wouldBeVisible.length < 2) return;
  zoomStart = newStart;
  zoomEnd = currentEnd;
  renderZoomedChart();
}

function applyZoomOut() {
  if (allRows.length < 2 || (zoomStart === null && zoomEnd === null)) return;
  const dataStart = allRows[0].timestamp.getTime();
  const dataEnd = allRows[allRows.length - 1].timestamp.getTime();
  const span = zoomEnd - zoomStart;
  const newStart = Math.max(zoomEnd - span / (1 - ZOOM_FACTOR), dataStart);
  if (newStart <= dataStart && zoomEnd >= dataEnd) {
    zoomStart = null;
    zoomEnd = null;
  } else {
    zoomStart = newStart;
    // zoomEnd stays fixed
  }
  renderZoomedChart();
}

function applyPanDelta(deltaMs) {
  if (allRows.length < 2 || zoomStart === null) return;
  const dataStart = allRows[0].timestamp.getTime();
  const dataEnd = allRows[allRows.length - 1].timestamp.getTime();
  let newStart = zoomStart + deltaMs;
  let newEnd = zoomEnd + deltaMs;
  if (newStart < dataStart) { newEnd += dataStart - newStart; newStart = dataStart; }
  if (newEnd > dataEnd) { newStart -= newEnd - dataEnd; newEnd = dataEnd; }
  zoomStart = newStart;
  zoomEnd = newEnd;
  renderZoomedChart();
}

function handleChartWheel(e) {
  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const bounds = chart.getBoundingClientRect();
    const timeSpan = (zoomEnd ?? allRows[allRows.length - 1]?.timestamp.getTime() ?? 0) -
                     (zoomStart ?? allRows[0]?.timestamp.getTime() ?? 0);
    const actualInnerWidth = bounds.width * (innerWidth / WIDTH);
    applyPanDelta((e.deltaX / actualInnerWidth) * timeSpan);
  } else if (e.deltaY < 0) {
    applyZoomIn();
  } else if (e.deltaY > 0) {
    applyZoomOut();
  }
}

function handleChartPointerDown(e) {
  if (zoomStart === null || e.button !== 0) return;
  dragStartX = e.clientX;
  dragStartZoomStart = zoomStart;
  dragStartZoomEnd = zoomEnd;
  wasDragged = false;
  chart.setPointerCapture(e.pointerId);
  chart.style.cursor = "grabbing";
}

function handleChartPointerMove(e) {
  if (dragStartX === null) return;
  if (Math.abs(e.clientX - dragStartX) > 4) wasDragged = true;
  if (!wasDragged) return;
  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  const bounds = chart.getBoundingClientRect();
  const svgPxPerActualPx = WIDTH / bounds.width;
  const dragDeltaSvgPx = (e.clientX - dragStartX) * svgPxPerActualPx;
  const timeSpan = dragStartZoomEnd - dragStartZoomStart;
  const msDelta = -(dragDeltaSvgPx / innerWidth) * timeSpan;
  const dataStart = allRows[0].timestamp.getTime();
  const dataEnd = allRows[allRows.length - 1].timestamp.getTime();
  let newStart = dragStartZoomStart + msDelta;
  let newEnd = dragStartZoomEnd + msDelta;
  if (newStart < dataStart) { newEnd += dataStart - newStart; newStart = dataStart; }
  if (newEnd > dataEnd) { newStart -= newEnd - dataEnd; newEnd = dataEnd; }
  zoomStart = newStart;
  zoomEnd = newEnd;
  renderZoomedChart();
  chart.style.cursor = "grabbing";
}

function handleChartPointerUp() {
  if (dragStartX === null) return;
  dragStartX = null;
  dragStartZoomStart = null;
  dragStartZoomEnd = null;
  chart.style.cursor = zoomStart !== null ? "grab" : "";
}

function showTooltip(event) {
  const target = event.currentTarget || event.target;
  const [y, m, d] = target.dataset.date.split("-");
  tooltip.innerHTML = `
    <span class="tooltip__date">${d}.${m}.${y}</span>
    <strong class="tooltip__value">${target.dataset.weight} kg</strong>
    <button class="tooltip__delete" type="button" data-action="delete-point" data-id="${target.dataset.id}">Delete</button>
  `;
  tooltip.hidden = false;
  positionTooltip(target);
}

function positionTooltip(target) {
  const bounds = chart.getBoundingClientRect();
  const scaleX = bounds.width / WIDTH;
  const scaleY = bounds.height / HEIGHT;
  const x = Number.parseFloat(target.dataset.x) * scaleX;
  const y = Number.parseFloat(target.dataset.y) * scaleY;
  const margin = 12;

  tooltip.style.left = `${Math.min(bounds.width - margin, Math.max(margin, x))}px`;
  tooltip.style.top = `${Math.min(bounds.height - margin, Math.max(margin, y))}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
  tooltip.innerHTML = "";
}

function handlePointClick(event) {
  if (wasDragged) { wasDragged = false; return; }
  event.stopPropagation();
  showTooltip(event);
}

function handlePointKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  showTooltip(event);
}

function handleDocumentClick(event) {
  if (tooltip.hidden) {
    return;
  }

  if (tooltip.contains(event.target) || event.target.closest(".data-point")) {
    return;
  }

  hideTooltip();
}

function handleDocumentKeydown(event) {
  if (event.key === "Escape") {
    hideTooltip();
  }
}

async function handleTooltipClick(event) {
  const button = event.target.closest('[data-action="delete-point"]');
  if (!button) return;

  const { id } = button.dataset;
  const weight = tooltip.querySelector(".tooltip__value")?.textContent || "this point";
  const date = tooltip.querySelector(".tooltip__date")?.textContent || "";

  if (!window.confirm(`Delete ${weight} from ${date}?`)) return;

  button.disabled = true;
  button.textContent = "Deleting…";
  statusEl.textContent = "Deleting weight entry...";

  try {
    const activeUser = getActiveUser();
    const response = await fetch(buildApiUrl(`/api/weights/${id}`, { user: activeUser }), { method: "DELETE" });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || `HTTP ${response.status}`);
    }
    const payload = await response.json();
    hideTooltip();
    await loadChartFromApi();
    statusEl.textContent = `Deleted ${payload.weight} kg for ${formatUserLabel(activeUser)} on ${payload.date} at ${payload.time}.`;
  } catch (error) {
    statusEl.textContent = `Unable to delete weight: ${error.message}`;
    button.disabled = false;
    button.textContent = "Delete";
  }
}

function buildTicks(min, max, count) {
  const ticks = [];
  const step = (max - min) / count;

  for (let i = 0; i <= count; i += 1) {
    const value = min + step * i;
    ticks.push({
      value,
      label: value.toFixed(1),
    });
  }

  return ticks;
}

function buildDateTicks(points, count) {
  const fmt = (d) =>
    `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;

  const ticks = [];
  const lastIndex = points.length - 1;
  const step = Math.max(1, Math.floor(lastIndex / count));

  for (let i = 0; i <= lastIndex; i += step) {
    const point = points[i];
    ticks.push({ x: point.x, label: fmt(point.timestamp) });
  }

  const lastPoint = points[lastIndex];
  if (!ticks.length || ticks[ticks.length - 1].x !== lastPoint.x) {
    ticks.push({ x: lastPoint.x, label: fmt(lastPoint.timestamp) });
  }

  return ticks;
}

function formatDateInputValue(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimeInputValue(date) {
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getActiveUser() {
  return sanitizeUserName(userSelect.value || "default");
}

function setActiveUser(user) {
  const normalizedUser = sanitizeUserName(user);
  userSelect.value = normalizedUser;
  window.localStorage.setItem(USER_STORAGE_KEY, normalizedUser);
}

function renderUserOptions(users) {
  const normalizedUsers = users
    .map((user) => ({
      id: sanitizeUserName(user.id),
      label: user.label || formatUserLabel(user.id),
    }))
    .filter((user) => user.id);

  userSelect.disabled = normalizedUsers.length === 0;
  userSelect.innerHTML = normalizedUsers
    .map((user) => `<option value="${user.id}">${user.label}</option>`)
    .join("");
}

async function handleUserChange() {
  setActiveUser(userSelect.value);
  hideTooltip();
  zoomStart = null;
  zoomEnd = null;
  await loadChartFromApi();
}

function sanitizeUserName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatUserLabel(user) {
  if (user === "default") {
    return "default";
  }

  return user
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
