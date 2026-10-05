// Host-supplied defaults live at the UA cascade origin. A site's own CSS always
// wins; no content script, DOM replacement, or author-origin !important rules.
const sheets = Cc["@mozilla.org/content/style-sheet-service;1"]
  .getService(Ci.nsIStyleSheetService);
let current;
let sheet;
let chromeStyle;

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
  if (current && current.contentCss === next.contentCss &&
      current.popupCss === next.popupCss && current.dark === next.dark) return;

  if (current?.contentCss !== next.contentCss) {
    const uri = Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(next.contentCss));
    // Register first: a failed replacement must not remove the working theme.
    sheets.loadAndRegisterSheet(uri, sheets.AGENT_SHEET);
    if (sheet) sheets.unregisterSheet(sheet, sheets.AGENT_SHEET);
    sheet = uri;
  }
  Services.prefs.setIntPref("ui.systemUsesDarkTheme", next.dark ? 1 : 0);
  if (chromeStyle) chromeStyle.textContent = next.popupCss;
  current = next;
}
