// Host-supplied defaults live at the UA cascade origin. A site's own CSS always
// wins; no content script, DOM replacement, or author-origin !important rules.
const sheets = Cc["@mozilla.org/content/style-sheet-service;1"]
  .getService(Ci.nsIStyleSheetService);
let current;
let sheet;
let chromeStyle;

// A page's Content-Security-Policy governs data: and blob: images even when a
// UA sheet asks for them, so theme artwork written as url(data:...) vanishes
// on sites whose img-src omits data:. Theme images are served from
// resource://embed-theme/ instead: a content-accessible local resource, which
// CSP exempts, as it does Firefox's own UA-sheet icons. The host is fixed on
// purpose: these URLs show in pages' computed styles, so a per-engine host
// would be a cross-site identifier, while the art itself reveals no more than
// the controls' computed colors already do. Each name is immutable, because
// the image cache keys on the URL; new art needs a new name.
const ASSET_HOST = "embed-theme";
const ASSET_NAME = /^[a-z0-9][a-z0-9_-]*\.svg$/;
const assets = new Map();
let assetDir;
const selectionPrefs = {
  background: ["ui.selecteditem", "ui.highlight", "ui.-moz-cellhighlight", "ui.-moz_menuhover"],
  text: ["ui.selecteditemtext", "ui.highlighttext", "ui.-moz_cellhighlighttext", "ui.-moz_menuhovertext"],
};

export function registerChromeDocument(document) {
  chromeStyle = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  chromeStyle.textContent = current?.popupCss ?? "";
  document.head.appendChild(chromeStyle);
}

export function setTheme(json) {
  const next = JSON.parse(json);
  if (!next || typeof next.contentCss !== "string" ||
      typeof next.popupCss !== "string" || typeof next.dark !== "boolean") {
    throw new TypeError("Invalid embedding theme");
  }
  if (next.selection !== undefined && (!next.selection ||
      !/^#[0-9a-f]{6}$/i.test(next.selection.background) ||
      !/^#[0-9a-f]{6}$/i.test(next.selection.text))) {
    throw new TypeError("Invalid embedding selection colors");
  }
  const nextAssets = next.assets ?? {};
  if (!nextAssets || typeof nextAssets !== "object" || Array.isArray(nextAssets)) {
    throw new TypeError("Invalid embedding theme assets");
  }
  for (const [name, text] of Object.entries(nextAssets)) {
    if (!ASSET_NAME.test(name) || typeof text !== "string") {
      throw new TypeError(`Invalid embedding theme asset: ${name}`);
    }
    if (assets.has(name) && assets.get(name) !== text) {
      throw new TypeError(`Embedding theme asset names are immutable: ${name}`);
    }
  }
  if (current && current.contentCss === next.contentCss &&
      current.popupCss === next.popupCss && current.dark === next.dark &&
      current.selection?.background === next.selection?.background &&
      current.selection?.text === next.selection?.text &&
      sameAssets(current.assets, nextAssets)) return;

  // Write the images before the sheet that names them is registered.
  for (const [name, text] of Object.entries(nextAssets)) {
    if (!assets.has(name)) writeAsset(name, text);
  }
  if (current?.contentCss !== next.contentCss) {
    const uri = Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(next.contentCss));
    // Register first: a failed replacement must not remove the working theme.
    sheets.loadAndRegisterSheet(uri, sheets.AGENT_SHEET);
    if (sheet) sheets.unregisterSheet(sheet, sheets.AGENT_SHEET);
    sheet = uri;
  }
  for (const name of [...assets.keys()]) {
    if (!Object.hasOwn(nextAssets, name)) removeAsset(name);
  }
  Services.prefs.setIntPref("ui.systemUsesDarkTheme", next.dark ? 1 : 0);
  // Native listbox selection uses UA !important system colors. Supply the
  // system palette instead of overriding those accessibility rules with CSS.
  for (const [key, names] of Object.entries(selectionPrefs)) {
    for (const name of names) {
      if (next.selection) Services.prefs.setCharPref(name, next.selection[key]);
      else if (current?.selection) Services.prefs.clearUserPref(name);
    }
  }
  if (chromeStyle) chromeStyle.textContent = next.popupCss;
  current = { ...next, assets: nextAssets };
}

function sameAssets(a = {}, b = {}) {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every(name => a[name] === b[name]);
}

// A fresh directory of this engine's own, registered once as the asset host.
function assetDirectory() {
  if (assetDir) return assetDir;
  const dir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  dir.append("embed-theme");
  dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  Services.io.getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitutionWithFlags(ASSET_HOST, Services.io.newFileURI(dir),
      Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);
  assetDir = dir;
  return dir;
}

function writeAsset(name, text) {
  const file = assetDirectory().clone();
  file.append(name);
  const out = Cc["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Ci.nsIFileOutputStream);
  // PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE
  out.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);
  try {
    const binary = Cc["@mozilla.org/binaryoutputstream;1"]
      .createInstance(Ci.nsIBinaryOutputStream);
    binary.setOutputStream(out);
    binary.writeByteArray(new TextEncoder().encode(text));
  } finally {
    out.close();
  }
  assets.set(name, text);
}

function removeAsset(name) {
  const file = assetDir.clone();
  file.append(name);
  if (file.exists()) file.remove(false);
  assets.delete(name);
}
