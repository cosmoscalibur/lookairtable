# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Rows converted from Airtable are cached per user, so charts that request the
  same fields share a single download.
- Support for autoNumber, count, duration, formula, rollup, lookup,
  attachment, createdTime and lastModifiedTime fields, with time zone handling
  for date-time values.
- Requests to Airtable retry on rate limits, server errors and network
  failures, and fail with a clear error before the Apps Script execution limit.

### Changed

- Authentication uses an Airtable Personal Access Token stored in the user
  properties instead of an API key in the data source configuration.
- The configuration selects base, table and view by id. Existing data sources
  must be reconfigured.
- The manifest file is renamed from `appscript.json` to `appsscript.json`.

### Fixed

- Records with formula or rollup error values return null instead of an error
  object.
