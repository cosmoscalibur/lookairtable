// Community Looker Studio connector for AirTable

var cc = DataStudioApp.createCommunityConnector();

function isAdminUser() {
  return false;
}

function isAuthValid() {
  return true;
}

function getAuthType() {
  var AuthTypes = cc.AuthType;
  return cc.newAuthTypeResponse().setAuthType(AuthTypes.NONE).build();
}

function getConfig(request) {
  var config = cc.getConfig();

  config.newInfo().setId("instructions1").setText("Step 1: Enter API Key.");
  config
    .newTextInput()
    .setId("apiKey")
    .setName("API Key")
    .setHelpText("Enter your Airtable API Key.")
    .setPlaceholder("keyxxxxxxxxxxxxxx")
    .setIsDynamic(true);

  if (request.configParams && request.configParams.apiKey) {
    config.newInfo().setId("instructions2").setText("Step 2: Select Base.");
    var bases = getAirtableBases(request.configParams.apiKey);
    var baseSelect = config
      .newSelectSingle()
      .setId("baseId")
      .setName("Base")
      .setHelpText("Select the base you want to connect to.")
      .setIsDynamic(true);
    bases.forEach(function (base) {
      baseSelect.addOption(
        config.newOptionBuilder().setLabel(base.name).setValue(base.id),
      );
    });
  }

  if (request.configParams && request.configParams.baseId) {
    config.newInfo().setId("instructions3").setText("Step 3: Select Table.");
    var tables = getAirtableTables(
      request.configParams.apiKey,
      request.configParams.baseId,
    );
    var tableSelect = config
      .newSelectSingle()
      .setId("tableName")
      .setName("Table")
      .setHelpText("Select the table you want to connect to.");
    tables.forEach(function (table) {
      tableSelect.addOption(
        config.newOptionBuilder().setLabel(table.name).setValue(table.name),
      );
    });
  }

  if (!request.configParams || !request.configParams.tableName) {
    config.setIsSteppedConfig(true);
  }

  config.setDateRangeRequired(true);
  return config.build();
}

function getAirtableBases(apiKey) {
  var url = "https://api.airtable.com/v0/meta/bases";
  var options = {
    headers: {
      Authorization: "Bearer " + apiKey,
    },
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var content = response.getContentText();
    var data = JSON.parse(content);
    return data.bases;
  } catch (e) {
    // Handle errors, e.g., invalid API key
    cc.newUserError()
      .setText("Error fetching bases: " + e.toString())
      .setDebugText("Error fetching bases: " + e.toString())
      .throwException();
  }
}

function getAirtableTables(apiKey, baseId) {
  var url = "https://api.airtable.com/v0/meta/bases/" + baseId + "/tables";
  var options = {
    headers: {
      Authorization: "Bearer " + apiKey,
    },
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var content = response.getContentText();
    var data = JSON.parse(content);
    return data.tables;
  } catch (e) {
    // Handle errors, e.g., invalid API key or base ID
    cc.newUserError()
      .setText("Error fetching tables: " + e.toString())
      .setDebugText("Error fetching tables: " + e.toString())
      .throwException();
  }
}

function getSchema(request) {
  var fields = getFields(request).build();
  return { schema: fields };
}

function getFields(request) {
  var fields = cc.newFields();
  var types = cc.FieldType;

  var tableSchema = getAirtableTableSchema(
    request.configParams.apiKey,
    request.configParams.baseId,
    request.configParams.tableName,
  );

  tableSchema.fields.forEach(function (field) {
    switch (field.type) {
      case "singleLineText":
      case "multilineText":
      case "richText":
      case "email":
      case "url":
      case "phoneNumber":
      case "singleSelect":
      case "multipleSelects":
        fields
          .newDimension()
          .setId(field.id)
          .setName(field.name)
          .setType(types.TEXT);
        break;
      case "number":
      case "currency":
      case "percent":
      case "rating":
        fields
          .newMetric()
          .setId(field.id)
          .setName(field.name)
          .setType(types.NUMBER);
        break;
      case "checkbox":
        fields
          .newDimension()
          .setId(field.id)
          .setName(field.name)
          .setType(types.BOOLEAN);
        break;
      case "date":
      case "dateTime":
        fields
          .newDimension()
          .setId(field.id)
          .setName(field.name)
          .setType(types.YEAR_MONTH_DAY);
        break;
      case "createdTime":
      case "lastModifiedTime":
        fields
          .newDimension()
          .setId(field.id)
          .setName(field.name)
          .setType(types.YEAR_MONTH_DAY_HOUR);
        break;
      case "attachment":
        fields
          .newDimension()
          .setId(field.id)
          .setName(field.name)
          .setType(types.URL);
        break;
      default:
        fields
          .newDimension()
          .setId(field.id)
          .setName(field.name)
          .setType(types.TEXT);
        break;
    }
  });

  return fields;
}

function getAirtableTableSchema(apiKey, baseId, tableName) {
  var tables = getAirtableTables(apiKey, baseId);
  var table = tables.find(function (t) {
    return t.name === tableName;
  });

  if (table) {
    return table;
  } else {
    cc.newUserError()
      .setText("Table not found. Please check the table name.")
      .setDebugText("Table not found: " + tableName)
      .throwException();
  }
}

function getData(request) {
  var fields = getFields(request);
  var records = getAirtableRecords(request);

  var rows = records.map(function (record) {
    var row = [];
    fields.build().forEach(function (field) {
      var fieldValue = record.fields[field.getName()];
      row.push(fieldValue);
    });
    return { values: row };
  });

  return {
    schema: fields.build(),
    rows: rows,
  };
}

function getAirtableRecords(request) {
  var apiKey = request.configParams.apiKey;
  var baseId = request.configParams.baseId;
  var tableName = request.configParams.tableName;

  var url = "https://api.airtable.com/v0/" + baseId + "/" + tableName;
  var options = {
    headers: {
      Authorization: "Bearer " + apiKey,
    },
  };

  var records = [];
  var offset = null;

  do {
    var fullUrl = url;
    if (offset) {
      fullUrl += "?offset=" + offset;
    }

    try {
      var response = UrlFetchApp.fetch(fullUrl, options);
      var content = response.getContentText();
      var data = JSON.parse(content);

      records = records.concat(data.records);
      offset = data.offset;
    } catch (e) {
      cc.newUserError()
        .setText("Failed to fetch records. Please check your configuration.")
        .setDebugText("Error fetching records: " + e.toString())
        .throwException();
    }
  } while (offset);

  return records;
}
