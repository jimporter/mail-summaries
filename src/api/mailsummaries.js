/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
var { ExtensionParent } = ChromeUtils.import(
  "resource://gre/modules/ExtensionParent.jsm"
);
var extension = ExtensionParent.GlobalManager.getExtension(
  "mailsummaries@mozillamessaging.com"
);
var { WindowInjector } = ChromeUtils.import(extension.rootURI.resolve(
  "api/WindowUtils.jsm"
));

function showAccountCentral(window, url) {
  let accountBox = window.document.getElementById("accountCentralBox");
  window.document.getElementById("displayDeck").selectedPanel = accountBox;

  // XXX: Handle various account types.
  window.frames["accountCentralPane"].location.href = url;
}

function summarizeFolder(window, url, messageDisplay) {
  let folder = messageDisplay.folderDisplay.displayedFolder;
  if (!folder) { // A search tab, for example.
    window.gSummaryFrameManager.clear();
    return;
  }

  messageDisplay.singleMessageDisplay = false;
  window.gSummaryFrameManager.loadAndCallback(url, function() {
    // XXX: Initiate the summarization process.
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
        async setAccountCentral(url) {
          injector.inject(
            "accountCentral",
            (window) => {
              const fdw = window.FolderDisplayWidget;
              const oldAccountCentral = fdw.prototype._showAccountCentral;
              fdw.prototype._showAccountCentral = showAccountCentral.bind(
                null, window, context.extension.rootURI.resolve(url)
              );
              return oldAccountCentral;
            },
            (window, data) => {
              window.FolderDisplayWidget.prototype._showAccountCentral = data;
            },
          );
        },

        async setFolderSummary(url) {
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

              window.summarizeFolder = summarizeFolder.bind(
                null, window, context.extension.rootURI.resolve(url)
              );
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
