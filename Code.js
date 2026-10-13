// Community Looker Studio connector for AirTable

var cc = DataStudioApp.createCommunityConnector();

var API_BASE_URL = "https://api.airtable.com/v0";
var TOKEN_PROPERTY = "airtable.token";
var CACHE_TTL_SECONDS = 300;
var MAX_RETRIES = 3;
var PAGE_SIZE = 100;

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
  return PropertiesService.getUserProperties().getProperty(TOKEN_PROPERTY);
}

function isAuthValid() {
  return !!getStoredToken();
}

function setCredentials(request) {
  var token = request.key;
  if (!token || !validateToken(token)) {
    return { errorCode: "INVALID_CREDENTIALS" };
  }
  PropertiesService.getUserProperties().setProperty(TOKEN_PROPERTY, token);
  return { errorCode: "NONE" };
}

function resetAuth() {
  PropertiesService.getUserProperties().deleteProperty(TOKEN_PROPERTY);
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
      throwUserError("Could not reach the Airtable API.", e.toString());
    }
    var code = response.getResponseCode();
    if (code === 200) {
      return JSON.parse(response.getContentText());
    }
    if ((code === 429 || code >= 500) && attempt < MAX_RETRIES) {
      // Airtable blocks for 30 seconds after exceeding the rate limit.
      Utilities.sleep(code === 429 ? 30000 : 1000 * Math.pow(2, attempt));
      continue;
    }
    throwAirtableError(code, response.getContentText(), path);
  }
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
    text = "Airtable rejected the access token. Reset the credentials and enter a valid Personal Access Token.";
  } else if (code === 403) {
    text = "The access token lacks the required scopes (data.records:read, schema.bases:read) or access to this base.";
  } else if (code === 404) {
    text = "The selected base, table or view no longer exists or is not accessible.";
  } else if (code === 429) {
    text = "Airtable rate limit exceeded. Try again in a few seconds.";
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
  var bases = [];
  var offset;
  do {
    var data = airtableFetch(
      "/meta/bases" + (offset ? "?offset=" + encodeURIComponent(offset) : ""),
    );
    bases = bases.concat(data.bases || []);
    offset = data.offset;
  } while (offset);
  return bases;
}

function getAirtableTables(baseId) {
  var cache = CacheService.getUserCache();
  var cacheKey = "tables:" + tokenFingerprint() + ":" + baseId;
  var cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var tables = airtableFetch("/meta/bases/" + encodeURIComponent(baseId) + "/tables").tables || [];
  try {
    cache.put(cacheKey, JSON.stringify(tables), CACHE_TTL_SECONDS);
  } catch (e) {
    // Schema larger than the cache value limit (100KB): skip caching.
  }
  return tables;
}

function getAirtableTable(baseId, tableId) {
  var tables = getAirtableTables(baseId);
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].id === tableId) {
      return tables[i];
    }
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

  if (params.baseId) {
    config.newInfo().setId("instructions2").setText("Step 2: Select Table.");
    var tableSelect = config
      .newSelectSingle()
      .setId("tableId")
      .setName("Table")
      .setHelpText("Select the table you want to connect to.")
      .setIsDynamic(true);
    getAirtableTables(params.baseId).forEach(function (table) {
      tableSelect.addOption(
        config.newOptionBuilder().setLabel(table.name).setValue(table.id),
      );
    });
  }

  if (params.baseId && params.tableId) {
    config.newInfo().setId("instructions3").setText("Step 3: Select View.");
    var table = getAirtableTable(params.baseId, params.tableId);
    var viewSelect = config
      .newSelectSingle()
      .setId("viewId")
      .setName("View")
      .setHelpText("Records are returned with the filters and sorting of this view.");
    (table.views || []).forEach(function (view) {
      viewSelect.addOption(
        config.newOptionBuilder().setLabel(view.name).setValue(view.id),
      );
    });
  }

  if (!params.baseId || !params.tableId || !params.viewId) {
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
    case "autoNumber":
      return { metric: true, type: types.NUMBER, aggregation: aggregations.SUM, format: "number" };
    case "percent":
      return { metric: true, type: types.PERCENT, aggregation: aggregations.AVG, format: "number" };
    case "rating":
      return { metric: true, type: types.NUMBER, aggregation: aggregations.AVG, format: "number" };
    case "duration":
      return { metric: true, type: types.DURATION, aggregation: aggregations.SUM, format: "number" };
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
    case "attachment":
      return { type: types.URL, format: "attachment" };
    case "formula":
    case "rollup":
      if (options && options.result && options.result.type) {
        return getTypeSpec(options.result.type, options.result.options);
      }
      return { type: types.TEXT, format: "text" };
    default:
      return { type: types.TEXT, format: "text" };
  }
}

function getTimeZone(field) {
  var options = field.options || {};
  if (field.type === "formula" || field.type === "rollup") {
    options = (options.result && options.result.options) || {};
  }
  var timeZone = options.timeZone;
  return timeZone && timeZone !== "client" ? timeZone : "UTC";
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

  var requestedIds = request.fields.map(function (field) {
    return field.name;
  });
  var requestedFields = buildFields(specs).forIds(requestedIds);
  var requestedSpecs = requestedFields.asArray().map(function (field) {
    return specsById[field.getId()];
  });

  var sampleOnly = !!(request.scriptParams && request.scriptParams.sampleExtraction);
  var records = getAirtableRecords(
    params,
    requestedSpecs.map(function (spec) {
      return spec.id;
    }),
    sampleOnly,
  );

  var rows = records.map(function (record) {
    var values = record.fields || {};
    return {
      values: requestedSpecs.map(function (spec) {
        return formatValue(values[spec.id], spec);
      }),
    };
  });

  return {
    schema: requestedFields.build(),
    rows: rows,
  };
}

function getAirtableRecords(params, fieldIds, sampleOnly) {
  var path =
    "/" + encodeURIComponent(params.baseId) +
    "/" + encodeURIComponent(params.tableId) + "/listRecords";
  var payload = {
    fields: fieldIds,
    pageSize: PAGE_SIZE,
    returnFieldsByFieldId: true,
  };
  if (params.viewId) {
    payload.view = params.viewId;
  }

  var records = [];
  do {
    var data = airtableFetch(path, payload);
    records = records.concat(data.records || []);
    payload.offset = data.offset;
  } while (payload.offset && !sampleOnly);

  return records;
}

// Converts an Airtable cell value to the format Looker Studio expects.
function formatValue(value, spec) {
  if (spec.format === "boolean") {
    // Airtable omits unchecked checkboxes.
    return value === true;
  }
  if (value === undefined || value === null) {
    return null;
  }
  if (isErrorValue(value)) {
    return null;
  }
  // Rollups and lookups may return arrays even for scalar result types.
  if (Array.isArray(value) && spec.format !== "attachment" && spec.format !== "text") {
    value = value.length ? value[0] : null;
    if (value === null) {
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
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function formatDate(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return match ? match[1] + match[2] + match[3] : null;
}

function formatDateTime(value, timeZone) {
  var date = new Date(value);
  if (isNaN(date.getTime())) {
    return null;
  }
  return Utilities.formatDate(date, timeZone, "yyyyMMddHHmmss");
}

function toText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value
      .map(toText)
      .filter(function (item) {
        return item !== null && item !== "";
      })
      .join(", ");
  }
  if (typeof value === "object") {
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
