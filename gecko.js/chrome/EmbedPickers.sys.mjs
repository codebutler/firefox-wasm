// Native input pickers for a windowless embedding. Gecko owns activation,
// validation, FileList and trusted input/change/cancel events; the host supplies
// only the UI and the bytes of files the user explicitly selected.
import { DateTimePickerChild as NativeDateTimePickerChild } from
  "moz-src:///toolkit/actors/DateTimePickerChild.sys.mjs";
import { chooseSave } from "resource://gre/modules/EmbedSaves.sys.mjs";

Cu.importGlobalProperties(["File", "atob"]);
let nextId = 0;
function cancel(id) {
  Services.obs.notifyObservers(null, "gecko-embed-picker-cancel", id);
}
function closePicker(id) {
  Services.obs.notifyObservers(null, "gecko-embed-picker-close", id);
}
function readPickerChunk(session, index, offset) {
  const result = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  result.data = "null";
  Services.obs.notifyObservers(result, "gecko-embed-picker-chunk",
    JSON.stringify({ id: session, index, offset }));
  return JSON.parse(result.data);
}
function request(data, context, state = {}) {
  const id = String(++nextId);
  state.id = id;
  const window = context?.window;
  const pagehide = () => { state.cancelled = true; cancel(id); };
  window?.addEventListener("pagehide", pagehide, { once: true });
  try {
    const result = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    result.data = "null";
    Services.obs.notifyObservers(result, "gecko-embed-picker", JSON.stringify({ ...data, id }));
    return state.cancelled ? null : JSON.parse(result.data);
  } finally {
    window?.removeEventListener("pagehide", pagehide);
    state.id = null;
  }
}
function enumerator(values) {
  let index = 0;
  return {
    QueryInterface: ChromeUtils.generateQI(["nsISimpleEnumerator"]),
    hasMoreElements: () => index < values.length,
    getNext: () => {
      if (index >= values.length) throw Components.Exception("No more files", Cr.NS_ERROR_FAILURE);
      return values[index++];
    },
  };
}

class FilePicker {
  QueryInterface = ChromeUtils.generateQI(["nsIFilePicker"]);
  defaultString = "";
  defaultExtension = "";
  filterIndex = 0;
  displayDirectory = null;
  displaySpecialDirectory = "";
  addToRecentDocs = false;
  okButtonLabel = "";
  capture = 0;
  selected = [];
  filters = [];
  rawFilters = [];
  init(context, title, mode, global) {
    Object.assign(this, { context, title, mode, window: global || context?.window || globalThis });
  }
  isModeSupported(mode) { return Promise.resolve(mode === 0 || mode === 1 || mode === 2 || mode === 3); }
  appendFilters(mask) { if (mask & Ci.nsIFilePicker.filterAll) this.filters.push({ title: "All files", pattern: "*" }); }
  appendFilter(title, pattern) { this.filters.push({ title, pattern }); }
  appendRawFilter(filter) { this.rawFilters.push(filter); }
  saveFile = null;
  get file() { return this.saveFile; }
  get fileURL() { return this.saveFile ? Services.io.newFileURI(this.saveFile) : null; }
  get files() { return enumerator(this.saveFile ? [this.saveFile] : []); }
  get domFileOrDirectory() { return this.selected[0] || null; }
  get domFileOrDirectoryEnumerator() { return enumerator(this.selected); }
  get domFilesInWebKitDirectory() { return enumerator([]); }
  async writeStreamedFile(file, item, session) {
    if (!Number.isSafeInteger(item.index) || !Number.isSafeInteger(item.size) || item.size < 0)
      throw new Error("Invalid picker file metadata");
    let offset = 0;
    if (item.size === 0) {
      await IOUtils.write(file.path, new Uint8Array(), { mode: "create" });
      return;
    }
    while (offset < item.size) {
      const result = readPickerChunk(session, item.index, offset);
      if (typeof result?.data !== "string") throw new Error("Picker stream closed");
      const raw = atob(result.data);
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      if (!bytes.length || bytes.length > 65536 || offset + bytes.length > item.size)
        throw new Error("Invalid picker chunk length");
      await IOUtils.write(file.path, bytes, { mode: offset ? "append" : "create" });
      offset += bytes.length;
    }
  }
  async stageDirectory(result, staging, isCancelled) {
    const name = String(result.directory.name || "");
    if (!name || name === "." || name === ".." || /[\\/\x00-\x1f]/.test(name))
      throw new Error("Invalid directory name");
    const root = staging.clone(); root.append(name);
    root.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    for (const item of result.directory.files) {
        if (isCancelled()) throw new Error("Directory selection cancelled");
        const parts = String(item.path || "").split("/");
        if (!parts.length || parts.some(part => !part || part === "." || part === ".." ||
            /[\\\x00-\x1f]/.test(part))) throw new Error("Invalid relative file path");
        let dir = root;
        for (const part of parts.slice(0, -1)) {
          const next = dir.clone(); next.append(part);
          if (!next.exists()) next.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
          dir = next;
        }
        const file = dir.clone(); file.append(parts.at(-1));
        await this.writeStreamedFile(file, item, result.session);
        if (isCancelled()) throw new Error("Directory selection cancelled");
    }
    return new this.window.Directory(root.path);
  }
  open(callback) {
    // The interface is asynchronous: don't enter a nested event loop before
    // HTMLInputElement has finished recording that a picker is open.
    Services.tm.dispatchToMainThread(async () => {
      let code = Ci.nsIFilePicker.returnCancel;
      try {
        if (this.mode === 1) {
          this.saveFile = chooseSave(this.context, { title: this.title, name: this.defaultString,
            extension: this.defaultExtension });
          if (this.saveFile) code = Ci.nsIFilePicker.returnOK;
          return;
        }
        if (this.mode !== 0 && this.mode !== 2 && this.mode !== 3) return;
        const result = request({ kind: "file", title: this.title,
          multiple: this.mode === 3, directory: this.mode === 2,
          filters: this.filters, filterIndex: this.filterIndex,
          accept: this.rawFilters.join(","), okLabel: this.okButtonLabel }, this.context);
        if (!result?.session) return;
        const staging = Services.dirsvc.get("TmpD", Ci.nsIFile);
        staging.append("yore-upload");
        staging.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
        let cancelled = false;
        let streaming = true;
        const cleanup = () => {
          cancelled = true;
          if (streaming) cancel(result.session);
          try { staging.remove(true); } catch {}
        };
        this.window.addEventListener("pagehide", cleanup, { once: true });
        try {
          if (this.mode === 2) {
            if (!result.directory) return;
            this.selected = [await this.stageDirectory(result, staging, () => cancelled)];
          } else {
            if (!result.files?.length) return;
            const files = this.mode === 3 ? result.files : result.files.slice(0, 1);
            const selected = [];
            for (const item of files) {
              if (cancelled) throw new Error("File selection cancelled");
              const file = staging.clone(); file.append(String(item.index));
              await this.writeStreamedFile(file, item, result.session);
              if (cancelled) throw new Error("File selection cancelled");
              const backing = await File.createFromFileName(file.path);
              selected.push(new this.window.File([backing],
                String(item.name).replace(/^.*[\\/]/, ""), {
                  type: item.type, lastModified: item.lastModified,
                }));
            }
            this.selected = selected;
          }
          if (!cancelled) code = Ci.nsIFilePicker.returnOK;
        } catch (error) {
          this.selected = [];
          this.window.removeEventListener("pagehide", cleanup);
          cleanup();
          throw error;
        } finally {
          streaming = false;
          closePicker(result.session);
        }
      } catch (error) { console.error("[embed-file-picker]", error); }
      finally { callback.done(code); }
    });
  }
}
// Gecko asks the embedding for a second, explicit folder-upload confirmation
// after the directory picker completes. Without this service the native input
// discards the selection before it can enumerate the staged tree.
class PromptCollection {
  QueryInterface = ChromeUtils.generateQI(["nsIPromptCollection"]);
  asyncBeforeUnloadCheck() { return Promise.resolve(false); }
  confirmRepost() { return false; }
  confirmFolderUpload(context, directoryName) {
    const reply = request({ kind: "folder-confirm", name: directoryName }, context);
    return reply?.confirmed === true;
  }
}
class ColorPicker {
  QueryInterface = ChromeUtils.generateQI(["nsIColorPicker"]);
  init(context, title, initialColor, defaultColors) {
    Object.assign(this, { context, title, initialColor, defaultColors });
  }
  open(callback) {
    Services.tm.dispatchToMainThread(() => {
      let color = "";
      try {
        const result = request({ kind: "color", title: this.title,
          value: this.initialColor, colors: this.defaultColors }, this.context);
        if (/^#[\da-f]{6}$/i.test(result?.value)) color = result.value.toLowerCase();
      } catch (error) { console.error("[embed-color-picker]", error); }
      finally { callback.done(color); }
    });
  }
}
const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
function register(cid, contract, implementation) {
  registrar.registerFactory(Components.ID(cid), contract, contract, {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    createInstance(iid) { return new implementation().QueryInterface(iid); },
  });
}
register("{7a09bf2e-fdd3-42c0-8a3c-353e232535c7}", "@mozilla.org/filepicker;1", FilePicker);
register("{834fe019-9acb-43db-8070-28180e58c7a1}", "@mozilla.org/colorpicker;1", ColorPicker);
register("{73a402c9-2681-4255-bbe4-90ad54107cd1}", "@mozilla.org/embedcomp/prompt-collection;1", PromptCollection);

export class DateTimePickerChild extends NativeDateTimePickerChild {
  openPickerImpl(input) {
    if (!super.openPickerImpl(input)) return undefined;
    return { value: input.value, min: input.min, max: input.max, step: input.step,
      stepBase: input.getAttribute("value") || "" };
  }
  pickerValueChangedImpl(message, input) {
    // The privileged method used by Gecko's own datetimebox widget. It updates
    // the native editor and fires the engine's normal trusted form events.
    input.setUserInput(message.data.value);
  }
}
export class DateTimePickerParent extends JSWindowActorParent {
  state = null;
  dead = false;
  receiveMessage(message) {
    if (message.name === "InputPicker:Close") { this.cancel(); return; }
    if (message.name !== "InputPicker:Open" || this.state || this.dead) return;
    if (!this.browsingContext.canOpenModalPicker) {
      this.sendAsyncMessage("InputPicker:Closed", {});
      return;
    }
    const state = this.state = {};
    try {
      const { type, detail } = message.data;
      const result = request({ kind: "date", type, ...detail }, this.browsingContext, state);
      if (!this.dead && !state.cancelled && result && typeof result.value === "string") {
        this.sendAsyncMessage("InputPicker:ValueChanged", { value: result.value });
      }
    } catch (error) { console.error("[embed-date-picker]", error); }
    finally {
      this.state = null;
      if (!this.dead) this.sendAsyncMessage("InputPicker:Closed", {});
    }
  }
  cancel() {
    if (this.state) {
      this.state.cancelled = true;
      if (this.state.id) cancel(this.state.id);
    }
  }
  didDestroy() { this.dead = true; this.cancel(); }
}

for (const name of ["UAWidgets", "DateTimePicker"]) {
  try { ChromeUtils.unregisterWindowActor(name); } catch {}
}
ChromeUtils.registerWindowActor("UAWidgets", {
  child: {
    esModuleURI: "resource://gre/actors/UAWidgetsChild.sys.mjs",
    events: { UAWidgetSetupOrChange: {}, UAWidgetTeardown: {} },
  },
  allFrames: true,
});
ChromeUtils.registerWindowActor("DateTimePicker", {
  parent: { esModuleURI: "resource://gre/modules/EmbedPickers.sys.mjs" },
  child: {
    esModuleURI: "resource://gre/modules/EmbedPickers.sys.mjs",
    events: { MozOpenDateTimePicker: {}, MozCloseDateTimePicker: {} },
  },
  allFrames: true,
});
Services.prefs.setBoolPref("dom.forms.datetime.timepicker", true);
// The HTML popup needs Firefox browser chrome. Use our host-backed native
// component instead, retaining Gecko's activation and color-input semantics.
Services.prefs.setBoolPref("dom.forms.html_color_picker.enabled", false);

// In-process windowless content has no browser message manager to deliver
// trusted chrome events. Supply the same missing path as EmbedSelect.
const events = { UAWidgetSetupOrChange: "UAWidgets", UAWidgetTeardown: "UAWidgets",
  MozOpenDateTimePicker: "DateTimePicker", MozCloseDateTimePicker: "DateTimePicker" };
function forwardWindowlessPickerEvent(event) {
  const window = event.target.ownerDocument?.defaultView;
  const context = window?.browsingContext;
  if (!event.isTrusted || !context?.isContent || context.top.embedderElement) return;
  window.windowGlobalChild.getActor(events[event.type]).handleEvent(event);
}
Services.obs.addObserver(window => {
  for (const type of Object.keys(events)) {
    // Stable listener identity: WindowRoot can survive document navigation.
    window.windowRoot.addEventListener(type, forwardWindowlessPickerEvent);
  }
}, "content-document-global-created");
