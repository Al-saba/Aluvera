(function () {
  "use strict";

  var app = null;
  var dbRef = null;
  var records = []; // flattened rows currently displayed
  var cardCharts = {}; // fieldName -> Chart.js instance (small card charts)
  var detailChart = null; // Chart.js instance (full detail view)
  var currentDetailField = null;
  var currentView = "settings";
  var updateCallbacks = []; // registered by the ML tab / future custom code

  var STORAGE_KEY = "plantDashboard.connection";

  var el = {
    apiKey: document.getElementById("apiKey"),
    databaseURL: document.getElementById("databaseURL"),
    projectId: document.getElementById("projectId"),
    dataPath: document.getElementById("dataPath"),
    connectBtn: document.getElementById("connectBtn"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    forgetBtn: document.getElementById("forgetBtn"),
    rememberMe: document.getElementById("rememberMe"),
    limitSelect: document.getElementById("limitSelect"),
    exportBtn: document.getElementById("exportBtn"),
    configError: document.getElementById("configError"),
    connectionDot: document.getElementById("connectionDot"),
    connectionText: document.getElementById("connectionText"),
    recordCount: document.getElementById("recordCount"),
    lastUpdated: document.getElementById("lastUpdated"),
    tableEmpty: document.getElementById("tableEmpty"),
    dataTable: document.getElementById("dataTable"),
    tableHead: document.getElementById("tableHead"),
    tableBody: document.getElementById("tableBody"),
    mainNav: document.getElementById("mainNav"),
    chartGrid: document.getElementById("chartGrid"),
    overviewEmpty: document.getElementById("overviewEmpty"),
    detailTitle: document.getElementById("detailTitle"),
    detailCanvas: document.getElementById("detailCanvas"),
    backBtn: document.getElementById("backBtn"),
  };

  var views = {
    settings: document.getElementById("settingsView"),
    overview: document.getElementById("overviewView"),
    detail: document.getElementById("detailView"),
    data: document.getElementById("dataView"),
    ml: document.getElementById("mlView"),
  };

  // ---------- view switching ----------
  function showView(name) {
    currentView = name;
    Object.keys(views).forEach(function (key) {
      views[key].classList.toggle("hidden", key !== name);
    });
    document.querySelectorAll(".navbtn").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.view === name);
    });
    if (name === "overview") renderOverview();
    if (name === "data") renderTable();
  }

  document.querySelectorAll(".navbtn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      showView(btn.dataset.view);
    });
  });

  el.backBtn.addEventListener("click", function () {
    showView("overview");
  });

  // ---------- settings persistence ----------
  function prefillFromConfig() {
    var cfg = window.firebaseConfig || {};
    if (cfg.apiKey) el.apiKey.value = cfg.apiKey;
    if (cfg.databaseURL) el.databaseURL.value = cfg.databaseURL;
    if (cfg.projectId) el.projectId.value = cfg.projectId;
    if (window.firebaseDataPath) el.dataPath.value = window.firebaseDataPath;
  }

  function saveSettings() {
    var data = {
      apiKey: el.apiKey.value.trim(),
      databaseURL: el.databaseURL.value.trim(),
      projectId: el.projectId.value.trim(),
      dataPath: el.dataPath.value.trim(),
      limit: el.limitSelect.value,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // localStorage may be unavailable (e.g. private browsing) — fail silently.
    }
  }

  function loadSavedSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function forgetSettings() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    showError("Saved settings cleared from this device.");
  }

  function setConnected(isConnected) {
    el.connectionDot.className = "dot " + (isConnected ? "dot-on" : "dot-off");
    el.connectionText.textContent = isConnected ? "Connected" : "Not connected";
    el.connectBtn.disabled = isConnected;
    el.disconnectBtn.disabled = !isConnected;
    el.apiKey.disabled = isConnected;
    el.databaseURL.disabled = isConnected;
    el.projectId.disabled = isConnected;
    el.dataPath.disabled = isConnected;
    el.mainNav.classList.toggle("hidden", !isConnected);
    if (isConnected && currentView === "settings") showView("overview");
    if (!isConnected) showView("settings");
  }

  function showError(message) {
    el.configError.textContent = message || "";
  }

  // ---------- data handling ----------
  function flatten(obj, prefix, out) {
    prefix = prefix || "";
    out = out || {};
    Object.keys(obj || {}).forEach(function (key) {
      var value = obj[key];
      var path = prefix ? prefix + "." + key : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        flatten(value, path, out);
      } else {
        out[path] = Array.isArray(value) ? value.join("; ") : value;
      }
    });
    return out;
  }

  function getSortValue(row) {
    if (row.timestamp !== undefined) return Number(row.timestamp) || row.timestamp;
    return row._key;
  }

  function allColumns() {
    var keySet = {};
    records.forEach(function (row) {
      Object.keys(row).forEach(function (k) {
        if (k !== "_key") keySet[k] = true;
      });
    });
    return Object.keys(keySet).sort(function (a, b) {
      if (a === "timestamp") return -1;
      if (b === "timestamp") return 1;
      return a.localeCompare(b);
    });
  }

  function numericColumns() {
    return allColumns().filter(function (col) {
      if (col === "timestamp") return false;
      return records.some(function (row) {
        var v = row[col];
        return typeof v === "number" && isFinite(v);
      });
    });
  }

  function sortedAscending() {
    return records.slice().sort(function (a, b) {
      var av = getSortValue(a), bv = getSortValue(b);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
  }

  function labelFor(row) {
    if (row.timestamp !== undefined) {
      var n = Number(row.timestamp);
      var d = isFinite(n) ? new Date(n > 2000000000 ? n : n * 1000) : new Date(row.timestamp);
      if (!isNaN(d.getTime())) return d.toLocaleString();
      return String(row.timestamp);
    }
    return row._key;
  }

  // ---------- overview: chart grid ----------
  function renderOverview() {
    var cols = numericColumns();

    el.overviewEmpty.style.display = cols.length ? "none" : "block";
    el.chartGrid.innerHTML = "";
    Object.keys(cardCharts).forEach(function (k) {
      cardCharts[k].destroy();
    });
    cardCharts = {};

    if (cols.length === 0) return;

    var asc = sortedAscending();
    var labels = asc.map(labelFor);

    cols.forEach(function (col) {
      var data = asc.map(function (row) {
        var v = row[col];
        return typeof v === "number" ? v : null;
      });
      var latest = data.length ? data[data.length - 1] : null;

      var card = document.createElement("div");
      card.className = "chart-card";
      card.innerHTML =
        '<h3>' + col + '</h3>' +
        '<p class="latest-value">Latest: ' + (latest === null ? "&mdash;" : latest) + '</p>' +
        '<div class="card-canvas-wrap"><canvas></canvas></div>';
      card.addEventListener("click", function () {
        openDetail(col);
      });
      el.chartGrid.appendChild(card);

      var ctx = card.querySelector("canvas").getContext("2d");
      cardCharts[col] = new Chart(ctx, {
        type: "line",
        data: { labels: labels, datasets: [{ data: data, borderColor: "#2f6f4e", borderWidth: 1.5, pointRadius: 0, tension: 0.2 }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    });
  }

  // ---------- detail: single full chart ----------
  function openDetail(field) {
    currentDetailField = field;
    el.detailTitle.textContent = field;
    showView("detail");

    var asc = sortedAscending();
    var labels = asc.map(labelFor);
    var data = asc.map(function (row) {
      var v = row[field];
      return typeof v === "number" ? v : null;
    });

    if (detailChart) detailChart.destroy();
    var ctx = el.detailCanvas.getContext("2d");
    detailChart = new Chart(ctx, {
      type: "line",
      data: { labels: labels, datasets: [{ label: field, data: data, borderColor: "#2f6f4e", borderWidth: 2, pointRadius: 0, tension: 0.2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, autoSkip: true } },
          y: { beginAtZero: false },
        },
      },
    });
  }

  // ---------- data table view ----------
  function renderTable() {
    if (records.length === 0) {
      el.tableEmpty.style.display = "block";
      el.dataTable.classList.add("hidden");
      return;
    }
    el.tableEmpty.style.display = "none";
    el.dataTable.classList.remove("hidden");

    var columns = allColumns();

    el.tableHead.innerHTML = "";
    columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col;
      el.tableHead.appendChild(th);
    });

    var sortedDesc = records.slice().sort(function (a, b) {
      var av = getSortValue(a), bv = getSortValue(b);
      if (av < bv) return 1;
      if (av > bv) return -1;
      return 0;
    });

    el.tableBody.innerHTML = "";
    sortedDesc.forEach(function (row) {
      var tr = document.createElement("tr");
      columns.forEach(function (col) {
        var td = document.createElement("td");
        var val = row[col];
        td.textContent = val === undefined || val === null ? "" : String(val);
        tr.appendChild(td);
      });
      el.tableBody.appendChild(tr);
    });
  }

  // ---------- top-level render dispatcher ----------
  function render() {
    el.recordCount.textContent = records.length + " record" + (records.length === 1 ? "" : "s");
    el.exportBtn.disabled = records.length === 0;

    if (currentView === "overview") renderOverview();
    if (currentView === "detail" && currentDetailField) openDetail(currentDetailField);
    if (currentView === "data") renderTable();

    updateCallbacks.forEach(function (fn) {
      try { fn(records.slice()); } catch (e) { console.error("PlantDashboard onUpdate callback error:", e); }
    });
  }

  function handleSnapshot(snapshot) {
    var val = snapshot.val();
    records = [];
    if (val) {
      Object.keys(val).forEach(function (key) {
        var flat = flatten(val[key]);
        flat._key = key;
        records.push(flat);
      });
    }
    el.lastUpdated.textContent = "Updated " + new Date().toLocaleTimeString();
    render();
  }

  // ---------- Firebase connection ----------
  function connect() {
    showError("");
    var apiKey = el.apiKey.value.trim();
    var databaseURL = el.databaseURL.value.trim();
    var projectId = el.projectId.value.trim();
    var dataPath = el.dataPath.value.trim() || "plant_data";

    if (!apiKey || !databaseURL) {
      showError("API key and Database URL are required.");
      return;
    }

    try {
      if (dbRef) {
        dbRef.off();
        dbRef = null;
      }
      var config = { apiKey: apiKey, databaseURL: databaseURL, projectId: projectId };
      app = firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
      var db = firebase.database(app);
      var baseRef = db.ref(dataPath);
      var limit = parseInt(el.limitSelect.value, 10);
      dbRef = limit > 0 ? baseRef.limitToLast(limit) : baseRef;

      dbRef.on(
        "value",
        function (snapshot) {
          setConnected(true);
          if (el.rememberMe.checked) saveSettings();
          handleSnapshot(snapshot);
        },
        function (err) {
          showError("Firebase error: " + err.message);
          setConnected(false);
        }
      );
    } catch (err) {
      showError("Could not connect: " + err.message);
      setConnected(false);
    }
  }

  function disconnect() {
    if (dbRef) {
      dbRef.off();
      dbRef = null;
    }
    if (app) {
      app.delete().catch(function () {});
      app = null;
    }
    records = [];
    render();
    setConnected(false);
    el.lastUpdated.textContent = "Never updated";
    showError("");
  }

  function exportCSV() {
    if (records.length === 0) return;
    var columns = allColumns();
    var lines = [columns.join(",")];
    records
      .slice()
      .sort(function (a, b) {
        var av = getSortValue(a), bv = getSortValue(b);
        if (av < bv) return 1;
        if (av > bv) return -1;
        return 0;
      })
      .forEach(function (row) {
        var line = columns.map(function (col) {
          var val = row[col];
          if (val === undefined || val === null) return "";
          var str = String(val).replace(/"/g, '""');
          return /[",\n]/.test(str) ? '"' + str + '"' : str;
        });
        lines.push(line.join(","));
      });

    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "plant_data_export.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- public hook for the ML tab / future custom code ----------
  window.PlantDashboard = {
    getRecords: function () { return records.slice(); },
    onUpdate: function (fn) { if (typeof fn === "function") updateCallbacks.push(fn); },
  };

  // ---------- wire up events ----------
  el.connectBtn.addEventListener("click", connect);
  el.disconnectBtn.addEventListener("click", disconnect);
  el.exportBtn.addEventListener("click", exportCSV);
  el.forgetBtn.addEventListener("click", forgetSettings);
  el.limitSelect.addEventListener("change", function () {
    if (dbRef) connect(); // reconnect with the new limit if already live
  });

  function init() {
    prefillFromConfig();
    var saved = loadSavedSettings();
    if (saved) {
      el.apiKey.value = saved.apiKey || el.apiKey.value;
      el.databaseURL.value = saved.databaseURL || el.databaseURL.value;
      el.projectId.value = saved.projectId || el.projectId.value;
      el.dataPath.value = saved.dataPath || el.dataPath.value;
      el.limitSelect.value = saved.limit || el.limitSelect.value;
      connect(); // auto-connect using the remembered settings
    }
  }

  init();
})();
