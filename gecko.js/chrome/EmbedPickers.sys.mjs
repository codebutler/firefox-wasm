// Native input pickers for a windowless embedding. Gecko owns activation,
// validation, FileList and trusted input/change/cancel events; the host supplies
// only the UI and the bytes of files the user explicitly selected.
import { DateTimePickerChild as NativeDateTimePickerChild } from
  "resource://gre/actors/DateTimePickerChild.sys.mjs";

Cu.importGlobalProperties(["File", "atob"]);
let nextId = 0;
function cancel(id) {
  Services.obs.notifyObservers(null, "gecko-embed-picker-cancel", id);
}
function request(data, context, state = {}) {
  const id = String(++nextId);
  state.id = id;
  const window = context?.currentWindowGlobal?.domWindow;
  const pagehide = () => { state.cancelled = true; cancel(id); };
  window?.addEventListener("pagehide", pagehide, { once: true });
  try {
    const result = Cc["@mozilla.org/variant;1"].createInstance(Ci.nsIWritableVariant);
    result.setAsAUTF8String("null");
    Services.obs.notifyObservers(result, "gecko-embed-picker", JSON.stringify({ ...data, id }));
    return state.cancelled ? null : JSON.parse(result.getAsAUTF8String());
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
  init(context, title, mode) { Object.assign(this, { context, title, mode }); }
  isModeSupported(mode) { return Promise.resolve(mode === 0 || mode === 3); }
  appendFilters(mask) { if (mask & Ci.nsIFilePicker.filterAll) this.filters.push({ title: "All files", pattern: "*" }); }
  appendFilter(title, pattern) { this.filters.push({ title, pattern }); }
  appendRawFilter(filter) { this.rawFilters.push(filter); }
  get file() { return null; }
  get fileURL() { return null; }
  get files() { return enumerator([]); }
  get domFileOrDirectory() { return this.selected[0] || null; }
  get domFileOrDirectoryEnumerator() { return enumerator(this.selected); }
  get domFilesInWebKitDirectory() { return enumerator([]); }
  open(callback) {
    // The interface is asynchronous: don't enter a nested event loop before
    // HTMLInputElement has finished recording that a picker is open.
    Services.tm.dispatchToMainThread(() => {
      let code = Ci.nsIFilePicker.returnCancel;
      try {
        if (this.mode !== 0 && this.mode !== 3) return;
        const result = request({ kind: "file", title: this.title,
          multiple: this.mode === 3, filters: this.filters, filterIndex: this.filterIndex,
          accept: this.rawFilters.join(","), okLabel: this.okButtonLabel }, this.context);
        if (!result?.files?.length) return;
        const files = this.mode === 3 ? result.files : result.files.slice(0, 1);
        this.selected = files.map(file => {
          const raw = atob(file.base64);
          const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
          return new File([bytes], file.name.replace(/^.*[\\/]/, ""), {
            type: file.type, lastModified: file.lastModified,
          });
        });
        code = Ci.nsIFilePicker.returnOK;
      } catch (error) { console.error("[embed-file-picker]", error); }
      finally { callback.done(code); }
    });
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

// In-process windowless content has no browser message manager to deliver
// trusted chrome events. Supply the same missing path as EmbedSelect.
const events = { UAWidgetSetupOrChange: "UAWidgets", UAWidgetTeardown: "UAWidgets",
  MozOpenDateTimePicker: "DateTimePicker", MozCloseDateTimePicker: "DateTimePicker" };
Services.obs.addObserver(window => {
  for (const [type, actor] of Object.entries(events)) {
    window.windowRoot.addEventListener(type, event => {
      const targetWindow = event.target.ownerDocument?.defaultView;
      const context = targetWindow?.browsingContext;
      if (!event.isTrusted || !context?.isContent || context.top.embedderElement) return;
      targetWindow.windowGlobalChild.getActor(actor).handleEvent(event);
    });
  }
}, "content-document-global-created");
