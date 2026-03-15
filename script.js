const chart = document.getElementById("chart");
const tooltip = document.getElementById("tooltip");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("file-input");

const WIDTH = 960;
const HEIGHT = 520;
const MARGIN = { top: 32, right: 28, bottom: 56, left: 72 };

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  const text = await file.text();
  loadChartFromCsv(text, file.name);
});

attemptDefaultLoad();

async function attemptDefaultLoad() {
  try {
    const response = await fetch("./data.csv", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    loadChartFromCsv(text, "data.csv");
  } catch (error) {
    statusEl.textContent = "Open a CSV file to draw the chart. Automatic loading works when the page is served over HTTP.";
    renderEmptyState("No data loaded");
  }
}

function loadChartFromCsv(csvText, sourceName) {
  try {
    const rows = parseCsv(csvText);
    const points = rows
      .map((row) => normalizeRow(row))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!points.length) {
      throw new Error("No valid rows found in CSV.");
    }

    statusEl.textContent = `Loaded ${points.length} records from ${sourceName}.`;
    renderChart(points);
  } catch (error) {
    statusEl.textContent = error.message;
    renderEmptyState("Unable to draw chart");
  }
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const headers = splitCsvLine(lines[0]).map((value) => value.trim().toLowerCase());
  const requiredHeaders = ["date", "time", "weight"];

  for (const required of requiredHeaders) {
    if (!headers.includes(required)) {
      throw new Error(`Missing required column: ${required}`);
    }
  }

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = (values[index] || "").trim();
    });

    return row;
  });
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function normalizeRow(row) {
  const timestamp = new Date(`${row.date}T${row.time}`);
  const weight = Number.parseFloat(row.weight);

  if (Number.isNaN(timestamp.getTime()) || Number.isNaN(weight)) {
    return null;
  }

  return {
    date: row.date,
    time: row.time,
    weight,
    timestamp,
  };
}

function renderChart(points) {
  const xMin = points[0].timestamp.getTime();
  const xMax = points[points.length - 1].timestamp.getTime();
  const weights = points.map((point) => point.weight);
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
        data-date="${point.date}"
        data-time="${point.time}"
        data-weight="${point.weight.toFixed(1)}"
      ></circle>
    `).join("")}
  `;

  chart.querySelectorAll(".data-point").forEach((circle) => {
    circle.addEventListener("mouseenter", showTooltip);
    circle.addEventListener("mousemove", moveTooltip);
    circle.addEventListener("mouseleave", hideTooltip);
  });
}

function renderEmptyState(message) {
  chart.innerHTML = `
    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="transparent"></rect>
    <text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" fill="var(--muted)" font-size="24">${message}</text>
  `;
  hideTooltip();
}

function showTooltip(event) {
  const target = event.currentTarget;
  tooltip.innerHTML = `
    <strong>${target.dataset.weight} kg</strong>
    <span>${target.dataset.date}</span>
    <span>${target.dataset.time}</span>
  `;
  tooltip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  const bounds = chart.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
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
