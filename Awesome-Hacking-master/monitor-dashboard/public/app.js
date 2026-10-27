const connection = document.querySelector("#connection");
const connectionText = document.querySelector("#connection-text");
const notice = document.querySelector("#notice");
const rows = document.querySelector("#monitor-rows");
const emptyState = document.querySelector("#empty-state");
const tableWrap = document.querySelector("#table-wrap");
const checkButton = document.querySelector("#check-button");

function formatTimestamp(value) {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function addCell(row, content, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = content;
  row.append(cell);
  return cell;
}

function render(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.monitors)) {
    notice.hidden = false;
    notice.textContent = "The status API returned an invalid response.";
    return;
  }

  notice.hidden = true;
  rows.replaceChildren();
  const monitors = snapshot.monitors;
  const upCount = monitors.filter((monitor) => monitor.status === "up").length;
  const downCount = monitors.filter((monitor) => monitor.status === "down").length;

  document.querySelector("#total-count").textContent = String(monitors.length);
  document.querySelector("#up-count").textContent = String(upCount);
  document.querySelector("#down-count").textContent = String(downCount);
  document.querySelector("#last-updated").textContent = formatTimestamp(snapshot.generatedAt);
  emptyState.hidden = monitors.length !== 0;
  tableWrap.hidden = monitors.length === 0;

  for (const monitor of monitors) {
    const row = document.createElement("tr");
    const endpoint = addCell(row, monitor.name, "endpoint-name");
    const detail = document.createElement("span");
    detail.className = "endpoint-target";
    detail.textContent = monitor.target || "";
    endpoint.append(detail);

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge status-${monitor.status}`;
    badge.textContent = monitor.status === "pending"
      ? "Pending"
      : monitor.status === "up"
        ? "Operational"
        : "Unavailable";
    statusCell.append(badge);
    if (monitor.error) {
      const error = document.createElement("span");
      error.className = "status-error";
      error.textContent = monitor.error;
      statusCell.append(error);
    }
    row.append(statusCell);

    const response = monitor.latencyMs === null
      ? "—"
      : `${monitor.latencyMs} ms${monitor.httpStatus ? ` · HTTP ${monitor.httpStatus}` : ""}`;
    addCell(row, response);
    addCell(row, formatTimestamp(monitor.checkedAt), "checked-at");
    rows.append(row);
  }
}

function setConnection(connected) {
  connection.classList.toggle("is-connected", connected);
  connection.classList.toggle("is-disconnected", !connected);
  connectionText.textContent = connected ? "Live updates connected" : "Reconnecting";
}

function connect() {
  const events = new EventSource("/api/events");
  events.addEventListener("snapshot", (event) => {
    try {
      render(JSON.parse(event.data));
      setConnection(true);
    } catch {
      notice.hidden = false;
      notice.textContent = "Could not read a live status update.";
    }
  });
  events.onopen = () => setConnection(true);
  events.onerror = () => setConnection(false);
}

checkButton.addEventListener("click", async () => {
  checkButton.disabled = true;
  checkButton.textContent = "Checking...";
  notice.hidden = true;

  try {
    const response = await fetch("/api/check", { method: "POST" });
    const snapshot = await response.json();
    if (!response.ok) {
      throw new Error(snapshot.error || "Could not complete the monitor check.");
    }
    render(snapshot);
  } catch (error) {
    notice.hidden = false;
    notice.textContent = error instanceof Error ? error.message : "Could not complete the monitor check.";
  } finally {
    checkButton.disabled = false;
    checkButton.textContent = "Check now";
  }
});

connect();
