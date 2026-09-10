/**
 * EC Lab Inventory — Google Apps Script backend.
 *
 * The bound Google Spreadsheet is the database. This script publishes a small
 * JSON API that the static front end (GitHub Pages) calls.
 *
 * Sheets used (created by setupSheets()):
 *   Inventory  id | name | type | smd | place | qty | min | approx | unknown | updatedAt | updatedBy
 *   Issues     id | compId | compName | place | qty | person | purpose | at | by | status | returnedAt | returnedQty
 *   Activity   at | kind | who | text
 *   Settings   key | value
 *
 * Security model
 *   The web app is deployed with access "Anyone", because a static page on
 *   GitHub Pages cannot complete a Google sign-in redirect. Reads are therefore
 *   open to anybody who knows the URL. Every WRITE requires the admin PIN,
 *   which is checked here on the server and stored in Script Properties -
 *   it never lives in the published front-end code.
 *
 * First-time setup: run setupSheets() once from the Apps Script editor,
 * then Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 */

var SHEET_INVENTORY = 'Inventory';
var SHEET_ISSUES = 'Issues';
var SHEET_ACTIVITY = 'Activity';
var SHEET_SETTINGS = 'Settings';

var INVENTORY_HEADERS = ['id', 'name', 'type', 'smd', 'place', 'qty', 'min',
                         'approx', 'unknown', 'updatedAt', 'updatedBy'];
var ISSUE_HEADERS = ['id', 'compId', 'compName', 'place', 'qty', 'person', 'purpose',
                     'at', 'by', 'status', 'returnedAt', 'returnedQty'];
var ACTIVITY_HEADERS = ['at', 'kind', 'who', 'text'];
var SETTINGS_HEADERS = ['key', 'value'];

var ACTIVITY_LIMIT = 400;   // rows kept in the Activity sheet
var DEFAULT_PIN = 'EC2580'; // used only until an admin changes it

/* ===================================================================
   SETUP — run once from the editor
   =================================================================== */

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet(ss, SHEET_INVENTORY, INVENTORY_HEADERS);
  ensureSheet(ss, SHEET_ISSUES, ISSUE_HEADERS);
  ensureSheet(ss, SHEET_ACTIVITY, ACTIVITY_HEADERS);
  var settings = ensureSheet(ss, SHEET_SETTINGS, SETTINGS_HEADERS);

  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 3, 2).setValues([
      ['labName', 'EC Lab'],
      ['thresholds', '{}'],
      ['defaultMin', '3']
    ]);
  }
  if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PIN')) {
    PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', DEFAULT_PIN);
  }
  SpreadsheetApp.getUi().alert(
    'Sheets are ready.\n\n' +
    'Admin PIN: ' + PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') +
    '\n\nNext: import data/inventory-seed.csv into the Inventory sheet, ' +
    'then deploy this script as a web app.');
}

function ensureSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0 || String(sh.getRange(1, 1).getValue()).trim() === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#1F2A36').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  return sh;
}

/** Change the admin PIN without touching the deployment. */
function setAdminPin(newPin) {
  if (!newPin) throw new Error('Pass the new PIN, e.g. setAdminPin("1234")');
  PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', String(newPin));
}

/* ===================================================================
   HTTP ENTRY POINTS
   =================================================================== */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'bootstrap';
    if (action === 'ping') return json({ ok: true, service: 'ec-lab-inventory' });
    if (action === 'bootstrap') return json({ ok: true, data: bootstrap() });
    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * Writes arrive as POST with Content-Type text/plain so the browser treats
 * them as "simple" requests. Apps Script cannot answer a CORS preflight,
 * so an application/json body would fail before it ever reached this code.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action;
    var payload = body.payload || {};

    if (action === 'login') {
      return json(checkPin(body.pin)
        ? { ok: true, role: 'admin' }
        : { ok: false, error: 'That PIN does not match.' });
    }

    if (!checkPin(body.pin)) {
      return json({ ok: false, error: 'Admin PIN required for this action.' });
    }

    var who = String(body.who || 'admin').slice(0, 60);
    var result;
    switch (action) {
      case 'saveComponent':   result = saveComponent(payload, who); break;
      case 'deleteComponent': result = deleteComponent(payload, who); break;
      case 'bulkQty':         result = bulkQty(payload, who); break;
      case 'issue':           result = issueComponent(payload, who); break;
      case 'returnIssue':     result = returnIssue(payload, who); break;
      case 'saveSettings':    result = saveSettings(payload, who); break;
      case 'setPin':          result = setPin(payload, who); break;
      default: return json({ ok: false, error: 'Unknown action: ' + action });
    }
    return json({ ok: true, result: result, data: bootstrap() });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkPin(pin) {
  var real = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || DEFAULT_PIN;
  return String(pin || '') === String(real);
}

/* ===================================================================
   READ
   =================================================================== */

function bootstrap() {
  return {
    components: readSheet(SHEET_INVENTORY, INVENTORY_HEADERS).map(normaliseComponent),
    issues: readSheet(SHEET_ISSUES, ISSUE_HEADERS).map(normaliseIssue),
    activity: readSheet(SHEET_ACTIVITY, ACTIVITY_HEADERS).slice(-120).reverse(),
    settings: readSettings(),
    serverTime: new Date().toISOString()
  };
}

function readSheet(name, headers) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') continue;
    var row = {};
    for (var c = 0; c < headers.length; c++) row[headers[c]] = values[i][c];
    out.push(row);
  }
  return out;
}

function normaliseComponent(r) {
  return {
    id: String(r.id),
    name: String(r.name || ''),
    type: String(r.type || 'Misc'),
    smd: isTrue(r.smd),
    place: String(r.place || 'UNASSIGNED').toUpperCase(),
    qty: r.qty === '' || r.qty === null ? 0 : Number(r.qty) || 0,
    min: r.min === '' || r.min === null ? 3 : Number(r.min) || 0,
    approx: isTrue(r.approx),
    unknown: isTrue(r.unknown),
    updatedAt: asIso(r.updatedAt),
    updatedBy: String(r.updatedBy || '')
  };
}

function normaliseIssue(r) {
  return {
    id: String(r.id),
    compId: String(r.compId || ''),
    compName: String(r.compName || ''),
    place: String(r.place || ''),
    qty: Number(r.qty) || 0,
    person: String(r.person || ''),
    purpose: String(r.purpose || ''),
    at: asIso(r.at),
    by: String(r.by || ''),
    status: String(r.status || 'open'),
    returnedAt: asIso(r.returnedAt),
    returnedQty: r.returnedQty === '' ? null : Number(r.returnedQty)
  };
}

function readSettings() {
  var rows = readSheet(SHEET_SETTINGS, SETTINGS_HEADERS);
  var out = { labName: 'EC Lab', thresholds: {}, defaultMin: 3 };
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i].key), v = rows[i].value;
    if (k === 'thresholds') {
      try { out.thresholds = JSON.parse(v || '{}'); } catch (e) { out.thresholds = {}; }
    } else if (k === 'defaultMin') {
      out.defaultMin = Number(v) || 3;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isTrue(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}

function asIso(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}

/* ===================================================================
   WRITE
   =================================================================== */

function sheetOf(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setupSheets() once.');
  return sh;
}

/** 1-based row number of a record, or 0 when it is not there. */
function findRow(sheetName, id) {
  var sh = sheetOf(sheetName);
  if (sh.getLastRow() < 2) return 0;
  var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function componentRow(c) {
  return [c.id, c.name, c.type, c.smd ? 'Yes' : '', c.place,
          c.unknown ? '' : c.qty, c.min, c.approx ? 'Yes' : '',
          c.unknown ? 'Yes' : '', c.updatedAt, c.updatedBy];
}

function saveComponent(p, who) {
  var c = {
    id: String(p.id || newId('EC')),
    name: String(p.name || '').trim(),
    type: String(p.type || 'Misc').trim(),
    smd: !!p.smd,
    place: String(p.place || 'UNASSIGNED').trim().toUpperCase(),
    qty: Math.max(0, Number(p.qty) || 0),
    min: Math.max(0, Number(p.min) || 0),
    approx: false,
    unknown: !!p.unknown,
    updatedAt: new Date().toISOString(),
    updatedBy: who
  };
  if (!c.name) throw new Error('A component needs a name.');

  var sh = sheetOf(SHEET_INVENTORY);
  var row = findRow(SHEET_INVENTORY, c.id);
  if (row) {
    sh.getRange(row, 1, 1, INVENTORY_HEADERS.length).setValues([componentRow(c)]);
    log('edit', who, 'Updated ' + c.name + ' (' + c.place + ', qty ' +
        (c.unknown ? 'not counted' : c.qty) + ')');
  } else {
    sh.appendRow(componentRow(c));
    log('add', who, 'Added ' + c.name + ' (' + c.qty + ') to bin ' + c.place);
  }
  return { id: c.id };
}

function deleteComponent(p, who) {
  var row = findRow(SHEET_INVENTORY, p.id);
  if (!row) throw new Error('Component ' + p.id + ' was not found.');
  var sh = sheetOf(SHEET_INVENTORY);
  var name = sh.getRange(row, 2).getValue();
  sh.deleteRow(row);
  log('delete', who, 'Removed ' + name + ' from the register');
  return { id: p.id };
}

/** payload.items = [{id, qty}] — used by the stock-take screen. */
function bulkQty(p, who) {
  var items = p.items || [];
  var sh = sheetOf(SHEET_INVENTORY);
  var now = new Date().toISOString();
  var n = 0;
  for (var i = 0; i < items.length; i++) {
    var row = findRow(SHEET_INVENTORY, items[i].id);
    if (!row) continue;
    sh.getRange(row, 6).setValue(Math.max(0, Number(items[i].qty) || 0)); // qty
    sh.getRange(row, 8).setValue('');                                     // approx
    sh.getRange(row, 9).setValue('');                                     // unknown
    sh.getRange(row, 10).setValue(now);
    sh.getRange(row, 11).setValue(who);
    n++;
  }
  log('count', who, 'Stock take' + (p.place ? ' on bin ' + p.place : '') +
      ' — ' + n + ' item' + (n === 1 ? '' : 's') + ' recounted');
  return { updated: n };
}

function issueComponent(p, who) {
  var row = findRow(SHEET_INVENTORY, p.compId);
  if (!row) throw new Error('Component ' + p.compId + ' was not found.');
  var sh = sheetOf(SHEET_INVENTORY);
  var name = String(sh.getRange(row, 2).getValue());
  var place = String(sh.getRange(row, 5).getValue());
  var unknown = isTrue(sh.getRange(row, 9).getValue());
  var have = unknown ? 0 : Number(sh.getRange(row, 6).getValue()) || 0;
  var qty = Math.max(1, Number(p.qty) || 1);
  var person = String(p.person || '').trim();

  if (!person) throw new Error('Enter who is taking the component.');
  if (!unknown && qty > have) throw new Error('Only ' + have + ' on the shelf.');

  var now = new Date().toISOString();
  sheetOf(SHEET_ISSUES).appendRow([
    newId('IS'), p.compId, name, place, qty, person,
    String(p.purpose || ''), now, who, 'open', '', ''
  ]);
  sh.getRange(row, 6).setValue(Math.max(0, have - qty));
  sh.getRange(row, 9).setValue('');
  sh.getRange(row, 10).setValue(now);
  sh.getRange(row, 11).setValue(who);

  log('issue', who, qty + ' x ' + name + ' issued to ' + person);
  return { ok: true };
}

function returnIssue(p, who) {
  var row = findRow(SHEET_ISSUES, p.id);
  if (!row) throw new Error('Issue record ' + p.id + ' was not found.');
  var ish = sheetOf(SHEET_ISSUES);
  var issued = Number(ish.getRange(row, 5).getValue()) || 0;
  var compId = String(ish.getRange(row, 2).getValue());
  var compName = String(ish.getRange(row, 3).getValue());
  var person = String(ish.getRange(row, 6).getValue());
  var back = Math.max(0, Math.min(issued, Number(p.qty)));
  var now = new Date().toISOString();

  ish.getRange(row, 10).setValue('returned');
  ish.getRange(row, 11).setValue(now);
  ish.getRange(row, 12).setValue(back);

  var crow = findRow(SHEET_INVENTORY, compId);
  if (crow && back > 0) {
    var sh = sheetOf(SHEET_INVENTORY);
    var have = isTrue(sh.getRange(crow, 9).getValue())
      ? 0 : Number(sh.getRange(crow, 6).getValue()) || 0;
    sh.getRange(crow, 6).setValue(have + back);
    sh.getRange(crow, 9).setValue('');
    sh.getRange(crow, 10).setValue(now);
    sh.getRange(crow, 11).setValue(who);
  }
  log('return', who, back + ' x ' + compName + ' returned by ' + person +
      (back < issued ? ' (' + (issued - back) + ' not returned)' : ''));
  return { ok: true };
}

function saveSettings(p, who) {
  var sh = sheetOf(SHEET_SETTINGS);
  var wanted = {
    labName: p.labName != null ? String(p.labName) : null,
    thresholds: p.thresholds != null ? JSON.stringify(p.thresholds) : null,
    defaultMin: p.defaultMin != null ? String(p.defaultMin) : null
  };
  var keys = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); })
    : [];
  for (var k in wanted) {
    if (wanted[k] === null) continue;
    var idx = keys.indexOf(k);
    if (idx >= 0) sh.getRange(idx + 2, 2).setValue(wanted[k]);
    else { sh.appendRow([k, wanted[k]]); keys.push(k); }
  }
  log('settings', who, 'Low-stock thresholds updated');
  return { ok: true };
}

function setPin(p, who) {
  var next = String(p.pin || '').trim();
  if (next.length < 4) throw new Error('Use a PIN of at least 4 characters.');
  PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', next);
  log('settings', who, 'Admin PIN changed');
  return { ok: true };
}

/* ===================================================================
   ACTIVITY LOG
   =================================================================== */

function log(kind, who, text) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ACTIVITY);
  if (!sh) return;
  sh.appendRow([new Date().toISOString(), kind, who, text]);
  var extra = sh.getLastRow() - 1 - ACTIVITY_LIMIT;
  if (extra > 0) sh.deleteRows(2, extra);
}

function newId(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
}
