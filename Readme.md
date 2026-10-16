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

1. Authorize with an Airtable
   [Personal Access Token](https://airtable.com/create/tokens) with scopes
   `data.records:read` and `schema.bases:read`. The token is stored in the
   user properties of the script, not in the data source configuration.
2. Select the Base you want to connect to.
3. Select the Table you want to connect to.
4. Select the View you want to get the data from (its filters and sorting
   apply).

## Field types

| Airtable                                         | Looker Studio              |
| ------------------------------------------------ | -------------------------- |
| number, currency, count                          | Number metric (SUM)        |
| autoNumber                                       | Number dimension           |
| percent                                          | Percent metric (AVG)       |
| rating                                           | Number metric (AVG)        |
| duration                                         | Duration metric (SUM)      |
| checkbox                                         | Boolean                    |
| date                                             | Date                       |
| dateTime, createdTime, lastModifiedTime          | Date & time                |
| url                                              | URL                        |
| multipleAttachments                              | URL (first attachment)     |
| formula, rollup, lookup                          | Mapped from result type    |
| Other (text, selects, collaborators, links, ...) | Text (lists comma-joined)  |

Numeric lookups with several values are summed; other lookups use the first
value. Form views are not listed because they return no records.

Attachment URLs returned by Airtable expire after a few hours.

## Development

- The main logic is in the `Code.js` file.
- The `appsscript.json` file contains the manifest for the Apps Script project.
- The `testGetData` function in `Code.js` can be used for testing. It needs
  credentials stored with `setCredentials({key: "<token>"})` and the script
  properties `BASE_ID`, `TABLE_ID` and `VIEW_ID`.
