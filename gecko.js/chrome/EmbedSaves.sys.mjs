// Downloads stay in Gecko (cookies, redirects, principals and original response
// bodies). The embedder chooses a destination and receives the completed bytes;
// its filesystem paths never enter the guest.
let sequence = 0;
const saves = new Map();
const byPath = new Map();
const abortCode = Cr.NS_BINDING_ABORTED;
Services.prefs.setBoolPref("browser.download.useDownloadDir", false);
const debug = (...detail) => {
  if (Services.env.get("GECKO_SAVE_DEBUG") === "1") console.log("[embed-save]", ...detail);
};

function host(topic, data, subject = null) {
  Services.obs.notifyObservers(subject, topic, JSON.stringify(data));
}
function nameOnly(value) {
  const name = String(value || "download").replace(/^.*[\\/]/, "").replace(/[\x00-\x1f\x7f]/g, "");
  return name && name !== "." && name !== ".." ? name : "download";
}
function remove(state) {
  debug("release", state.id, state.file.path, state.payload?.path);
  saves.delete(state.id);
  byPath.delete(state.file.path);
  state.window?.removeEventListener("pagehide", state.cancel);
  // Helper-app downloads can finish before a destination is chosen; their
  // completed .part file may still live outside our destination directory.
  if (state.payload && state.payload.path !== state.file.path) {
    try { state.payload.remove(false); } catch {}
  }
  try { state.file.parent.remove(true); } catch {}
}
export function chooseSave(context, options = {}) {
  const id = String(++sequence);
  debug("choose", id, options.name, options.url);
  const window = context?.window;
  let cancelled = false;
  const cancel = () => {
    debug("cancel", id);
    cancelled = true;
    host("gecko-embed-save-cancel", { id });
    const state = saves.get(id);
    if (state) {
      state.cancelled = true;
      try { state.cancelable?.cancel(abortCode); } catch {}
      remove(state);
    }
  };
  window?.addEventListener("pagehide", cancel, { once: true });
  const reply = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  reply.data = "null";
  host("gecko-embed-save-choose", { ...options, id, name: nameOnly(options.name) }, reply);
  const result = JSON.parse(reply.data);
  if (cancelled || !result) {
    window?.removeEventListener("pagehide", cancel);
    return null;
  }
  try {
    const directory = Services.dirsvc.get("TmpD", Ci.nsIFile);
    directory.append("embed-save");
    directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    const file = directory.clone();
    file.append(nameOnly(result.name || options.name));
    const state = { id, file, window, cancel, cancelled: false, cancelable: null };
    saves.set(id, state);
    byPath.set(file.path, state);
    debug("destination", id, file.path);
    return file;
  } catch (error) {
    window?.removeEventListener("pagehide", cancel);
    host("gecko-embed-save-finish", { id, error: String(error) });
    throw error;
  }
}
function finish(state, status) {
  if (!state || state.cancelled || !saves.has(state.id)) return;
  debug("finish", state.id, status, (state.payload || state.file).path);
  try {
    host("gecko-embed-save-finish", {
      id: state.id,
      ...(Components.isSuccessCode(status) ? {} : { error: `Download failed (0x${(status >>> 0).toString(16)}).` }),
    }, Components.isSuccessCode(status) ? state.payload || state.file : null);
  } finally { remove(state); }
}

class Transfer {
  QueryInterface = ChromeUtils.generateQI(["nsITransfer", "nsIWebProgressListener", "nsIWebProgressListener2"]);
  state = null;
  init(_source, _original, target, _name, _mime, _time, temp, cancelable) {
    this.state = byPath.get(target.QueryInterface(Ci.nsIFileURL).file.path);
    if (!this.state) { cancelable.cancel(abortCode); return; }
    this.state.cancelable = cancelable;
    // The legacy download frontend normally moves this completed part file
    // to target. Embedders export it directly once STATE_STOP is delivered.
    this.state.payload = temp;
    debug("transfer", this.state.id, this.state.file.path, temp?.path);
  }
  initWithBrowsingContext(source, target, name, mime, time, temp, cancelable) {
    this.init(source, null, target, name, mime, time, temp, cancelable);
  }
  onStateChange(_progress, _request, flags, status) {
    debug("state", this.state?.id, flags, status);
    if ((flags & Ci.nsIWebProgressListener.STATE_STOP) && (flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) {
      const state = this.state;
      this.state = null;
      if (state) state.cancelable = null;
      finish(state, status);
    }
  }
  onProgressChange() {}
  onProgressChange64() {}
  onStatusChange() {}
  onLocationChange() {}
  onSecurityChange() {}
  onContentBlockingEvent() {}
  onRefreshAttempted() { return true; }
  setSha256Hash() {}
  setSignatureInfo() {}
  setRedirects() {}
  get downloadPromise() { return Promise.resolve(null); }
}

class LauncherDialog {
  QueryInterface = ChromeUtils.generateQI(["nsIHelperAppLauncherDialog"]);
  show(launcher) { launcher.promptForSaveDestination(); }
  promptForSaveToFileAsync(launcher, _window, name, extension) {
    Services.tm.dispatchToMainThread(() => {
      try {
        const context = BrowsingContext.get(launcher.browsingContextId);
        const file = chooseSave(context, { name: name || launcher.suggestedFileName,
          extension, type: launcher.MIMEInfo.MIMEType, url: launcher.source.spec });
        if (file) {
          byPath.get(file.path).cancelable = launcher;
          launcher.saveDestinationAvailable(file, true);
        } else launcher.cancel(abortCode);
      } catch (error) {
        console.error("[embed-save]", error);
        launcher.cancel(abortCode);
      }
    });
  }
}

// Invoked only by the privileged embedding command, never by a content script.
export function saveURL(json, window) {
  const { url, document: saveDocument } = JSON.parse(json);
  const document = window.document;
  const uri = Services.io.newURI(url || document.documentURI);
  Services.scriptSecurityManager.checkLoadURIWithPrincipal(document.nodePrincipal, uri,
    Ci.nsIScriptSecurityManager.DISALLOW_SCRIPT);
  Services.tm.dispatchToMainThread(() => {
    let state;
    try {
      const filename = saveDocument ? `${document.title || "page"}.html` :
        (() => { try { return decodeURIComponent(uri.QueryInterface(Ci.nsIURL).fileName); } catch { return "download"; } })();
      const file = chooseSave(window.browsingContext, { name: filename, url: uri.spec,
        type: saveDocument ? "text/html" : "application/octet-stream",
        title: saveDocument ? "Save Page (HTML only)" : "Save As" });
      if (!file) return;
      state = byPath.get(file.path);
      const persist = Cc["@mozilla.org/embedding/browser/nsWebBrowserPersist;1"].createInstance(Ci.nsIWebBrowserPersist);
      state.cancelable = persist;
      persist.persistFlags = Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES |
        Ci.nsIWebBrowserPersist.PERSIST_FLAGS_FROM_CACHE |
        Ci.nsIWebBrowserPersist.PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION;
      const listener = new Transfer();
      listener.state = state;
      persist.progressListener = listener;
      if (saveDocument) {
        persist.saveDocument(document, file, null, "text/html",
          Ci.nsIWebBrowserPersist.ENCODE_FLAGS_ABSOLUTE_LINKS, 0);
      } else {
        persist.saveURI(uri, document.nodePrincipal, 0, document.referrerInfo,
          document.cookieJarSettings, null, null, file,
          Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
          !!document.nodePrincipal.originAttributes?.privateBrowsingId);
      }
    } catch (error) {
      console.error("[embed-save]", error);
      if (state) {
        try { host("gecko-embed-save-finish", { id: state.id, error: String(error) }); }
        finally { remove(state); }
      }
    }
  });
}

const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
for (const [cid, contract, implementation] of [
  ["{930d62f7-867b-414c-a87b-8c17453dfe50}", "@mozilla.org/helperapplauncherdialog;1", LauncherDialog],
  ["{6d144275-6a88-4bb0-b5d8-519079c10585}", "@mozilla.org/transfer;1", Transfer],
]) registrar.registerFactory(Components.ID(cid), contract, contract, {
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
  createInstance(iid) { return new implementation().QueryInterface(iid); },
});
