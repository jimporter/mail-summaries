/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { ExtensionParent } = ChromeUtils.import(
  "resource://gre/modules/ExtensionParent.jsm"
);
const extension = ExtensionParent.GlobalManager.getExtension(
  "mailsummaries@mozillamessaging.com"
);

class WindowInjector {
  constructor(windowType) {
    this.windowType = windowType;
    this._windowMap = new WeakMap();
    this._listeners = new Map();
    let enumerator = Services.wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) {
      let window = enumerator.getNext();
      if (this.isWindowRelevant(window))
        this._windowMap.set(window, new Map());
    }

    let self = this;
    this._listener = {
      onOpenWindow(xulWindow) {
        self._setupWindow(xulWindow.docShell.domWindow);
      },
      onCloseWindow(xulWindow) {
        self._forgetWindow(xulWindow.docShell.domWindow);
      },
      onWindowTitleChange(xulWindow, title) {},
    };
    Services.wm.addListener(this._listener);
  }

  inject(id, setup, cleanup) {
    this._listeners.set(id, {setup, cleanup});

    let enumerator = Services.wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) {
      let window = enumerator.getNext();
      if (this.isWindowRelevant(window))
        this._windowMap.get(window).set(id, setup(window));
    }
  }

  isWindowRelevant(window) {
    let windowType = window.document.documentElement.getAttribute("windowtype");
    return windowType === this.windowType;
  }

  stop() {
    let enumerator = Services.wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) {
      let window = enumerator.getNext();
      this._cleanupWindow(window);
    }

    Services.wm.removeListener(this._listener);
  }

  _runSetup(window, callback) {
    if (window.document.readyState == "complete") {
      callback(window);
    } else {
      window.addEventListener("load", function onload() {
        window.removeEventListener("load", onload);
        callback(window);
      });
    }
  }

  _setupWindow(window) {
    this._runSetup(window, (window) => {
      if (!this.isWindowRelevant(window))
        return;
      let result = new Map();
      for (let [k, v] of this._listeners)
        result.set(k, v.setup(window));
      this._windowMap.set(window, result);
    });
  }

  _cleanupWindow(window) {
    if (!this.isWindowRelevant(window))
      return;
    for (let [k, v] of this._windowMap.get(window)) {
      this._listeners.get(k).cleanup(window, v);
    }
  }

  _forgetWindow(window) {
    this._windowMap.delete(window);
  }
}

function summarizeFolder(window, messageDisplay) {
  const url = "chrome://mailsummaries/content/folderSummary.xhtml";

  let folder = messageDisplay.folderDisplay.displayedFolder;
  if (!folder) { // A search tab, for example.
    window.gSummaryFrameManager.clear();
    return;
  }

  messageDisplay.singleMessageDisplay = false;
  window.gSummaryFrameManager.loadAndCallback(url, function() {
    let childWindow = window.gSummaryFrameManager.iframe.contentWindow;
    childWindow.gFolderSummary.summarize(folder);
  });
}

// We want to reload the folder summary when we click again on the currently-
// selected folder. This requires keeping track of what the current folder was
// during mousedown and then comparing to that once the click is finished.
class FolderPaneClickHandler {
  constructor(window) {
    this._window = window;
    this._lastSelectedFolder = null;
  }

  load() {
    this._listen(true);
  }

  unload() {
    this._listen(false);
  }

  handleEvent(event) {
    if (event.button != 0)
      return;

    let folderDisplay = this._window.gFolderDisplay;
    if (event.type == "mousedown") {
      this._lastSelectedFolder = folderDisplay.displayedFolder;
    }
    else if (event.type == "click") {
      let folderTree = this._window.document.getElementById("folderTree");
      let {row, childElt} = folderTree.getCellAt(event.clientX, event.clientY);

      if (row != -1 && childElt && childElt != "twisty") {
        if (this._lastSelectedFolder == folderDisplay.displayedFolder)
          folderDisplay.clearSelection();
      }
    }
  }

  _listen(add) {
    let method = add ? "addEventListener" : "removeEventListener";
    let folderTree = this._window.document.getElementById("folderTree");
    folderTree[method]("click", this, true);
    folderTree[method]("mousedown", this, true);
  }
}

// Sometimes, an onSelectedMessagesChanged isn't fired when we select a new
// folder, so kick off a summary here too.
class FolderDisplayListener {
  constructor(window) {
    this._window = window;
  }

  onDisplayingFolder() {
    this._window.gFolderDisplay.messageDisplay.onSelectedMessagesChanged();
  }
}

var injector;

var mailsummaries = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      mailsummaries: {
        async setupFolderSummary() {
          injector.inject(
            "folderSummary",
            (window) => {
              let folderDisplayListener = new FolderDisplayListener(window);
              let folderPaneClickHandler = new FolderPaneClickHandler(window);
              let data = {
                summarizeFolder: window.summarizeFolder,
                folderDisplayListener: folderDisplayListener,
                folderPaneClickHandler: folderPaneClickHandler,
              };

              window.summarizeFolder = summarizeFolder.bind(null, window);
              window.FolderDisplayListenerManager.registerListener(
                folderDisplayListener
              );
              folderPaneClickHandler.load();

              return data;
            },
            (window, data) => {
              window.summarizeFolder = data.summarizeFolder;
              window.FolderDisplayListenerManager.unregisterListener(
                data.folderDisplayListener
              );
              data.folderPaneClickHandler.unload();
            },
          );
          const window = Services.wm.getMostRecentWindow("mail:3pane");
        }
      }
    };
  }

  onStartup() {
    console.log("mailsummaries API startup");
    injector = new WindowInjector("mail:3pane");

    const aomStartup = Cc[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Ci.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(
      "manifest.json", null, this.extension.rootURI
    );
    this.chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "mailsummaries", "content/"],
      ["locale", "mailsummaries", "en-US", "locale/en-US/"],
      ["locale", "mailsummaries", "cs-CZ", "locale/cs-CZ/"],
      ["locale", "mailsummaries", "de", "locale/de/"],
      ["locale", "mailsummaries", "fr", "locale/fr/"],
      ["locale", "mailsummaries", "ro", "locale/ro/"],
    ]);
  }

  onShutdown() {
    console.log("mailsummaries API shutdown");
    try {
      injector.stop();
    } catch(e) {}

    // Unload any modules we own.
    const rootURI = this.extension.rootURI.spec;
    for (let module of Components.utils.loadedModules) {
      if (module.startsWith(rootURI)) {
        Components.utils.unload(module);
      }
    }
    Services.obs.notifyObservers(null, "startupcache-invalidate", null);
  }
};
