(function () {
  "use strict";

  var app = null;
  var dbRef = null;
  var records = []; // flattened rows currently displayed

  var el = {
    apiKey: document.getElementById("apiKey"),
    databaseURL: document.getElementById("databaseURL"),
    projectId: document.getElementById("projectId"),
    dataPath: document.getElementById("dataPath"),
    connectBtn: document.getElementById("connectBtn"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    exportBtn: document.getElementById("exportBtn"),
    configError: document.getElementById("configError"),
    connectionDot: document.getElementById("connectionDot"),
    connectionText: document.getElementById("connectionText"),
    recordCount: document.getElementById("recordCount"),
    lastUpdated: document.getElementById("lastUpdated"),
    emptyState: document.getElementById("emptyState"),
    dataTable: document.getElementById("dataTable"),
    tableHead: document.getElementById("tableHead"),
    tableBody: document.getElementById("tableBody"),
  };

  // Prefill form from config.js if values were provided there.
  function prefillFromConfig() {
    var cfg = window.firebaseConfig || {};
    if (cfg.apiKey) el.apiKey.value = cfg.apiKey;
    if (cfg.databaseURL) el.databaseURL.value = cfg.databaseURL;
    if (cfg.projectId) el.projectId.value = cfg.projectId;
    if (window.firebaseDataPath) el.dataPath.value = window.firebaseDataPath;
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
  }

  function showError(message) {
    el.configError.textContent = message || "";
  }

  // Flatten a nested object into dot-notation keys, e.g. { electrical: { voltage: 1 } }
  // becomes { "electrical.voltage": 1 }. Arrays and primitives are kept as-is.
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

  function render() {
    if (records.length === 0) {
      el.emptyState.style.display = "block";
      el.dataTable.classList.add("hidden");
      el.exportBtn.disabled = true;
      el.recordCount.textContent = "0 records";
      return;
    }

    el.emptyState.style.display = "none";
    el.dataTable.classList.remove("hidden");
    el.exportBtn.disabled = false;
    el.recordCount.textContent = records.length + " record" + (records.length === 1 ? "" : "s");

    // Union of all keys across all records, "timestamp" first if present.
    var keySet = {};
    records.forEach(function (row) {
      Object.keys(row).forEach(function (k) {
        if (k !== "_key") keySet[k] = true;
      });
    });
    var columns = Object.keys(keySet).sort(function (a, b) {
      if (a === "timestamp") return -1;
      if (b === "timestamp") return 1;
      return a.localeCompare(b);
    });

    // Header
    el.tableHead.innerHTML = "";
    columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col;
      el.tableHead.appendChild(th);
    });

    // Sort newest first
    var sorted = records.slice().sort(function (a, b) {
      var av = getSortValue(a), bv = getSortValue(b);
      if (av < bv) return 1;
      if (av > bv) return -1;
      return 0;
    });

    // Body
    el.tableBody.innerHTML = "";
    sorted.forEach(function (row) {
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
      var config = { apiKey: apiKey, databaseURL: databaseURL, projectId: projectId };
      app = firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
      var db = firebase.database(app);
      dbRef = db.ref(dataPath);

      dbRef.on(
        "value",
        function (snapshot) {
          setConnected(true);
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

    var keySet = {};
    records.forEach(function (row) {
      Object.keys(row).forEach(function (k) {
        if (k !== "_key") keySet[k] = true;
      });
    });
    var columns = Object.keys(keySet).sort(function (a, b) {
      if (a === "timestamp") return -1;
      if (b === "timestamp") return 1;
      return a.localeCompare(b);
    });

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

  el.connectBtn.addEventListener("click", connect);
  el.disconnectBtn.addEventListener("click", disconnect);
  el.exportBtn.addEventListener("click", exportCSV);

  prefillFromConfig();
  render();
})();
