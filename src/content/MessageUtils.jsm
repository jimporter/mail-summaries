/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["MessageUtils"];

const { classes: Cc, interfaces: Ci } = Components;

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { DisplayNameUtils } = ChromeUtils.import(
  "resource:///modules/DisplayNameUtils.jsm");
const { MailConsts: MC } = ChromeUtils.import(
  "resource:///modules/MailConsts.jsm");
const { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm");
const { MailUtils: MU } = ChromeUtils.import(
  "resource:///modules/MailUtils.jsm");
const { Gloda } = ChromeUtils.import(
  "resource:///modules/gloda/GlodaPublic.jsm");

/**
 * Compose a message to the specified addresses.
 *
 * @param addresses An object of addresses to be added to the compose fields.
 *        Accepts `to`, `cc`, `bcc`, and `newsgroups`.
 * @param server The server to compose from (for getting the sending identity).
 * @param format The message format (one of Ci.nsIMsgCompFormat).
 */
function composeMessageToAddress(addresses, server, format) {
  let fields = Cc["@mozilla.org/messengercompose/composefields;1"]
                 .createInstance(Ci.nsIMsgCompFields);
  let params = Cc["@mozilla.org/messengercompose/composeparams;1"]
                 .createInstance(Ci.nsIMsgComposeParams);

  fields.to = addresses.to;
  fields.cc = addresses.cc;
  fields.bcc = addresses.bcc;
  fields.newsgroups = addresses.newsgroups;

  params.type = Ci.nsIMsgCompType.New;
  params.format = format;
  params.identity = MailServices.accounts.getFirstIdentityForServer(server);
  params.composeFields = fields;

  MailServices.compose.OpenComposeWindowWithParams(null, params);
}

/**
 * Like formatDisplayName, but don't use the "You" shorthand.
 *
 * @param emailAddress The email address to format.
 * @param headerDisplayName The display name from the header, if any (used as a
          fallback).
 * @return The formatted display name.
 */
function formatDisplayNameNoYou(emailAddress, headerDisplayName) {
  let card = DisplayNameUtils.getCardForEmail(emailAddress).card;

  if (card) {
    if (headerDisplayName == emailAddress ||
        card.getProperty("PreferDisplayName", true) != false)
      return card.displayName || headerDisplayName;
  }

  return headerDisplayName;
}

/**
 * Open a message in a new tab.
 *
 * @param msgHdr The header for the message to open.
 * @param viewWrapperToClone A DB view wrapper to clone for the tab.
 * @param tabmail A tambail element to use in case we need to open tabs.
 * @param bgSwap If true, swap the logic of "open in background" from the
 *        default.
 */
function openMessageInTab(msgHdr, viewWrapperToClone, tabmail, bgSwap) {
  openMessagesInTab([msgHdr], viewWrapperToClone, tabmail, bgSwap);
}

/**
 * Open several messages in a new tab.
 *
 * @param msgHdrs The headers for the messages to open.
 * @param viewWrapperToClone A DB view wrapper to clone for the tab.
 * @param tabmail A tambail element to use in case we need to open tabs.
 * @param bgSwap If true, swap the logic of "open in background" from the
 *        default.
 */
function openMessagesInTab(msgHdrs, viewWrapperToClone, tabmail, bgSwap) {
  let bgLoad = Services.prefs.getBoolPref("mail.tabs.loadInBackground");
  if (bgSwap)
    bgLoad = !bgLoad;

  let mail3PaneWindow = null;
  if (!tabmail) {
    // Try opening new tabs in a 3pane window
    let windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"]
                           .getService(Ci.nsIWindowMediator);
    mail3PaneWindow = windowMediator.getMostRecentWindow("mail:3pane");
    if (mail3PaneWindow)
      tabmail = mail3PaneWindow.document.getElementById("tabmail");
  }

  if (tabmail) {
    let i = 0;
    for (let msgHdr of msgHdrs) {
      // Open all the tabs in the background, except for the last one, which
      // is opened according to our preference.
      let background = bgLoad || i < (msgHdrs.length - 1);
      i++;
      tabmail.openTab("message", { msgHdr, viewWrapperToClone, background });
    }
    if (mail3PaneWindow)
      mail3PaneWindow.focus();
  } else {
    // We still haven't found a tabmail, so we'll need to open new windows
    MU.openMessagesInNewWindows(msgHdrs, viewWrapperToClone);
  }
}

/**
 * Display a message in a new tab, new window, or existing window.
 * Note: This is forked from MailUtils.jsm to add `bgSwap`.
 *
 * @param msgHdr The header for the message to open.
 * @param viewWrapperToClone A DB view wrapper to clone for the tab.
 * @param tabmail A tambail element to use in case we need to open tabs.
 * @param bgSwap If true, swap the logic of "open in background" from the
 *        default.
 */
function displayMessage(msgHdr, viewWrapperToClone, tabmail, bgSwap) {
  displayMessages([msgHdr], viewWrapperToClone, tabmail, bgSwap);
}

/**
 * Display several messages in a new tab, new window, or existing window.
 * Note: This is forked from MailUtils.jsm to add `bgSwap`.
 *
 * @param msgHdrs The headers for the messages to open.
 * @param viewWrapperToClone A DB view wrapper to clone for the tab.
 * @param tabmail A tambail element to use in case we need to open tabs.
 * @param bgSwap If true, swap the logic of "open in background" from the
 *        default.
 */
function displayMessages(msgHdrs, viewWrapperToClone, tabmail, bgSwap) {
  let openMsgBehavior = Services.prefs.getIntPref("mail.openMessageBehavior");

  if (openMsgBehavior === MC.OpenMessageBehavior.NEW_WINDOW) {
    MU.openMessagesInNewWindows(msgHdrs, viewWrapperToClone);
  } else if (openMsgBehavior === MC.OpenMessageBehavior.EXISTING_WINDOW) {
    // Try reusing an existing window. If we can't, fall back to opening new
    // windows.
    if (msgHdrs.length > 1 || !MU.openMessageInExistingWindow(msgHdrs[0]))
      MU.openMessagesInNewWindows(msgHdrs, viewWrapperToClone);
  } else if (openMsgBehavior === MC.OpenMessageBehavior.NEW_TAB) {
    openMessagesInTab(msgHdrs, viewWrapperToClone, tabmail, bgSwap);
  }
}

/**
 * Add a command listener to an element. This allows handling mouse clicks or
 * Enter presses as commands.
 *
 * @param node The element to add the event to.
 * @param oncommand The command listener function.
 */
function addCommandListener(node, oncommand) {
  node.addEventListener("mousedown", function(event) {
    event.target.focus();
    event.preventDefault();
  }, false);
  node.addEventListener("mouseup", oncommand, false);
  node.addEventListener("keypress", function(event) {
    if (event.keyCode === 13)
      return oncommand(event);
    return null;
  }, false);
}

/**
 * Manage a context menu in a summary pane.
 * FIXME: This is currently broken due to Thunderbird dropping support for
 * content-context menus.
 */
class ContextMenu {
  /**
   * Create a new ContextMenu object.
   *
   * @param menu The menu element.
   * @param events An object to listen for context menu events.
   * @param showMethodName The name of the method to fire when showing the
            context menu.
   */
  constructor(menu, events, showMethodName) {
    this.menu = menu;
    if (showMethodName === undefined)
      showMethodName = "showContextMenu";

    for (let item of this.menu.querySelectorAll("[data-action]")) {
      let method = "context" + item.dataset.action;
      item.addEventListener("click", (event) => {
        event.triggerNode = this.triggerNode;
        events[method].call(events, event);
      });
    }

    if (events[showMethodName]) {
      this.menu.addEventListener("show", (event) => {
        event.triggerNode = this.triggerNode;
        events[showMethodName].call(events, event);
      });
    }
  }

  /**
   * Get the ID of this context menu.
   */
  get id() {
    return this.menu.id;
  }

  /**
   * Get the context menu item associated with a particular action.
   *
   * @param action The action name.
   * @return The context menu item.
   */
  item(action) {
    return this.menu.querySelector("[data-action=\"" + action + "\"]");
  }
}

/**
 * Add a context menu handler to an element.
 *
 * @param node The element to add the handler to.
 * @param contextMenu The ContextMenu object.
 */
function addContextMenu(node, contextMenu) {
  node.setAttribute("contextmenu", contextMenu.id);
  node.addEventListener("contextmenu", function(event) {
    event.triggerNode = contextMenu.triggerNode = node;
  }, false);
}

/**
 * Add a tooltip when an element's text overflows its container.
 *
 * @param node The element to handle overflow on.
 */
function addOverflowTooltip(node) {
  node.addEventListener("overflow", function() {
    this.title = this.textContent;
  }, false);
  node.addEventListener("underflow", function() {
    this.title = "";
  }, false);
}

/**
 * Check if a message is indexed by Gloda.
 *
 * @param message The message to check.
 * @return true if the message is indexed by Gloda, false otherwise.
 */
function isMessageIndexed(message) {
  return Services.prefs.getBoolPref(
    "mailnews.database.global.indexer.enabled"
  ) && Gloda.isMessageIndexed(message);
}

const MessageUtils = {
  composeMessageToAddress,
  formatDisplayNameNoYou,
  openMessageInTab,
  openMessagesInTab,
  displayMessage,
  displayMessages,
  addCommandListener,
  ContextMenu,
  addContextMenu,
  addOverflowTooltip,
  isMessageIndexed,
};
