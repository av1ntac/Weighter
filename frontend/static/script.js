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

initializeEntryForm();
initializeUsers();
entryForm.addEventListener("submit", saveWeight);
document.addEventListener("click", handleDocumentClick);
document.addEventListener("keydown", handleDocumentKeydown);
tooltip.addEventListener("click", handleTooltipClick);
userSelect.addEventListener("change", handleUserChange);

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
      renderEmptyState("No data loaded");
      return;
    }

    const targetLabel = desiredWeights.length
      ? ` ${desiredWeights.length} desired weight line${desiredWeights.length === 1 ? "" : "s"} shown.`
      : "";
    statusEl.textContent = `Loaded ${points.length} records for ${formatUserLabel(activeUser)}.${targetLabel}`;
    renderChart(points, desiredWeights);
  } catch (error) {
    statusEl.textContent = `Unable to load API data: ${error.message}`;
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
    <text x="${WIDTH / 2}" y="${HEIGHT - 16}" text-anchor="middle" fill="var(--muted)" font-size="15">Date</text>
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
  hideTooltip();
}

function showTooltip(event) {
  const target = event.currentTarget || event.target;
  tooltip.innerHTML = `
    <strong>${target.dataset.weight} kg</strong>
    <span>${target.dataset.date}</span>
    <span>${target.dataset.time}</span>
    <button class="tooltip__button" type="button" data-action="delete-point" data-id="${target.dataset.id}">
      Delete point
    </button>
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
  if (!button) {
    return;
  }

  const { id } = button.dataset;
  const weight = tooltip.querySelector("strong")?.textContent || "this point";
  const date = tooltip.querySelector("span")?.textContent || "";

  if (!window.confirm(`Delete ${weight} from ${date}?`)) {
    return;
  }

  button.disabled = true;
  button.textContent = "Deleting...";
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
    button.textContent = "Delete point";
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
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const ticks = [];
  const lastIndex = points.length - 1;
  const step = Math.max(1, Math.floor(lastIndex / count));

  for (let i = 0; i <= lastIndex; i += step) {
    const point = points[i];
    ticks.push({
      x: point.x,
      label: formatter.format(point.timestamp),
    });
  }

  const lastPoint = points[lastIndex];
  if (!ticks.length || ticks[ticks.length - 1].x !== lastPoint.x) {
    ticks.push({
      x: lastPoint.x,
      label: formatter.format(lastPoint.timestamp),
    });
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
