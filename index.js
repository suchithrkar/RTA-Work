const performanceInput = document.getElementById("performanceInput");
const statusInput = document.getElementById("statusInput");
const processBtn = document.getElementById("processBtn");

let performanceFile = null;
let statusFile = null;

const DB_NAME = "RTA_WORK_DB";
const STORE_NAME = "rta_table";
let db;
let onLeaveAgents = new Set();
let fullDataset = [];

/* ===========================
   IndexedDB Setup
========================= */

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = e => {
      const db = e.target.result;
      db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };

    request.onsuccess = e => {
      db = e.target.result;
      resolve();
    };

    request.onerror = reject;
  });
}

function saveToDB(rows) {
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put({
    id: "agentPerformanceTable",
    fullRows: rows,   // 🔥 store full dataset
    onLeave: [...onLeaveAgents],
    lastUpdated: new Date().toISOString()
  });
}

function loadFromDB() {
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get("agentPerformanceTable");

    req.onsuccess = () => {
      if (req.result) {
        onLeaveAgents = new Set(req.result.onLeave || []);
        fullDataset = req.result.fullRows || [];
        resolve(fullDataset);
      } else {
        resolve(null);
      }
    };
  });
}

/* =========================
   File Validation
========================= */

performanceInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file || !file.name.includes("Agent Performance Summary")) {
    alert("Invalid Performance file.");
    e.target.value = "";
    return;
  }
  performanceFile = file;
  updateButton();
});

statusInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file || !file.name.includes("Agent Status Summary")) {
    alert("Invalid Status file.");
    e.target.value = "";
    return;
  }
  statusFile = file;
  updateButton();
});

function updateButton() {
  processBtn.disabled = !(performanceFile && statusFile);
}

/* =========================
   Time Utilities
========================= */

function timeToSeconds(value) {
  if (!value && value !== 0) return 0;

  // If already number
  if (typeof value === "number") {

    // Excel time fraction (less than 1 day)
    if (value < 1) {
      return Math.round(value * 86400);
    }

    // Already seconds (large integer)
    return Math.round(value);
  }

  // If string like HH:MM:SS
  if (typeof value === "string" && value.includes(":")) {
    const parts = value.split(":").map(Number);
    return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
  }

  // If numeric string
  if (!isNaN(value)) {
    const num = Number(value);

    if (num < 1) {
      return Math.round(num * 86400);
    }

    return Math.round(num);
  }

  return 0;
}

function secondsToHHMMSS(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/* =========================
   CSV Parsing
========================= */

function parseCSV(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const workbook = XLSX.read(e.target.result, { type: "string" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
      resolve(rows);
    };
    reader.readAsText(file);
  });
}

/* =========================
   Processing Logic
========================= */

processBtn.addEventListener("click", async () => {

  const perfRows = await parseCSV(performanceFile);
  const statusRows = await parseCSV(statusFile);

  const perfHeaders = perfRows[0];
  const statusHeaders = statusRows[0];

  const perfMap = {};
  const statusMap = {};

  function getIndex(headers, name) {
    return headers.findIndex(h => h?.toString().trim() === name);
  }

  const perfIdx = {
    agent: getIndex(perfHeaders, "Agent Name"),
    answered: getIndex(perfHeaders, "Answered"),
    outbound: getIndex(perfHeaders, "Outbound"),
    handle: getIndex(perfHeaders, "Handle"),
    alert: getIndex(perfHeaders, "Alert - No Answer"),
    totalHandle: getIndex(perfHeaders, "Total Handle"),
    totalTalk: getIndex(perfHeaders, "Total Talk"),
    totalHold: getIndex(perfHeaders, "Total Hold"),
    totalACW: getIndex(perfHeaders, "Total ACW")
  };

  const statusIdx = {
    agent: getIndex(statusHeaders, "Agent Name"),
    loggedIn: getIndex(statusHeaders, "Logged In"),
    idle: getIndex(statusHeaders, "Idle"),
    busy: getIndex(statusHeaders, "Busy"),
    away: getIndex(statusHeaders, "Away"),
    break: getIndex(statusHeaders, "Break"),
    meal: getIndex(statusHeaders, "Meal"),
    meeting: getIndex(statusHeaders, "Meeting"),
    training: getIndex(statusHeaders, "Training"),
    mentoring: getIndex(statusHeaders, "Busy: Mentoring / Coaching")
  };

  perfRows.slice(1).forEach(r => {
    const name = r[perfIdx.agent];
    if (!name) return;
    perfMap[name] = r;
  });

  statusRows.slice(1).forEach(r => {
    const name = r[statusIdx.agent];
    if (!name) return;
    statusMap[name] = r;
  });

  const agents = new Set([...Object.keys(perfMap), ...Object.keys(statusMap)]);
  const finalRows = [];

  agents.forEach(agent => {
    const p = perfMap[agent] || [];
    const s = statusMap[agent] || [];

    const away = timeToSeconds(s[statusIdx.away]);
    const brk = timeToSeconds(s[statusIdx.break]);
    const meal = timeToSeconds(s[statusIdx.meal]);

    const totalBreak = away + brk + meal;
    const exceededBreak = Math.max(0, totalBreak - 4200);

    const totalTalk = timeToSeconds(p[perfIdx.totalTalk]);
    const idle = timeToSeconds(s[statusIdx.idle]);
    const training = timeToSeconds(s[statusIdx.training]);
    const meeting = timeToSeconds(s[statusIdx.meeting]);
    const dispatch = timeToSeconds(s[statusIdx.busy]);
    const mentoring = timeToSeconds(s[statusIdx.mentoring]);

    const productive =
      totalTalk +
      totalBreak +
      idle +
      training +
      meeting +
      dispatch +
      mentoring -
      exceededBreak;

    const loggedIn = timeToSeconds(s[statusIdx.loggedIn]);
    const nonProductive = Math.max(0, loggedIn - productive);

    finalRows.push([
      agent,
      p[perfIdx.answered] || 0,
      p[perfIdx.outbound] || 0,
      p[perfIdx.handle] || 0,
      p[perfIdx.alert] || 0,
      secondsToHHMMSS(nonProductive),
      secondsToHHMMSS(loggedIn),
      secondsToHHMMSS(totalBreak),
      secondsToHHMMSS(exceededBreak),
      secondsToHHMMSS(idle),
      secondsToHHMMSS(timeToSeconds(p[perfIdx.totalHandle])),
      secondsToHHMMSS(totalTalk),
      secondsToHHMMSS(timeToSeconds(p[perfIdx.totalHold])),
      secondsToHHMMSS(timeToSeconds(p[perfIdx.totalACW])),
      secondsToHHMMSS(away),
      secondsToHHMMSS(brk),
      secondsToHHMMSS(meal),
      secondsToHHMMSS(training),
      secondsToHHMMSS(meeting),
      secondsToHHMMSS(mentoring),
      secondsToHHMMSS(dispatch),
      secondsToHHMMSS(productive)
    ]);
  });

   // Sort by Non Productive (column index 5) descending
   finalRows.sort((a, b) => {
     const toSec = str => {
       const parts = str.split(":").map(Number);
       return parts[0]*3600 + parts[1]*60 + parts[2];
     };
     return toSec(b[5]) - toSec(a[5]);
   });

   fullDataset = finalRows;
   
   // Render with leave filtering applied
   renderWithLeaveFilter();
   
   // Save FULL dataset
   saveToDB(fullDataset);
});

/* =========================
   Render Table
========================= */

function renderWithLeaveFilter() {
  const filtered = fullDataset.filter(row => 
    !onLeaveAgents.has(row[0])
  );

  renderTable(filtered);
}

function renderTable(rows) {
  const thead = document.querySelector("#resultTable thead");
  const tbody = document.querySelector("#resultTable tbody");

  thead.innerHTML = "";
  tbody.innerHTML = "";

  const headers = [
    "Agent Name","Answered","Outbound","Handle","Alert - No Answer",
    "Non Productive","Logged In","Total Break","Exceeded Break",
    "Idle","Total Handle","Total Talk","Total Hold","Total ACW",
    "Away","Break","Meal","Training","Meeting",
    "Mentoring","Dispatch","Productive"
  ];

  const tr = document.createElement("tr");
  headers.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    tr.appendChild(th);
  });
  thead.appendChild(tr);

  rows.forEach(r => {
    const row = document.createElement("tr");
    r.forEach(c => {
      const td = document.createElement("td");
      td.textContent = c;
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
}

document.getElementById("onLeaveBtn").onclick = () => {
  buildLeaveDropdown();
  updateLeaveSelectedUI();   // ensure selected always shown
  document.getElementById("onLeaveModal").style.display = "flex";
};

document.getElementById("closeLeaveBtn").onclick = () => {
  document.getElementById("onLeaveModal").style.display = "none";
};

document.getElementById("leaveToggle").onclick = (e) => {
  e.stopPropagation();
  const box = document.getElementById("leaveBox");
  box.style.display = box.style.display === "block" ? "none" : "block";
};

document.addEventListener("click", (e) => {
  const box = document.getElementById("leaveBox");
  const toggle = document.getElementById("leaveToggle");

  // If click is outside dropdown and outside toggle
  if (!box.contains(e.target) && !toggle.contains(e.target)) {
    box.style.display = "none";
  }
});

function updateLeaveSelectedUI() {
  const selectedDiv = document.getElementById("leaveSelected");
  selectedDiv.innerHTML = "";

  [...onLeaveAgents]
    .sort((a, b) => a.localeCompare(b))
    .forEach(name => {
      const div = document.createElement("div");
      div.textContent = "– " + name;
      selectedDiv.appendChild(div);
    });
}

function buildLeaveDropdown() {
  const box = document.getElementById("leaveBox");
  const selectedDiv = document.getElementById("leaveSelected");

  box.innerHTML = "";
  selectedDiv.innerHTML = "";

   // Build agent list from full dataset (not DOM)
   const agents = [...new Set(fullDataset.map(row => row[0]))];
   
   // Sort alphabetically
   agents.sort((a, b) => a.localeCompare(b));

  agents.forEach(name => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = name;
    cb.checked = onLeaveAgents.has(name);

   cb.onchange = (e) => {
     e.stopPropagation();
     if (cb.checked) {
       onLeaveAgents.add(name);
     } else {
       onLeaveAgents.delete(name);
     }
   
     updateLeaveSelectedUI();
   };

    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    box.appendChild(label);
  });

  updateLeaveSelectedUI();
}

document.getElementById("saveLeaveBtn").onclick = () => {

  document.getElementById("onLeaveModal").style.display = "none";

  // Re-render using filter only (non-destructive)
  renderWithLeaveFilter();

  // Save leave list + full dataset (not filtered)
  saveToDB(fullDataset);
};

document.getElementById("clearLeaveBtn").onclick = () => {

  // Clear state
  onLeaveAgents.clear();

  // Uncheck all checkboxes visually
  const checkboxes = document.querySelectorAll("#leaveBox input[type='checkbox']");
  checkboxes.forEach(cb => cb.checked = false);

  // Update selected UI
  updateLeaveSelectedUI();
};

/* =========================
   Init
========================= */

document.addEventListener("DOMContentLoaded", async () => {
  await openDB();
  const stored = await loadFromDB();
  if (stored) renderWithLeaveFilter();
});













