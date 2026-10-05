// The content-only embedder has no browser.xhtml to own Firefox's select UI.
// Keep Mozilla's SelectChild/SelectParent behavior and supply only that missing
// chrome document. Its native popup widgets use the existing pixel/input bridge.
import {
  SelectParent as DesktopSelectParent,
  SelectParentHelper,
} from "resource://gre/actors/SelectParent.sys.mjs";

const trace = (...values) => {
  if (Services.env.get("GECKO_SELECT_DEBUG")) console.info("[embed-select]", ...values);
};

let popupBrowser;
let popupWindow;
let popupReady;

function ensurePopupWindow() {
  return (popupReady ??= new Promise((resolve, reject) => {
    popupBrowser = Services.appShell.createWindowlessBrowser(true);
    const shell = popupBrowser.docShell;
    trace("create popup window");
    // A standalone docshell has no chromeEventHandler. Its outer window owns
    // a WindowRoot that survives the initial about:blank navigation.
    const target = shell.domWindow.windowRoot;
    // DOMContentLoaded runs before the initial presentation shell is ready.
    // Native openPopupAtScreenRect needs that shell, so wait for full load.
    const loaded = event => {
      const document = event.target;
      trace("document loaded", document.documentURI);
      if (document.documentURI !== "chrome://geckoembed/content/select.xhtml") return;
      target.removeEventListener("load", loaded, true);
      popupWindow = document.defaultView;
      const base = shell.QueryInterface(Ci.nsIBaseWindow);
      base.setPositionAndSize(0, 0, popupWindow.screen.width, popupWindow.screen.height, Ci.nsIBaseWindow.eRepaint);
      base.visibility = true;
      shell.browsingContext.isActive = true;
      trace("popup window ready", popupWindow.screen.width, popupWindow.screen.height);
      resolve();
    };
    target.addEventListener("load", loaded, true);
    try {
      popupBrowser.loadURI(Services.io.newURI("chrome://geckoembed/content/select.xhtml"), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (error) {
      target.removeEventListener("load", loaded, true);
      popupBrowser.close();
      popupBrowser = null;
      popupReady = null;
      reject(error);
    }
  }));
}

export class SelectParent extends DesktopSelectParent {
  _pending = Promise.resolve();
  _destroyed = false;

  get relevantBrowser() {
    // SelectParentHelper explicitly supports a window without a tab browser.
    return null;
  }

  get _document() {
    return popupWindow.document;
  }

  receiveMessage(message) {
    trace("receive", message.name, "destroyed", this._destroyed);
    // Loading the chrome document is asynchronous. Keep show/update/hide ordered,
    // and never reopen a popup for an actor destroyed by navigation meanwhile.
    this._pending = this._pending.then(async () => {
      await ensurePopupWindow();
      if (!this._destroyed) {
        trace("dispatch", message.name, "canOpen", this.browsingContext.canOpenModalPicker);
        super.receiveMessage(message);
        trace("popup state", this._menulist?.menupopup?.state);
      }
    }).catch(error => {
      console.error("[embed-select]", error);
      if (!this._destroyed) this.sendAsyncMessage("Forms:DismissedDropDown", {});
    });
  }

  didDestroy() {
    trace("destroy actor");
    this._destroyed = true;
    if (popupWindow && SelectParentHelper._actor === this) {
      SelectParentHelper.hide(this._menulist, null);
    }
  }

  sendAsyncMessage(name, data) {
    if (!this._destroyed) super.sendAsyncMessage(name, data);
  }
}

// The minimal embedding doesn't run MainProcessSingleton/BrowserGlue. Register
// this one actor explicitly, replacing a toolkit registration if startup made it.
try { ChromeUtils.unregisterWindowActor("Select"); } catch {}
ChromeUtils.registerWindowActor("Select", {
  parent: { esModuleURI: "resource://gre/modules/EmbedSelect.sys.mjs" },
  child: {
    esModuleURI: "resource://gre/actors/SelectChild.sys.mjs",
    events: {
      mozshowdropdown: {},
      "mozshowdropdown-sourcetouch": {},
      mozhidedropdown: { mozSystemGroup: true },
    },
  },
  includeChrome: true,
  allFrames: true,
});

// JSWindowActorProtocol deliberately ignores content events on WindowRoot in
// the parent process: Firefox normally delivers those through its in-process
// browser message manager. A standalone windowless browser has no such manager.
// Supply that missing delivery path only for trusted, unembedded content events.
function forwardWindowlessSelectEvent(event) {
  const window = event.target.ownerDocument?.defaultView;
  const context = window?.browsingContext;
  if (!event.isTrusted || !context?.isContent || context.top.embedderElement) return;
  trace("windowless event", event.type);
  window.windowGlobalChild.getActor("Select").handleEvent(event);
}

function attachSelectEvents(root) {
  root.addEventListener("mozshowdropdown", forwardWindowlessSelectEvent);
  root.addEventListener("mozshowdropdown-sourcetouch", forwardWindowlessSelectEvent);
  root.addEventListener("mozhidedropdown", forwardWindowlessSelectEvent, { mozSystemGroup: true });
}

Services.obs.addObserver(window => attachSelectEvents(window.windowRoot),
  "content-document-global-created");
