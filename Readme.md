# Looker Studio Connector for Airtable

A community connector for Google Looker Studio to visualize data from Airtable.

## Features

- Connect to any Airtable base and table.
- Select a specific view to get the data from.
- Fetches the schema from the Airtable table and makes it available in Looker
  Studio.

## How to use

1. Deploy the Apps Script project.
2. Create a new Community Connector in Looker Studio.
3. Use the deployment ID of your Apps Script project to connect to it.

## Configuration

1. Enter your Airtable API Key.
2. Select the Base you want to connect to.
3. Select the Table you want to connect to.
4. Select the View you want to get the data from.

## Development

- The main logic is in the `Code.js` file.
- The `appsscript.json` file contains the manifest for the Apps Script project.
- The `testGetData` function in `Code.js` can be used for testing.
