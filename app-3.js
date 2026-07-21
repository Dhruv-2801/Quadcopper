const state = {
  cows: [],
  cow: "",
  points: [],
  summary: null,
  maxId: 0,
  viewStart: 0,
  viewSpan: 60,
  autoFollow: true,
  admin: false,
  devices: [],
  busyPlate: "",
  tareAllBusy: false,
  dragging: false,
  activeSession: null,
  dragX: 0,
  dragStart: 0,
};

const colors = {
  left: "#6863ff",
  right: "#35c4f4",
  front: "#1fc997",
  back: "#ffb12f",
  grid: "#2d3a4d",
  muted: "#8090aa",
  ink: "#edf3ff",
  panel: "#202c3d",
  panel2: "#172132",
};

const VIEW_MS = 60 * 1000;

// The live window is pinned to wall-clock time (now, and 60s before now), not to the
// server's relative point.t - that value is rebased on every request from a rolling
// session window and drifts between polls, which made the chart's edge jump around.
// point.ts (absolute epoch ms) doesn't have that problem.
function maxViewStart() {
  return Date.now() - VIEW_MS;
}

function minViewStart() {
  return state.points.length ? state.points[0].ts : Date.now();
}

function clampViewStart(ms) {
  const min = minViewStart();
  const max = Math.max(min, maxViewStart());
  return Math.max(min, Math.min(ms, max));
}

function timeOfDay(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

const $ = (id) => document.getElementById(id);
const fmt = (value) => Math.round(value).toLocaleString();
function axisLabel(value, span) {
  if (span < 1) return value.toFixed(3);
  if (span < 10) return value.toFixed(2);
  if (span < 100) return value.toFixed(1);
  return fmt(value);
}
const pct = (value) => `${Math.round(value)}%`;
const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function secondsLabel(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const min = Math.floor(seconds / 60);
  const sec = String(seconds % 60).padStart(2, "0");
  return `${String(min).padStart(2, "0")}:${sec}`;
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawLine(ctx, values, bounds, color, width = 2) {
  if (!values.length) return;
  const { x, y, w, h, minY, maxY, minX, maxX } = bounds;
  ctx.beginPath();
  values.forEach((point, index) => {
    const px = x + ((point.t - minX) / Math.max(maxX - minX, 1)) * w;
    const py = y + h - ((point.v - minY) / Math.max(maxY - minY, 1)) * h;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

function drawPoints(ctx, values, bounds, color) {
  if (!values.length) return;
  const { x, y, w, h, minY, maxY, minX, maxX } = bounds;
  ctx.fillStyle = color;
  values.forEach((point) => {
    if (point.t < minX || point.t > maxX) return;
    const px = x + ((point.t - minX) / Math.max(maxX - minX, 1)) * w;
    const py = y + h - ((point.v - minY) / Math.max(maxY - minY, 1)) * h;
    ctx.beginPath();
    ctx.arc(px, py, 2.6, 0, Math.PI * 2);
    ctx.fill();
  });
}

const SPARK_WINDOW_MS = 8 * 60 * 1000;

function drawSpark(canvas, keys) {
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  // Anchored to wall-clock now (like the main chart), not point.t - that value is rebased
  // on every request from a rolling session window and drifts between polls, which
  // corrupted this line's ordering the same way it did on the main chart.
  const viewEnd = Date.now();
  const viewStart = viewEnd - SPARK_WINDOW_MS;
  const points = state.points.filter((point) => point.ts >= viewStart && point.ts <= viewEnd);
  if (!points.length) return;
  const series = keys.map((key) => points.map((point) => ({ t: point.ts, v: key(point) })));
  const allValues = series.flat().map((point) => point.v);
  const minY = Math.min(...allValues) * 0.98;
  const maxY = Math.max(...allValues) * 1.02;
  const bounds = {
    x: 2,
    y: 8,
    w: width - 4,
    h: height - 16,
    minY,
    maxY,
    minX: viewStart,
    maxX: viewEnd,
  };
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, width, height);
  series.forEach((line, index) => drawLine(ctx, line, bounds, index ? colors.right : colors.left, 1.8));
}

function drawMainChart() {
  const canvas = $("mainChart");
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 58, right: 18, top: 18, bottom: 38 };
  const plot = {
    x: pad.left,
    y: pad.top,
    w: width - pad.left - pad.right,
    h: height - pad.top - pad.bottom,
  };

  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, width, height);

  if (state.autoFollow) {
    state.viewStart = maxViewStart();
  } else {
    state.viewStart = clampViewStart(state.viewStart);
  }
  const viewEnd = state.viewStart + VIEW_MS;
  const visible = state.points.filter((point) => point.ts >= state.viewStart && point.ts <= viewEnd);
  const source = visible.length ? visible : state.points;
  const all = source.flatMap((point) => [point.left, point.right, point.front, point.back]);
  const minY = all.length ? Math.min(...all) * 0.96 : 0;
  const maxY = all.length ? Math.max(...all) * 1.04 : 100;

  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = colors.muted;
  ctx.font = "12px Aptos, Segoe UI, sans-serif";

  const ySpan = maxY - minY;
  for (let i = 0; i <= 5; i += 1) {
    const y = plot.y + (plot.h / 5) * i;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    const value = maxY - (ySpan / 5) * i;
    ctx.fillText(axisLabel(value, ySpan), 8, y + 4);
  }

  for (let ms = 0; ms <= VIEW_MS; ms += 15000) {
    const x = plot.x + (ms / VIEW_MS) * plot.w;
    ctx.fillText(timeOfDay(state.viewStart + ms), x - 24, height - 12);
  }

  const bounds = { ...plot, minY, maxY, minX: state.viewStart, maxX: viewEnd };
  const leftLine = visible.map((p) => ({ t: p.ts, v: p.left }));
  const rightLine = visible.map((p) => ({ t: p.ts, v: p.right }));
  const frontLine = visible.map((p) => ({ t: p.ts, v: p.front }));
  const backLine = visible.map((p) => ({ t: p.ts, v: p.back }));
  drawLine(ctx, leftLine, bounds, colors.left, 2.4);
  drawLine(ctx, rightLine, bounds, colors.right, 2.4);
  drawLine(ctx, frontLine, bounds, colors.front, 1.8);
  drawLine(ctx, backLine, bounds, colors.back, 1.8);
  if (visible.length < 90) {
    drawPoints(ctx, leftLine, bounds, colors.left);
    drawPoints(ctx, rightLine, bounds, colors.right);
    drawPoints(ctx, frontLine, bounds, colors.front);
    drawPoints(ctx, backLine, bounds, colors.back);
  }

  if (!visible.length) {
    ctx.fillStyle = colors.muted;
    ctx.font = "13px Aptos, Segoe UI, sans-serif";
    ctx.fillText("Waiting for readings in this time window", plot.x + 16, plot.y + 28);
  }

  if (state.autoFollow) {
    ctx.fillStyle = colors.front;
    ctx.font = "12px Aptos, Segoe UI, sans-serif";
    ctx.fillText("live", plot.x + plot.w - 28, plot.y + 18);
  }

  ctx.strokeStyle = "#344258";
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
}

function drawBalanceChart(summary) {
  const canvas = $("balanceChart");
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, width, height);

  const groups = [
    { label: "Left", value: summary.leftAvg || 0, color: colors.left },
    { label: "Right", value: summary.rightAvg || 0, color: colors.right },
    { label: "Front", value: summary.frontAvg || 0, color: colors.front },
    { label: "Back", value: summary.backAvg || 0, color: colors.back },
  ];
  const pad = { left: 42, right: 18, top: 20, bottom: 34 };
  const plot = { x: pad.left, y: pad.top, w: width - pad.left - pad.right, h: height - pad.top - pad.bottom };
  const max = Math.max(1, ...groups.map((item) => item.value)) * 1.12;

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.muted;
  ctx.font = "12px Aptos, Segoe UI, sans-serif";
  for (let i = 0; i <= 4; i += 1) {
    const y = plot.y + (plot.h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillText(fmt(max - (max / 4) * i), 3, y + 4);
  }

  const barW = Math.min(42, plot.w / 7);
  groups.forEach((item, index) => {
    const x = plot.x + (plot.w / groups.length) * index + (plot.w / groups.length - barW) / 2;
    const h = (item.value / max) * plot.h;
    const y = plot.y + plot.h - h;
    ctx.fillStyle = item.color;
    ctx.fillRect(x, y, barW, h);
    ctx.fillStyle = colors.muted;
    ctx.textAlign = "center";
    ctx.fillText(item.label, x + barW / 2, height - 10);
  });
  ctx.textAlign = "left";
}

function drawLoadDonut(summary) {
  const canvas = $("loadDonut");
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, width, height);

  const front = summary.frontAvg || 0;
  const back = summary.backAvg || 0;
  const total = Math.max(front + back, 1);
  const frontShare = front / total;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.34;
  const lineWidth = Math.max(16, radius * 0.28);
  const start = -Math.PI / 2;

  ctx.lineWidth = lineWidth;
  ctx.lineCap = "butt";
  ctx.strokeStyle = "#111a2a";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = colors.front;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, start + Math.PI * 2 * frontShare);
  ctx.stroke();

  ctx.strokeStyle = colors.back;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start + Math.PI * 2 * frontShare, start + Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = colors.ink;
  ctx.font = "700 25px Aptos, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(frontShare * 100)}%`, cx, cy + 4);
  ctx.fillStyle = colors.muted;
  ctx.font = "12px Aptos, Segoe UI, sans-serif";
  ctx.fillText("front load", cx, cy + 25);
  ctx.textAlign = "left";
}

function renderLegs(summary) {
  const labels = {
    frontLeft: "Front left",
    frontRight: "Front right",
    backLeft: "Back left",
    backRight: "Back right",
  };
  const entries = Object.entries(summary.legAverages || {});
  const max = Math.max(1, ...entries.map(([, value]) => value));
  $("legs").innerHTML = entries
    .map(([key, value]) => `
      <div class="leg-row">
        <span>${labels[key]}</span>
        <div class="bar"><span style="width:${Math.max(4, (value / max) * 100)}%"></span></div>
        <strong>${fmt(value)} lb</strong>
      </div>
    `)
    .join("");
}

function getLatestPlateReadings() {
  const last = state.points[state.points.length - 1];
  if (!last) return [];
  return Object.entries(last.plates || {})
    .map(([plate, value]) => ({ plate, value }))
    .sort((a, b) => a.plate.localeCompare(b.plate));
}

function renderPlateChannels() {
  const plateConfig = [
    { code: "fli", aliases: ["fli"], label: "FL inner" },
    { code: "flo", aliases: ["flo"], label: "FL outer" },
    { code: "fri", aliases: ["fri"], label: "FR inner" },
    { code: "fro", aliases: ["fro"], label: "FR outer" },
    { code: "bli", aliases: ["bli", "hli"], label: "BL inner" },
    { code: "blo", aliases: ["blo", "hlo"], label: "BL outer" },
    { code: "bri", aliases: ["bri", "hri"], label: "BR inner" },
    { code: "bro", aliases: ["bro", "hro"], label: "BR outer" },
  ];

  const latest = new Map(
    getLatestPlateReadings().map(({ plate, value }) => [
      String(plate).split("_").at(-1).toLowerCase(),
      value,
    ])
  );

  const rowHtml = ({ code, aliases, label }) => {
    const matchedAlias = aliases.find((alias) => latest.has(alias));
    const value = matchedAlias ? latest.get(matchedAlias) : 0;
    return `
      <div class="plate-row">
        <span>${label} <small>(${code})</small></span>
        <strong>${fmt(value)} lb</strong>
      </div>
    `;
  };

  $("plateGridOne").innerHTML = plateConfig.slice(0, 4).map(rowHtml).join("");
  $("plateGridTwo").innerHTML = plateConfig.slice(4, 8).map(rowHtml).join("");
}

function renderSummary(summary) {
  // $("lameScore").textContent = summary.lameScore;
  // $("scoreStatus").textContent = summary.status;
  $("totalAvg").textContent = fmt(summary.totalCurrent);
  // $("leftAvg").textContent = fmt(summary.leftAvg);
  // $("rightAvg").textContent = fmt(summary.rightAvg);
  // $("frontAvg").textContent = fmt(summary.frontAvg);
  // $("backAvg").textContent = fmt(summary.backAvg);
  // $("lrDelta").textContent = pct(summary.lrDeltaPct || 0);
  // $("fbDelta").textContent = pct(summary.fbDeltaPct || 0);
  // const total = Math.max((summary.frontAvg || 0) + (summary.backAvg || 0), 1);
  // $("frontShare").textContent = pct(((summary.frontAvg || 0) / total) * 100);
  // $("backShare").textContent = pct(((summary.backAvg || 0) / total) * 100);
  renderLegs(summary);
  renderPlateChannels();
}

function renderMeta() {
  const cow = state.cows.find((item) => item.id === state.cow);
  if (!cow) return;
  $("selectedCow").textContent = cow.label;
  $("sessionMeta").textContent = `${cow.rfid} | ${cow.sampleCount.toLocaleString()} plate samples | ${secondsLabel(cow.durationSec)} captured`;
  renderActiveSession();
}

function renderActiveSession() {
  const pill = $("sessionState");
  const label = $("activeCowId");
  if (!pill || !label) return;

  const session = state.activeSession;
  const active = Boolean(session && session.cow_id != null && session.stop_time == null);
  pill.classList.toggle("active", active);
  label.textContent = active ? `Tracking Cow ${session.cow_id}` : "Waiting for cow";

  if (active) {
    $("selectedCow").textContent = `Cow-${session.cow_id}`;
    const started = new Date(session.start_time).toLocaleTimeString([], { hour12: false });
    $("sessionMeta").textContent = `Automatically started at ${started} | live session`;
  } else {
    $("selectedCow").textContent = "No active cow";
    $("sessionMeta").textContent = "Waiting for the next cow to step onto the plates";
  }
}

async function loadActiveSession() {
  try {
    const data = await fetchJson("/api/session/active");
    state.activeSession = data.session || null;
  } catch (error) {
    state.activeSession = null;
  }
  renderActiveSession();
}

function setAdminMessage(message, isError = false) {
  const el = $("adminMessage");
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? "#ff9bad" : "#8090aa";
}

function renderAdmin() {
  const login = $("adminLogin");
  const tools = $("adminTools");
  const adminOnly = document.querySelectorAll(".admin-only");
  if (login) login.hidden = state.admin;
  if (tools) tools.hidden = !state.admin;
  adminOnly.forEach((el) => {
    el.hidden = !state.admin;
  });
  if (state.admin && $("adminName")) $("adminName").textContent = "Admin logged in";
}

async function loadAdminStatus() {
  try {
    const data = await fetchJson("/api/admin/status");
    state.admin = Boolean(data.admin);
    renderAdmin();
  } catch (error) {
    state.admin = false;
    renderAdmin();
  }
}

async function loginAdmin(event) {
  event.preventDefault();
  try {
    await postJson("/api/admin/login", {
      username: $("adminUser").value,
      password: $("adminPass").value,
    });
    state.admin = true;
    $("adminPass").value = "";
    setAdminMessage("");
    renderAdmin();
  } catch (error) {
    setAdminMessage("Invalid login", true);
  }
}

async function logoutAdmin() {
  await postJson("/api/admin/logout");
  state.admin = false;
  renderAdmin();
}

function showNotice(message, isError = false) {
  $("dbStatus").textContent = message;
  $("dbStatus").style.color = isError ? "#ff9bad" : "";
}

function downloadDatabase() {
  window.location.href = "/api/admin/download";
}

function showPage(page) {
  document.querySelectorAll(".page[data-page]").forEach((section) => {
    section.hidden = section.dataset.page !== page;
  });
  document.querySelectorAll("nav a[data-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === page);
  });
}

function renderDevices(devices) {
  const container = $("deviceList");
  if (!container) return;
  if (!devices.length) {
    container.innerHTML = `<p>No devices connected.</p>`;
    return;
  }
  container.innerHTML = devices
    .map((item) => {
      const online = item.state === "connected";
      const sinceTs = online ? item.connectedSince : item.disconnectedAt;
      const sinceLabel = sinceTs
        ? `${online ? "connected" : "disconnected"} ${Math.round((Date.now() - sinceTs) / 1000)}s ago`
        : "";
      const weightLabel = item.weightLbs == null ? "-" : `${fmt(item.weightLbs)} lb`;
      const plateLabel = item.plate || "(no plate recognized yet)";
      const busy = state.busyPlate === item.plate;
      const tareDisabled = !item.plate || (state.busyPlate && !busy) || state.tareAllBusy;
      return `
        <div class="device-row">
          <span class="dot ${online ? "online" : "offline"}" title="${online ? "connected" : "disconnected"}"></span>
          <div>
            <strong>${esc(plateLabel)}</strong>
            <small>${esc(item.port)}${item.conflict ? " - WARNING duplicate plate id" : ""}</small>
          </div>
          <span>${weightLabel}</span>
          <span>${esc(sinceLabel)}</span>
          <button type="button" data-action="tare-plate" data-plate="${esc(item.plate || "")}" ${tareDisabled ? "disabled" : ""}>${busy ? "Working" : "Tare"}</button>
        </div>
      `;
    })
    .join("");
}

async function loadDevices() {
  try {
    const data = await fetchJson("/api/devices");
    state.devices = data.devices || [];
    renderDevices(state.devices);
  } catch (error) {
    console.error(error);
  }
}

async function tarePlate(plate) {
  if (!plate || state.busyPlate || state.tareAllBusy) return;
  state.busyPlate = plate;
  renderDevices(state.devices);
  try {
    await postJson("/api/admin/tare-plate", { plate });
    showNotice(`Tare applied: ${plate}`);
    await loadDevices();
  } catch (error) {
    showNotice(`Tare failed: ${error.message}`, true);
  } finally {
    state.busyPlate = "";
    renderDevices(state.devices);
  }
}

async function tareAllDevices() {
  if (state.tareAllBusy || state.busyPlate) return;
  const plates = state.devices.map((item) => item.plate).filter(Boolean);
  if (!plates.length) return;
  state.tareAllBusy = true;
  renderDevices(state.devices);
  try {
    for (const plate of plates) {
      try {
        await postJson("/api/admin/tare-plate", { plate });
      } catch (error) {
        console.error(`Tare failed for ${plate}: ${error.message}`);
      }
    }
    showNotice(`Tared ${plates.length} plate(s)`);
    await loadDevices();
  } finally {
    state.tareAllBusy = false;
    renderDevices(state.devices);
  }
}

function renderRejects(rejects) {
  const container = $("rejectList");
  if (!container) return;
  if (!rejects.length) {
    container.innerHTML = `<p>No unrecognized plate IDs detected.</p>`;
    return;
  }
  container.innerHTML = rejects
    .map((item) => `
      <div class="reject-row">
        <span>${esc(new Date(item.ts_utc_ms).toLocaleTimeString())}</span>
        <div>
          <strong>${esc(item.device_id)}</strong>
          <small>${esc(item.reason)} - source: ${esc(item.source)}</small>
        </div>
      </div>
    `)
    .join("");
}

async function loadRejects() {
  try {
    const data = await fetchJson("/api/rejects?limit=50");
    renderRejects(data.rejects || []);
  } catch (error) {
    console.error(error);
  }
}

function renderAll(summary) {
  state.summary = summary;
  renderMeta();
  renderSummary(summary);
  // drawSpark($("scoreSpark"), [(point) => Math.abs(point.left - point.right)]);
  drawSpark($("totalSpark"), [(point) => point.total]);
  // drawSpark($("lrSpark"), [(point) => point.left, (point) => point.right]);
  // drawSpark($("fbSpark"), [(point) => point.front, (point) => point.back]);
  drawMainChart();
  // drawBalanceChart(summary);
  // drawLoadDonut(summary);
}

async function loadCows() {
  const data = await fetchJson("/api/cows");
  const currentCow = state.cow;
  state.cows = data.cows;
  const select = $("cowSelect");
  select.innerHTML = state.cows.map((cow) => `<option value="${esc(cow.id)}">${esc(cow.label)} (${esc(cow.rfid)})</option>`).join("");
  state.cow = state.cows.some((cow) => cow.id === currentCow) ? currentCow : state.cows[0]?.id || "";
  select.value = state.cow;
  renderMeta();
}

async function loadSeries() {
  if (!state.cow) return;
  const data = await fetchJson(`/api/series?cow=${encodeURIComponent(state.cow)}`);
  state.points = data.points;
  state.maxId = data.maxId;
  state.autoFollow = true;
  renderAll(data.summary);
}

async function pollLatest() {
  if (!state.cow) return;
  try {
    const data = await fetchJson(`/api/latest?cow=${encodeURIComponent(state.cow)}&after=${state.maxId}`);
    if (data.points.length) {
      const nearLiveEdge = state.viewStart >= maxViewStart() - 3000;
      if (nearLiveEdge) state.autoFollow = true;
      state.points.push(...data.points);
      state.points.sort((a, b) => a.ts - b.ts);
      state.maxId = Math.max(state.maxId, data.maxId);
      renderAll(data.summary);
    }
    $("dbStatus").textContent = "Connected";
  } catch (error) {
    $("dbStatus").textContent = "Offline";
    console.error(error);
  }
}

function setupChartInteraction() {
  const canvas = $("mainChart");
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    state.autoFollow = false;
    state.viewStart += (event.deltaY || event.deltaX) * 80;
    state.viewStart = clampViewStart(state.viewStart);
    drawMainChart();
  }, { passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    state.autoFollow = false;
    state.dragging = true;
    state.dragX = event.clientX;
    state.dragStart = state.viewStart;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    const rect = canvas.getBoundingClientRect();
    const delta = ((state.dragX - event.clientX) / Math.max(rect.width, 1)) * VIEW_MS;
    state.viewStart = clampViewStart(state.dragStart + delta);
    drawMainChart();
  });

  canvas.addEventListener("pointerup", () => {
    state.dragging = false;
  });
  canvas.addEventListener("pointercancel", () => {
    state.dragging = false;
  });
}

async function init() {
  setupChartInteraction();

  const sidebar = document.querySelector(".sidebar");
  const menuToggle = $("menuToggle");
  const closeMenu = () => {
    sidebar?.classList.remove("open");
    menuToggle?.setAttribute("aria-expanded", "false");
  };

  menuToggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = sidebar?.classList.toggle("open") || false;
    menuToggle.setAttribute("aria-expanded", String(isOpen));
    setTimeout(() => {
      if (state.summary) renderAll(state.summary);
    }, 190);
  });

  document.addEventListener("click", (event) => {
    if (sidebar?.classList.contains("open") && !sidebar.contains(event.target)) {
      closeMenu();
    }
  });
  document.querySelectorAll("nav a[data-page]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showPage(link.dataset.page);
      closeMenu();
    });
  });
  $("adminLogin")?.addEventListener("submit", loginAdmin);
  $("adminLogout")?.addEventListener("click", logoutAdmin);
  $("downloadDb")?.addEventListener("click", downloadDatabase);
  $("deviceList")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='tare-plate']");
    if (!button) return;
    tarePlate(button.dataset.plate);
  });
  $("tareAll")?.addEventListener("click", tareAllDevices);
  $("cowSelect").addEventListener("change", async (event) => {
    state.cow = event.target.value;
    await loadSeries();
  });
  window.addEventListener("resize", () => {
    if (state.summary) renderAll(state.summary);
  });

  try {
    await loadAdminStatus();
    await loadActiveSession();
    await loadCows();
    await loadSeries();
    await loadDevices();
    await loadRejects();
    $("dbStatus").textContent = "Connected";
    setInterval(pollLatest, 1800);
    setInterval(loadActiveSession, 1000);
    setInterval(loadCows, 6000);
    setInterval(loadDevices, 6000);
    setInterval(loadRejects, 6000);
  } catch (error) {
    $("dbStatus").textContent = "Offline";
    console.error(error);
  }
}

init();
