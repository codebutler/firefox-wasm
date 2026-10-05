// The content-only embedder has no browser.xhtml to own Firefox's select UI.
// Keep Mozilla's SelectChild/SelectParent behavior and supply only that missing
// chrome document. Its native popup widgets use the existing pixel/input bridge.
import {
  SelectParent as DesktopSelectParent,
  SelectParentHelper,
} from "resource://gre/actors/SelectParent.sys.mjs";

let popupBrowser;
let popupWindow;
let popupReady;

function ensurePopupWindow() {
  return (popupReady ??= new Promise((resolve, reject) => {
    popupBrowser = Services.appShell.createWindowlessBrowser(true);
    const shell = popupBrowser.docShell;
    const target = shell.chromeEventHandler;
    const loaded = event => {
      const document = event.target;
      if (document.documentURI !== "chrome://geckoembed/content/select.xhtml") return;
      target.removeEventListener("DOMContentLoaded", loaded, true);
      popupWindow = document.defaultView;
      const base = shell.QueryInterface(Ci.nsIBaseWindow);
      base.setPositionAndSize(0, 0, popupWindow.screen.width, popupWindow.screen.height, Ci.nsIBaseWindow.eRepaint);
      base.visibility = true;
      resolve();
    };
    target.addEventListener("DOMContentLoaded", loaded, true);
    try {
      popupBrowser.loadURI(Services.io.newURI("chrome://geckoembed/content/select.xhtml"), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (error) {
      target.removeEventListener("DOMContentLoaded", loaded, true);
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
    // Loading the chrome document is asynchronous. Keep show/update/hide ordered,
    // and never reopen a popup for an actor destroyed by navigation meanwhile.
    this._pending = this._pending.then(async () => {
      await ensurePopupWindow();
      if (!this._destroyed) super.receiveMessage(message);
    }).catch(error => {
      console.error("[embed-select]", error);
      if (!this._destroyed) this.sendAsyncMessage("Forms:DismissedDropDown", {});
    });
  }

  didDestroy() {
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
