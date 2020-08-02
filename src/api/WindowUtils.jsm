/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["WindowInjector"];

var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

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
