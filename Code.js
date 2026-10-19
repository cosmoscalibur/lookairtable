// Community Looker Studio connector for AirTable

var cc = DataStudioApp.createCommunityConnector();

var API_BASE_URL = "https://api.airtable.com/v0";
var TOKEN_PROPERTY = "airtable.token";
var CACHE_TTL_SECONDS = 300;
var MAX_RETRIES = 3;
var PAGE_SIZE = 100;
// Cache values are limited to 100KB of UTF-8; 30000 chars is at most 90KB.
var ROWS_CHUNK_CHARS = 30000;
var ROWS_MAX_CHUNKS = 100;
var LOCK_WAIT_MS = 30000;
// Apps Script kills executions after 6 minutes; fail with a clear error before.
var EXEC_BUDGET_MS = 5 * 60 * 1000;
var EXEC_STARTED = Date.now();
var cachedToken;

// ---------------------------------------------------------------------------
// Authentication (Airtable Personal Access Token stored per user)
// ---------------------------------------------------------------------------

function isAdminUser() {
  return false;
}

function getAuthType() {
  return cc
    .newAuthTypeResponse()
    .setAuthType(cc.AuthType.KEY)
    .setHelpUrl("https://airtable.com/create/tokens")
    .build();
}

function getStoredToken() {
  if (cachedToken === undefined) {
    cachedToken = PropertiesService.getUserProperties().getProperty(TOKEN_PROPERTY);
  }
  return cachedToken;
}

function isAuthValid() {
  return !!getStoredToken();
}

function setCredentials(request) {
  var token = String(request.key || "").trim();
  if (!token || !validateToken(token)) {
    return { errorCode: "INVALID_CREDENTIALS" };
  }
  PropertiesService.getUserProperties().setProperty(TOKEN_PROPERTY, token);
  cachedToken = token;
  return { errorCode: "NONE" };
}

function resetAuth() {
  PropertiesService.getUserProperties().deleteProperty(TOKEN_PROPERTY);
  cachedToken = null;
}

function validateToken(token) {
  var response = UrlFetchApp.fetch(API_BASE_URL + "/meta/whoami", {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true,
  });
  return response.getResponseCode() === 200;
}

// ---------------------------------------------------------------------------
// Airtable API helpers
// ---------------------------------------------------------------------------

function airtableFetch(path, payload) {
  var options = {
    method: payload ? "post" : "get",
    headers: { Authorization: "Bearer " + getStoredToken() },
    muteHttpExceptions: true,
  };
  if (payload) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }

  for (var attempt = 0; ; attempt++) {
    var response;
    try {
      response = UrlFetchApp.fetch(API_BASE_URL + path, options);
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        waitOrFail(1000 * Math.pow(2, attempt), path);
        continue;
      }
      throwUserError("Could not reach the Airtable API.", e.toString());
    }
    var code = response.getResponseCode();
    if (code === 200) {
      try {
        return JSON.parse(response.getContentText());
      } catch (e) {
        throwUserError("Airtable returned an invalid response.", e.toString());
      }
    }
    if ((code === 429 || code >= 500) && attempt < MAX_RETRIES) {
      // Airtable blocks for 30 seconds after exceeding the rate limit.
      waitOrFail(code === 429 ? 30000 : 1000 * Math.pow(2, attempt), path);
      continue;
    }
    throwAirtableError(code, response.getContentText(), path);
  }
}

function failIfOverBudget(extraMs, path) {
  if (Date.now() - EXEC_STARTED + extraMs > EXEC_BUDGET_MS) {
    throwUserError(
      "Airtable is taking too long to respond (rate limiting or a table that is too large). Try again shortly, or use a view with fewer records.",
      "Execution time budget exhausted on " + path,
    );
  }
}

function waitOrFail(ms, path) {
  failIfOverBudget(ms, path);
  Utilities.sleep(ms);
}

function throwAirtableError(code, body, path) {
  var detail = body;
  try {
    var error = JSON.parse(body).error;
    detail = typeof error === "string" ? error : error.type + ": " + error.message;
  } catch (e) {
    // Keep the raw body as detail.
  }

  var text;
  if (code === 401) {
    // Drop the revoked token so Looker Studio asks for credentials again.
    resetAuth();
    text = "Airtable rejected the access token. Reset the credentials and enter a valid Personal Access Token.";
  } else if (code === 403) {
    text = "The access token lacks the required scopes (data.records:read, schema.bases:read) or access to this base.";
  } else if (code === 404) {
    text = "The selected base, table or view no longer exists or is not accessible.";
  } else if (code === 429) {
    text = "Airtable rate limit exceeded. Try again in a few seconds.";
  } else if (code === 422) {
    text = "Airtable rejected the request: " + detail;
  } else {
    text = "Airtable API error (HTTP " + code + ").";
  }
  throwUserError(text, "HTTP " + code + " on " + path + ": " + detail);
}

function throwUserError(text, debugText) {
  cc.newUserError()
    .setText(text)
    .setDebugText(debugText || text)
    .throwException();
}

function getAirtableBases() {
  var cache = CacheService.getUserCache();
  var cacheKey = "bases:" + tokenFingerprint();
  var cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var bases = [];
  var offset;
  do {
    var data = airtableFetch(
      "/meta/bases" + (offset ? "?offset=" + encodeURIComponent(offset) : ""),
    );
    bases = bases.concat(data.bases || []);
    offset = data.offset;
  } while (offset);
  bases = bases.map(function (base) {
    return { id: base.id, name: base.name };
  });
  putCache(cache, cacheKey, bases);
  return bases;
}

function putCache(cache, key, value) {
  try {
    cache.put(key, JSON.stringify(value), CACHE_TTL_SECONDS);
  } catch (e) {
    // Value larger than the cache limit (100KB): skip caching.
  }
}

// Keeps only what the connector uses so the base schema fits in the cache.
function slimTable(table) {
  return {
    id: table.id,
    name: table.name,
    views: (table.views || []).map(function (view) {
      return { id: view.id, name: view.name, type: view.type };
    }),
    fields: (table.fields || []).map(function (field) {
      var slim = { id: field.id, name: field.name, type: field.type, description: field.description };
      var options = field.options || {};
      var result = options.result;
      slim.options = {
        timeZone: options.timeZone,
        result: result
          ? { type: result.type, options: result.options && { timeZone: result.options.timeZone } }
          : undefined,
      };
      return slim;
    }),
  };
}

function getAirtableTables(baseId, skipCache) {
  var cache = CacheService.getUserCache();
  var cacheKey = "tables:" + tokenFingerprint() + ":" + baseId;
  var cached = skipCache ? null : cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var tables = (
    airtableFetch("/meta/bases/" + encodeURIComponent(baseId) + "/tables").tables || []
  ).map(slimTable);
  putCache(cache, cacheKey, tables);
  return tables;
}

function findById(items, id) {
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) {
      return items[i];
    }
  }
  return null;
}

function getAirtableTable(baseId, tableId) {
  // A table created after the cache was filled is looked up again, uncached.
  var table =
    findById(getAirtableTables(baseId), tableId) ||
    findById(getAirtableTables(baseId, true), tableId);
  if (table) {
    return table;
  }
  throwUserError(
    "Table not found. Edit the data source and select the table again.",
    "Table " + tableId + " not found in base " + baseId,
  );
}

function tokenFingerprint() {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    getStoredToken() || "",
  );
  return Utilities.base64EncodeWebSafe(digest).substring(0, 16);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getConfig(request) {
  var config = cc.getConfig();
  var params = (request && request.configParams) || {};

  config.newInfo().setId("instructions1").setText("Step 1: Select Base.");
  var baseSelect = config
    .newSelectSingle()
    .setId("baseId")
    .setName("Base")
    .setHelpText("Select the base you want to connect to.")
    .setIsDynamic(true);
  getAirtableBases().forEach(function (base) {
    baseSelect.addOption(
      config.newOptionBuilder().setLabel(base.name).setValue(base.id),
    );
  });

  // Ignore stale selections left over after changing an earlier dynamic step.
  var tables = params.baseId ? getAirtableTables(params.baseId) : [];
  var table = params.tableId ? findById(tables, params.tableId) : null;
  var views = table
    ? table.views.filter(function (view) {
        return view.type !== "form";
      })
    : [];
  var hasView = !!(params.viewId && findById(views, params.viewId));

  if (params.baseId) {
    config.newInfo().setId("instructions2").setText("Step 2: Select Table.");
    var tableSelect = config
      .newSelectSingle()
      .setId("tableId")
      .setName("Table")
      .setHelpText("Select the table you want to connect to.")
      .setIsDynamic(true);
    tables.forEach(function (item) {
      tableSelect.addOption(
        config.newOptionBuilder().setLabel(item.name).setValue(item.id),
      );
    });
  }

  if (table) {
    config.newInfo().setId("instructions3").setText("Step 3: Select View.");
    var viewSelect = config
      .newSelectSingle()
      .setId("viewId")
      .setName("View")
      .setHelpText("Records are returned with the filters and sorting of this view.");
    views.forEach(function (view) {
      viewSelect.addOption(
        config.newOptionBuilder().setLabel(view.name).setValue(view.id),
      );
    });
  }

  if (!table || (views.length > 0 && !hasView)) {
    config.setIsSteppedConfig(true);
  }

  return config.build();
}

function validateConfig(configParams) {
  if (!configParams || !configParams.baseId || !configParams.tableId) {
    throwUserError(
      "Incomplete configuration. Edit the data source and select a base, table and view.",
      "configParams: " + JSON.stringify(configParams),
    );
  }
  return configParams;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Maps an Airtable field type to its Looker Studio representation.
// `format` selects the value conversion applied in getData.
function getTypeSpec(airtableType, options) {
  var types = cc.FieldType;
  var aggregations = cc.AggregationType;

  switch (airtableType) {
    case "number":
    case "currency":
    case "count":
      return { metric: true, type: types.NUMBER, aggregation: aggregations.SUM, format: "number" };
    case "percent":
      return { metric: true, type: types.PERCENT, aggregation: aggregations.AVG, format: "number" };
    case "rating":
      return { metric: true, type: types.NUMBER, aggregation: aggregations.AVG, format: "number" };
    case "duration":
      return { metric: true, type: types.DURATION, aggregation: aggregations.SUM, format: "number" };
    case "autoNumber":
      return { type: types.NUMBER, format: "number" };
    case "checkbox":
      return { type: types.BOOLEAN, format: "boolean" };
    case "date":
      return { type: types.YEAR_MONTH_DAY, format: "date" };
    case "dateTime":
    case "createdTime":
    case "lastModifiedTime":
      return { type: types.YEAR_MONTH_DAY_SECOND, format: "dateTime" };
    case "url":
      return { type: types.URL, format: "text" };
    case "multipleAttachments":
      return { type: types.URL, format: "attachment" };
    case "formula":
    case "rollup":
    case "multipleLookupValues":
      if (options && options.result && options.result.type) {
        return getTypeSpec(options.result.type, options.result.options);
      }
      return { type: types.TEXT, format: "text" };
    default:
      return { type: types.TEXT, format: "text" };
  }
}

// Resolves the zone of a field: date fields keep it in options.timeZone;
// computed and created/modified time fields in options.result.options.timeZone.
function getTimeZone(field) {
  var options = field.options || {};
  var timeZone =
    options.timeZone ||
    (options.result && options.result.options && options.result.options.timeZone);
  return !timeZone || timeZone === "client" || timeZone.toLowerCase() === "utc"
    ? "UTC"
    : timeZone;
}

function getFieldSpecs(table) {
  var seen = {};
  var specs = [];
  table.fields.forEach(function (field) {
    if (seen[field.id]) {
      return;
    }
    seen[field.id] = true;
    var spec = getTypeSpec(field.type, field.options);
    spec.id = field.id;
    spec.name = field.name;
    spec.description = field.description;
    spec.timeZone = getTimeZone(field);
    specs.push(spec);
  });
  return specs;
}

function buildFields(specs) {
  var fields = cc.getFields();
  specs.forEach(function (spec) {
    var field = spec.metric ? fields.newMetric() : fields.newDimension();
    field.setId(spec.id).setName(spec.name).setType(spec.type);
    if (spec.aggregation) {
      field.setAggregation(spec.aggregation);
    }
    if (spec.description) {
      field.setDescription(spec.description);
    }
  });
  return fields;
}

function getSchema(request) {
  var params = validateConfig(request.configParams);
  var table = getAirtableTable(params.baseId, params.tableId);
  return { schema: buildFields(getFieldSpecs(table)).build() };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function getData(request) {
  var params = validateConfig(request.configParams);
  var table = getAirtableTable(params.baseId, params.tableId);
  var specs = getFieldSpecs(table);

  var specsById = {};
  specs.forEach(function (spec) {
    specsById[spec.id] = spec;
  });

  var requestedSpecs = (request.fields || []).map(function (field) {
    var spec = specsById[field.name];
    if (!spec) {
      throwUserError(
        "A field used by this report no longer exists in the Airtable table.",
        "Unknown field id: " + field.name,
      );
    }
    return spec;
  });

  var sampleOnly = !!(request.scriptParams && request.scriptParams.sampleExtraction);
  var rows = getAirtableRows(params, requestedSpecs, sampleOnly);

  return {
    schema: buildFields(requestedSpecs).build(),
    rows: rows,
  };
}

// Returns the converted rows, served from the user cache when a report with
// several charts requests the same fields and view within the TTL.
// The user lock makes concurrent executions wait for the first download
// instead of all hitting the Airtable rate limit.
function getAirtableRows(params, specs, sampleOnly) {
  var key = rowsCacheKey(params, specs);
  var rows = readRowsCache(key);
  if (rows) {
    return sampleOnly ? rows.slice(0, PAGE_SIZE) : rows;
  }
  if (sampleOnly) {
    return fetchAirtableRows(params, specs, true);
  }

  var lock = LockService.getUserLock();
  var locked = false;
  var wait = Math.min(LOCK_WAIT_MS, EXEC_BUDGET_MS - (Date.now() - EXEC_STARTED) - 60000);
  if (wait > 0) {
    locked = lock.tryLock(wait);
  }
  try {
    // The lock holder may have filled the cache even when the wait expired.
    rows = readRowsCache(key);
    if (rows) {
      return rows;
    }
    rows = fetchAirtableRows(params, specs, false);
    writeRowsCache(key, rows);
    return rows;
  } finally {
    if (locked) {
      lock.releaseLock();
    }
  }
}

function rowsCacheKey(params, specs) {
  var raw = [
    tokenFingerprint(),
    params.baseId,
    params.tableId,
    params.viewId || "",
    specs.map(function (spec) {
      return spec.id;
    }).join(","),
  ].join("|");
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return "rows:" + Utilities.base64EncodeWebSafe(digest);
}

function readRowsCache(key) {
  var cache = CacheService.getUserCache();
  var count = Number(cache.get(key + ":n"));
  if (!count) {
    return null;
  }
  var keys = [];
  for (var i = 0; i < count; i++) {
    keys.push(key + ":" + i);
  }
  var chunks = cache.getAll(keys);
  var json = "";
  for (var j = 0; j < keys.length; j++) {
    if (chunks[keys[j]] === undefined || chunks[keys[j]] === null) {
      return null; // Evicted or expired in part: treat as a miss.
    }
    json += chunks[keys[j]];
  }
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function writeRowsCache(key, rows) {
  var json = JSON.stringify(rows);
  var chunks = [];
  var start = 0;
  while (start < json.length) {
    if (chunks.length === ROWS_MAX_CHUNKS) {
      return; // Too large for the cache: always fetch.
    }
    var end = Math.min(start + ROWS_CHUNK_CHARS, json.length);
    // Splitting a surrogate pair would corrupt the character on reassembly.
    var last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) {
      end--;
    }
    chunks.push(json.substring(start, end));
    start = end;
  }
  var entries = {};
  chunks.forEach(function (chunk, i) {
    entries[key + ":" + i] = chunk;
  });
  entries[key + ":n"] = String(chunks.length);
  try {
    CacheService.getUserCache().putAll(entries, CACHE_TTL_SECONDS);
  } catch (e) {
    // Cache quota exceeded: skip caching.
  }
}

// Fetches the records page by page, converting each page as it arrives and
// failing before the Apps Script execution limit is reached.
function fetchAirtableRows(params, specs, sampleOnly) {
  var path =
    "/" + encodeURIComponent(params.baseId) +
    "/" + encodeURIComponent(params.tableId) + "/listRecords";
  var payload = {
    fields: specs.map(function (spec) {
      return spec.id;
    }),
    pageSize: PAGE_SIZE,
    returnFieldsByFieldId: true,
  };
  if (params.viewId) {
    payload.view = params.viewId;
  }

  var rows = [];
  do {
    failIfOverBudget(0, path);
    var data = airtableFetch(path, payload);
    var records = data.records || [];
    for (var i = 0; i < records.length; i++) {
      var cells = records[i].fields || {};
      var values = new Array(specs.length);
      for (var j = 0; j < specs.length; j++) {
        values[j] = formatValue(cells[specs[j].id], specs[j]);
      }
      rows.push({ values: values });
    }
    payload.offset = data.offset;
  } while (payload.offset && !sampleOnly);

  return rows;
}

// Converts an Airtable cell value to the format Looker Studio expects.
function formatValue(value, spec) {
  if (spec.format === "boolean") {
    // Airtable omits unchecked checkboxes; formulas and lookups may return 1/0 or a list.
    if (Array.isArray(value)) {
      value = value[0];
    }
    return value === true || value === 1;
  }
  if (value === undefined || value === null) {
    return null;
  }
  if (isErrorValue(value)) {
    return null;
  }
  // Lookups return arrays even for scalar result types: numbers are added up,
  // other types use the first value.
  if (Array.isArray(value) && spec.format !== "attachment" && spec.format !== "text") {
    if (spec.format === "number") {
      return sumNumbers(value);
    }
    value = value.length ? value[0] : null;
    if (value === null || isErrorValue(value)) {
      return null;
    }
  }

  switch (spec.format) {
    case "number":
      return typeof value === "number" ? value : parseNumber(value);
    case "date":
      return formatDate(value);
    case "dateTime":
      return formatDateTime(value, spec.timeZone);
    case "attachment":
      return Array.isArray(value) && value.length ? value[0].url || null : null;
    default:
      return toText(value);
  }
}

function isErrorValue(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.error !== undefined || value.specialValue !== undefined)
  );
}

function parseNumber(value) {
  if (String(value).trim() === "") {
    return null;
  }
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function sumNumbers(values) {
  var total = 0;
  var found = false;
  for (var i = 0; i < values.length; i++) {
    var number = typeof values[i] === "number" ? values[i] : parseNumber(values[i]);
    if (number !== null) {
      total += number;
      found = true;
    }
  }
  return found ? total : null;
}

function formatDate(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return match ? match[1] + match[2] + match[3] : null;
}

function formatDateTime(value, timeZone) {
  var ms = Date.parse(value);
  if (isNaN(ms)) {
    return null;
  }
  var offset = timeZone === "UTC" ? 0 : getZoneOffset(timeZone, ms);
  return new Date(ms + offset)
    .toISOString()
    .replace(/\D/g, "")
    .substring(0, 14);
}

// Returns the UTC offset in ms for a zone, cached per 15 minute slot to avoid
// one Utilities.formatDate service call per cell.
var zoneOffsets = {};
function getZoneOffset(timeZone, ms) {
  var key = timeZone + ":" + Math.floor(ms / 900000);
  if (zoneOffsets[key] === undefined) {
    var offset = 0;
    try {
      var z = Utilities.formatDate(new Date(ms), timeZone, "Z"); // e.g. "-0500"
      offset = (z.charAt(0) === "-" ? -1 : 1) * (Number(z.substr(1, 2)) * 60 + Number(z.substr(3, 2))) * 60000;
    } catch (e) {
      Logger.log("Unknown time zone " + timeZone + ": falling back to UTC.");
    }
    zoneOffsets[key] = offset;
  }
  return zoneOffsets[key];
}

function toText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    var items = value
      .filter(function (item) {
        return !isErrorValue(item);
      })
      .map(toText)
      .filter(function (item) {
        return item !== null && item !== "";
      });
    return items.length ? items.join(", ") : null;
  }
  if (typeof value === "object") {
    // AI text fields keep their content in `value`.
    if (value.state !== undefined && value.value !== undefined) {
      return toText(value.value);
    }
    // Collaborators, attachments, barcodes, buttons and linked records.
    var text = value.name || value.text || value.label || value.filename || value.email || value.url || value.id;
    return text !== undefined ? String(text) : JSON.stringify(value);
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Manual test
// ---------------------------------------------------------------------------

// Requires credentials set via setCredentials and the script properties
// BASE_ID, TABLE_ID and VIEW_ID.
function testGetData() {
  var props = PropertiesService.getScriptProperties();
  var configParams = {
    baseId: props.getProperty("BASE_ID"),
    tableId: props.getProperty("TABLE_ID"),
    viewId: props.getProperty("VIEW_ID"),
  };
  var schema = getSchema({ configParams: configParams }).schema;
  var request = {
    configParams: configParams,
    fields: schema.map(function (field) {
      return { name: field.name };
    }),
  };

  var result = getData(request);

  Logger.log(JSON.stringify(result, null, 2));
}
