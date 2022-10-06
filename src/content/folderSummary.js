/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm");
const { DisplayNameUtils } = ChromeUtils.import(
  "resource:///modules/DisplayNameUtils.jsm");
const { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm");
const { MailUtils } = ChromeUtils.import("resource:///modules/MailUtils.jsm");
const { PluralStringFormatter } = ChromeUtils.import(
  "resource:///modules/TemplateUtils.jsm");

const { MessageUtils } = ChromeUtils.import(
  "chrome://mailsummaries/content/MessageUtils.jsm");
const { Stats } = ChromeUtils.import(
  "chrome://mailsummaries/content/Stats.jsm");

// Since this is executed in the context of the account summary page, not main
// chrome, we need to use some globals from our parent.
var global = window.browsingContext.topChromeWindow;

function debugLog(str) {
  /* FIXME: Services.prefs.getBoolPref("extensions.mailsummaries.debug")) */
  if (true)
    console.log("[folder summary]", str);
}

// Set up our string formatter for localizing strings.
XPCOMUtils.defineLazyGetter(this, "formatString", function() {
  let formatter = new PluralStringFormatter(
    "chrome://mailsummaries/locale/folderSummary.properties"
  );
  return function() {
    return formatter.get.apply(formatter, arguments);
  };
});

class FolderSummary {
  /**
   * Create the folder summary object.
   */
  constructor() {
    this._analyzers = [];
    this.folder = null;
    this._timeoutId = null;
  }

  // The various modes the folder summary can be in, in order of descending
  // importance.
  _modes = [
    {name: "loading", enabled: false},
    {name: "empty",   enabled: false},
    {name: "content", enabled: false},
  ];

  /**
   * Set the view mode for the folder summary.
   *
   * @param modeName one of the names in the _modes array above
   * @param enabled true if the mode should be shown (only when it is the
   *        highest-priority enabled mode), false if it should be hidden
   */
  _setMode(modeName, enabled) {
    let foundActive = false;
    for (let mode of this._modes) {
      if (mode.name == modeName)
        mode.enabled = enabled;

      let elements = document.getElementsByClassName("mode_" + mode.name);
      if (!foundActive && mode.enabled) {
        foundActive = true;
        for (let element of elements)
          element.classList.remove("hidden");
      } else {
        for (let element of elements)
          element.classList.add("hidden");
      }
    }
  }

  /**
   * Register a new folder analyzer.
   *
   * @param analyzer the analyzer object
   */
  registerAnalyzer(analyzer) {
    this._analyzers.push(analyzer);
    analyzer.onregistered(this);
  }

  /**
   * Determine whether the current folder is virtual or not.
   *
   * @return true if the folder is virtual, false otherwise.
   */
  get isVirtualFolder() {
    return this.folder.isSpecialFolder(Ci.nsMsgFolderFlags.Virtual);
  }

  /**
   * Determine whether the current folder is an outgoing one or not.
   *
   * @return true if the folder is outgoing, false otherwise.
   */
  get isOutgoingFolder() {
    const outgoingFlags =
      Ci.nsMsgFolderFlags.SentMail | Ci.nsMsgFolderFlags.Drafts |
      Ci.nsMsgFolderFlags.Templates | Ci.nsMsgFolderFlags.Queue;
    return this.folder.isSpecialFolder(outgoingFlags);
  }

  /**
   * Process all the messages in this folder and forward them on to the
   * analyzers. Note that this only processes the N most recent messages to
   * minimize processing time.
   *
   * @param uninit true if we should uninitialize the analyzers first (e.g. when
   *        reprocessing an already-open folder
   */
  processFolder(uninit) {
    debugLog("processing messages...");
    if (uninit) {
      for (let analyzer of this._analyzers)
        analyzer.uninit();
    }

    // Virtual folders require some special handling. We don't want to process
    // any messages until the search has finished, but it may have finished
    // before we get here!
    if (this.isVirtualFolder) {
      if (global.gFolderDisplay.view.dbView &&
          !global.gFolderDisplay.view.searching) {
        debugLog("immediate virtual");
        this.onMessagesLoaded(global.gFolderDisplay, true);
      } else {
        debugLog("callback virtual");
        global.FolderDisplayListenerManager.registerListener(this);
        this._setMode("loading", true);
      }
    } else {
      debugLog("regular");

      // Get all the nsMsgKeys in the folder as a JS array (it's slightly faster
      // to iterate over).
      let db = this.folder.msgDatabase;
      let keys = db.listAllKeys();

      // Get nsIMsgDBHdrs for all the keys and cache their dates to minimize the
      // number of times we cross xpconnect when we sort the headers. XXX: it
      // might make sense to break this up into deferred chunks if it turns out
      // this is still too slow for very large folders.
      let messages = new Array(keys.length);
      let dates = new Map();
      for (let i = 0; i < messages.length; i++) {
        messages[i] = db.GetMsgHdrForKey(keys[i]);
        dates.set(messages[i], messages[i].date);
      }

      messages.sort((a, b) => dates.get(b) - dates.get(a));
      this._processMessages(messages);
    }
  }

  /**
   * Cancel any running message processing queues.
   */
  cancelProcessing() {
    if (this._timeoutId !== null)
      window.clearTimeout(this._timeoutId);
  }

  /**
   * Process the messages in this folder. Since this can take a long time for
   * extremely large folders, we do this in small batches so as not to lock up
   * the UI.
   *
   * @param messages An array of messages in the folder.
   */
  _processMessages(messages) {
    /* FIXME: Services.prefs.getIntPref(
       "extensions.mailsummaries.max_messages"); */
    let maxMessages = 1000;
    if (messages.length > maxMessages)
      messages.length = maxMessages;

    let gen = this._processMessagesWorker(messages);
    let self = this;
    let then = Date.now();

    function defer(first) {
      if (gen.next().done) {
        self._timeoutId = null;
        gen.return();
        debugLog("folder summary took " + (Date.now() - then) / 1000 +
                 " seconds");
      } else {
        if (first)
          self._setMode("loading", true);
        self._timeoutId = window.setTimeout(() => defer(), 0);
      }
    }

    this.cancelProcessing();
    defer(true);
  }

  /**
   * Do the actual work for message processing. There are three phases of
   * processing, executed on each analyzer. The first phase is just
   * initializing whatever data structures are needed. In the second phase, a
   * function is called once per message. Finally, the third phase handles
   * the rendering.
   *
   * @param messages An array of messages in the folder.
   */
  *_processMessagesWorker(messages) {
    // Use microseconds here.
    let maxDate = Date.now() * 1000;
    this.numDays = 30;
    this.minDate = maxDate - this.numDays * 24 * 60 * 60 * 1000000;
    this.loading = true;

    for (let analyzer of this._analyzers) {
      analyzer.init(this);
    }

    let i = 1;
    for (let message of messages) {
      if ((i++) % 100 == 0) yield undefined;
      if (this._processMessage(message))
        return;
    }

    this._setMode("loading", false);
    this._setMode("content", true);

    for (let analyzer of this._analyzers)
      analyzer.render();

    this.loading = false;
  }

  /**
   * Process a single message.
   *
   * @param message The nsIMsgDBHdr for the message.
   * @param deleted true if the message was deleted, false otherwise.
   * @return true if a full reprocess was requested and queued.
   */
  _processMessage(message, deleted) {
    // Don't process killed messages unless we're counting them as deleted.
    let isKilled = false;
    try {
      isKilled = message.isKilled;
    } catch(e) {}

    if (isKilled && !deleted)
      return false;

    let reprocess = false;

    if (message.date > this.minDate) {
      for (let analyzer of this._analyzers) {
        if (analyzer.processRecentMessage &&
            analyzer.processRecentMessage(message, deleted)) {
          reprocess = true;
          break;
        }
      }
    }

    for (let analyzer of this._analyzers) {
      if (analyzer.processMessage &&
          analyzer.processMessage(message, deleted)) {
        reprocess = true;
        break;
      }
    }

    if (reprocess) {
      let self = this;
      window.setTimeout(() => self.processFolder(true), 0);
    }
    return reprocess;
  }

  /**
   * Update the total and unread message counts for this folder.
   */
  updateMessageCounts() {
    let numTotal = this.folder.getTotalMessages(false);
    let numUnread = this.folder.getNumUnread(false);
    let messageCount = document.getElementById("messageCount");
    messageCount.textContent = formatString(
      "messageCount", [numTotal.toLocaleString()], numTotal
    );

    this._setMode("empty", numTotal == 0);

    if (numUnread) {
      messageCount.textContent += formatString(
        "unreadCount", [numUnread.toLocaleString()], numUnread
      );
    }
  }

  /**
   * Start the summarization process for the folder.
   *
   * @param folder The folder to summarize.
   */
  summarize(folder) {
    if (this.folder === folder)
      return;
    if (this.folder)
      this._onUnload();
    this.folder = folder;

    debugLog("Loading folder summary for " + this.folder.name);

    // Set up the unload listener for the folder summary pane. This can be
    // unloaded in one of two ways: 1) by being hidden (when switching to a
    // non-folder summary view), or 2) by listening to the "unload" event (when
    // switching to a different folder's summary).
    this._unloadFunc = (e) => {
      this._onUnload();
    };
    window.addEventListener("unload", this._unloadFunc, false);

    let title = document.getElementById("folderName");
    title.textContent = this.folder.prettyName;

    // Figure out whether Thunderbird is in vertical layout or not and set some
    // CSS to adjust the layout of the multi_row if so.
    let layout = Services.prefs.getIntPref("mail.pane_config.dynamic");
    let content = document.getElementById("content");
    if (layout === 2) // Vertical view.
      content.classList.add("vertical");
    else
      content.classList.remove("vertical");

    this.updateMessageCounts();
    this._addListeners();
    this.processFolder();

    Services.obs.addObserver(this, "mailsummaries:markAllReadStarted", false);
    Services.obs.addObserver(this, "mailsummaries:markAllReadFinished", false);
  }

  /**
   * Unload the folder summary, cleaning up widgets and unhooking event
   * listeners.
   */
  _onUnload() {
    debugLog("Unloading folder summary");

    this.cancelProcessing();
    for (let analyzer of this._analyzers)
      analyzer.uninit();

    this._removeListeners();
    this.folder = null;

    window.removeEventListener("unload", this._unloadFunc, false);

    Services.obs.removeObserver(this, "mailsummaries:markAllReadStarted");
    Services.obs.removeObserver(this, "mailsummaries:markAllReadFinished");
  }

  /**
   * Update analyzers (probably making them re-render their content), assuming
   * we've finished processing messages.
   */
  _updateAnalyzers() {
    if (!this.loading) {
      for (let analyzer of this._analyzers) {
        if (analyzer.update)
          analyzer.update();
      }
    }
  }

  /**
   * Add the listeners we need to keep up-to-date on changes in this folder.
   */
  _addListeners() {
    if (this.isVirtualFolder) {
      // Register the folder listener to watch for added/deleted messages,
      // message status changes, and changes to total/unread counts.
      let notifyFlags = Ci.nsIFolderListener.added |
                        Ci.nsIFolderListener.removed |
                        Ci.nsIFolderListener.intPropertyChanged |
                        Ci.nsIFolderListener.propertyFlagChanged;
      MailServices.mailSession.AddFolderListener(this, notifyFlags);
    } else {
      // Register the folder listener to watch for changes to total/unread
      // counts, and the DB change listener to watch for added/deleted messages,
      // and message status changes.
      let notifyFlags = Ci.nsIFolderListener.intPropertyChanged |
                        Ci.nsIFolderListener.propertyFlagChanged;
      MailServices.mailSession.AddFolderListener(this, notifyFlags);
      this.folder.msgDatabase.AddListener(this);
    }
  }

  /**
   * Remove the listeners we were using on this folder.
   */
  _removeListeners() {
    MailServices.mailSession.RemoveFolderListener(this);
    if (!this.isVirtualFolder)
      this.folder.msgDatabase.RemoveListener(this);
  }

  /***** nsIObserver methods *****/

  observe(subject, topic, data) {
    try {
      subject.QueryInterface(Ci.nsIArray).indexOf(0, this.folder);
    } catch(e) {
      // We weren't one of the modified folders. Just return.
      return;
    }

    if (topic == "mailsummaries:markAllReadStarted") {
      this.cancelProcessing();
      this._removeListeners();
    } else if (topic == "mailsummaries:markAllReadFinished") {
      this._addListeners();
      this.processFolder(true);
      this.updateMessageCounts();
    }
  }

  /***** nsIDBChangeListener methods *****/

  /**
   * Called when the flags on a message are changed.
   *
   * @param message The message whose flags have changed.
   * @param oldFlags The old flags for the message (as a bitset).
   * @param newFlags The new flags for the message (as a bitset).
   * @param instigator The cause of this change.
   */
  onHdrFlagsChanged(message, oldFlags, newFlags, instigator) {
    try {
      // First, check if we killed or unkilled a thread; if so, add or delete
      // the message as appropriate. XXX: this feature doesn't work with virtual
      // folders.
      if ( (oldFlags & Ci.nsMsgMessageFlags.Ignored) &&
          !(newFlags & Ci.nsMsgMessageFlags.Ignored) ) {
        this.onHdrAdded(message, message.threadParent, newFlags, instigator);
      } else if (!(oldFlags & Ci.nsMsgMessageFlags.Ignored) &&
                (newFlags & Ci.nsMsgMessageFlags.Ignored) ) {
        this.onHdrDeleted(message, message.threadParent, newFlags, instigator);
      } else {
        for (let analyzer of this._analyzers) {
          if (analyzer.updateMessageFlags &&
              analyzer.updateMessageFlags(message, oldFlags, newFlags)) {
            this.processFolder(true);
            return;
          }
        }

        this._updateAnalyzers();
      }
    } catch (e) {
      Cu.reportError(e);
    }
  }

  /**
   * Called when a message has been deleted.
   *
   * @param message The message that has been deleted.
   * @param parentKey The key for the parent of the message.
   * @param flags The flags for the message (as a bitset).
   * @param instigator The cause of this change.
   */
  onHdrDeleted(message, parentKey, flags, instigator) {
    try {
      if (this._processMessage(message, true))
        return;
      this._updateAnalyzers();
    } catch (e) {
      Cu.reportError(e);
    }
  }

  /**
   * Called when a message has been added.
   *
   * @param message The message that has been added.
   * @param parentKey The key for the parent of the message.
   * @param flags The flags for the message (as a bitset).
   * @param instigator The cause of this change.
   */
  onHdrAdded(message, parentKey, flags, instigator) {
    try {
      if (this._processMessage(message))
        return;
      this._updateAnalyzers();
    } catch (e) {
      Cu.reportError(e);
    }
  }

  onParentChanged() {}
  onAnnouncerGoingAway() {}
  onReadChanged() {}
  onJunkScoreChanged() {}
  onHdrPropertyChanged(message, preChange, status, instigator) {}
  onEvent() {}

  /****** nsIFolderListener methods *****/

  /**
   * Called when an item is added to the virtual folder (we only care about
   * messages).
   *
   * @param parent The parent of the new item (an nsIMsgFolder).
   * @param item The new item.
   */
  OnItemAdded(parent, item) {
    if (parent === this.folder) {
      try {
        let message = item.QueryInterface(Ci.nsIMsgDBHdr);
        this.onHdrAdded(message);
      } catch (e) {}
    }
  }

  /**
   * Called when an item is removed from the virtual folder (we only care about
   * messages).
   *
   * @param parent The parent of the new item (an nsIMsgFolder).
   * @param item The deleted item.
   */
  OnItemRemoved(parent, item) {
    if (parent === this.folder) {
      try {
        let message = item.QueryInterface(Ci.nsIMsgDBHdr);
        this.onHdrDeleted(message);
      } catch (e) {}
    }
  }

  /**
   * Called when a property is changed on the folder.
   *
   * @param item The item whose property has been changed.
   * @param property The name of the property that changed.
   * @param oldValue The property's old value.
   * @param newValue The property's new value.
   */
  OnItemIntPropertyChanged(item, property, oldValue, newValue) {
    if (item === this.folder) {
      if (property.toString() === "TotalMessages" ||
          property.toString() === "TotalUnreadMessages")
        this.updateMessageCounts();
    }
  }

  /**
   * Called when the flags on a message in a virtual folder are changed.
   *
   * @param message The message whose flags have changed.
   * @param property The property being changed (we only care about "Keywords"
   *        and "Status").
   * @param oldFlags The old flags for the message (as a bitset).
   * @param newFlags The new flags for the message (as a bitset).
   */
  OnItemPropertyFlagChanged(message, property, oldFlags, newFlags) {
    if (property === "Keywords") {
      for (let analyzer of this._analyzers) {
        if (analyzer.updateMessageTags && analyzer.updateMessageTags(message)) {
          this.processFolder(true);
          return;
        }
      }

      this._updateAnalyzers();
    } else if (property === "Status" && this.isVirtualFolder) {
      // If this message isn't in the current folder, just ignore it.
      const NOT_FOUND = 4294967295;
      if (global.gFolderDisplay.view.dbView.findIndexOfMsgHdr(message, true) ==
          NOT_FOUND)
        return;

      this.onHdrFlagsChanged(message, oldFlags, newFlags);
    }
  }

  /***** FolderDisplayListener methods *****/

  /**
   * Called when messages are loaded in the folder, currently used to process
   * messages in virtual folders.
   *
   * @param folderDisplay The folder display object.
   * @param isAll true if all messages have been loaded, false otherwise.
   */
  onMessagesLoaded(folderDisplay, isAll) {
    global.FolderDisplayListenerManager.unregisterListener(this);

    let dbView = folderDisplay.view.dbView;
    let messages = new Array(dbView.rowCount);
    let dates = new Map();

    // There's got to be a better way to get all the headers for a virtual
    // folder, but this works for now, and doesn't actually cross xpconnect any
    // more than real folders.
    for (let i = 0; i < messages.length; i++) {
      messages[i] = dbView.getMsgHdrAt(i);
      dates.set(messages[i], messages[i].date);
    }

    messages.sort((a, b) => dates.get(b) - dates.get(a));
    this._processMessages(messages);
  }
}

/**
 * The sparkline visualization shows a deliberately small histogram showing
 * the rate of activity in a folder over the last month.
 */
class SparklineWidget {
  /**
   * Create a new SparklineWidget.
   *
   * @param root The root element of the HTML for this visualization.
   */
  constructor(root) {
    this.root = root;
  }

  /**
   * A function to be called once the widget has been registered with the main
   * summary object.
   *
   * @param context The FolderSummary object holding this widget.
   */
  onregistered(context) {
    this.context = context;
  }

  /**
   * Initialize the sparkline object.
   */
  init() {
    this.dates = new Stats.AccumulatingHistogram(Stats.bin_by_day(30));
    this.stale = true;
    this.root.classList.add("hidden");
  }

  /**
   * Uninitialize the sparkline object.
   */
  uninit() {
    delete this.dates;
  }

  /**
   * Do some processing on a recent message in this folder.
   *
   * @param message The message to process.
   * @param deleted true if the message was deleted, false otherwise.
   */
  processRecentMessage(message, deleted) {
    this.stale = true;
    if (!deleted)
      this.dates.add(message.date);
    else
      this.dates.remove(message.date);
  }

  /**
   * Render the sparkline. This includes an invisible-by-default subset of the
   * sparkline, which can be used to show the frequency of emails in a
   * particular thread or from a particular user compared to the total.
   */
  render() {
    const margin = 5;
    const textHeight = 12;
    const w = 30 * 5 + margin * 2;
    const h = 16 + textHeight;
    const scale = Math.max.apply(this, this.dates.data()) / (h - textHeight);
    if (scale === 0) {
      this.root.classList.add("hidden");
      return;
    }

    this.root.style.width = w + "px";
    this.root.classList.remove("hidden");

    let mainHisto = new pv.Panel().canvas(this.root)
        .width(w)
        .height(h);
    mainHisto.add(pv.Bar)
        .data(this.dates.data())
        .width(4)
        .left(function() { return 5 * this.index + margin; })
        .height((d) => d / scale)
        .bottom(12)
        .fillStyle("var(--spark-color)");
    mainHisto.add(pv.Label)
        .textAlign("left")
        .bottom(0)
        .left(0)
        .text(formatString("oneMonthAgo"))
        .textStyle("var(--header-text-color)");
    mainHisto.add(pv.Label)
        .textAlign("right")
        .bottom(0)
        .right(0)
        .text(formatString("now"))
        .textStyle("var(--header-text-color)");

    this.subsetHisto = mainHisto.add(pv.Bar)
        .width(4)
        .left(function() { return 5 * this.index + margin; })
        .height((d) => d / scale)
        .bottom(12)
        .fillStyle("var(--spark-subset-color)");

    mainHisto.render();
    this.stale = false;
  }

  /**
   * Re-render the sparkline.
   */
  update() {
    if (this.stale)
      this.render();
  }

  /**
   * Set the subset data for the sparkline, for instance when mousing over
   * threads or senders.
   *
   * @param data The subset data, binned by days.
   */
  subsetData(data) {
    if (this.subsetHisto)
      this.subsetHisto.data(data).root.render();
  }
}

/**
 * The top correspondents visualization shows a list of the most frequent
 * authors (or recipients in outgoing folders) of messages in this folder.
 */
class TopCorrespondentsWidget {
  /**
   * Create a new TopCorrespondentsWidget
   *
   * @param root The root element of the HTML for this visualization.
   * @param sparklineWidget The sparkline widget to use for the correspondent
   *        sparkline overlay.
   */
  constructor(root, sparklineWidget) {
    this.root = root;
    this.sparklineWidget = sparklineWidget;

    // Hook up the context menu.
    this.menu = new MessageUtils.ContextMenu(
      this.root.querySelector("menu[type=\"context\"]"), this
    );
  }

  /**
   * The maximum number of rows to display in the summary.
   */
  maxRows = 7;

  /**
   * A function to be called once the widget has been registered with the main
   * summary object.
   *
   * @param context The FolderSummary object holding this widget.
   */
  onregistered(context) {
    this.context = context;
  }

  /**
   * Initialize the top authors object.
   */
  init() {
    this.correspondents = {};
    this.stale = true;

    let authors = this.root.querySelector("[data-type=\"authors\"]");
    let recipients = this.root.querySelector("[data-type=\"recipients\"]");
    let filter = this.menu.item("Filter");

    if (this.context.isOutgoingFolder) {
      authors.classList.add("hidden");
      recipients.classList.remove("hidden");
      filter.setAttribute("label", filter.getAttribute("recipientlabel"));
    }
    else {
      authors.classList.remove("hidden");
      recipients.classList.add("hidden");
      filter.setAttribute("label", filter.getAttribute("senderlabel"));
    }
  }

  /**
   * Uninitialize the top authors object.
   */
  uninit() {
    this._clear();
    delete this.correspondents;
  }

  /**
   * Do some processing on a message in this folder.
   *
   * @param message The message to process.
   * @param deleted true if the message was deleted, false otherwise.
   */
  processMessage(message, deleted) {
    this.stale = true;

    let headerValue;
    if (this.context.isOutgoingFolder)
      headerValue = message.mime2DecodedTo || message.mime2DecodedRecipients;
    else
      headerValue = message.mime2DecodedAuthor;

    let addresses = MailServices.headerParser.parseDecodedHeader(headerValue);

    if (!deleted) {
      for (let address of addresses) {
        let key = address.email || address.name;
        let correspondent = this.correspondents[key];
        if (!correspondent) {
          this.correspondents[key] = correspondent = {
            address: address,
            count: 0,
            histogram: new Stats.AccumulatingHistogram(Stats.bin_by_day(30))
          };
        } else if (correspondent.address.name != address.name) {
          // If we have this correspondent but the display name differs, just
          // use the bare email address.
          correspondent.address = MailServices.headerParser.makeMailboxObject(
            "", address.email
          );
        }

        correspondent.count++;
        correspondent.histogram.add(message.date);
      }
    } else {
      for (let address of addresses) {
        let key = address.email || address.name;
        if (!(key in this.correspondents))
          continue;
        this.correspondents[key].count--;
        this.correspondents[key].histogram.remove(message.date);
        if (this.correspondents[key].count == 0)
          delete this.correspondents[key];
      }
    }
  }

  /**
   * Render the top correspondents list. This includes the subset of the
   * sparkline for each correspondent, to be shown on hover.
   */
  render() {
    let correspondentData = [];
    for (let key in this.correspondents) {
      correspondentData.push(this.correspondents[key]);
    }
    correspondentData.sort((a, b) => b.count - a.count);

    let list = this.root.querySelector(".correspondents_list");
    for (let i = 0; i < Math.min(correspondentData.length, this.maxRows); i++) {
      let { address, count, histogram } = correspondentData[i];
      list.appendChild(this._makeCorrespondentItem(address, count, histogram));
    }

    this.stale = false;
  }

  /**
   * Re-render the top correspondents list.
   */
  update() {
    if (this.stale) {
      this._clear();
      this.render();
    }
  }

  /**
   * Clear the top correspondents list.
   */
  _clear() {
    let list = this.root.querySelector(".correspondents_list");
    while (list.lastChild)
      list.removeChild(list.lastChild);
  }

  /**
   * Given a correspondent, a message count, a histogram, and an onclick
   * handler, create a structure like so:
   *
   * <li>
   *   <div class="left_right">
   *     <div class="lr_wide">
   *       <div class="correspondent_name cropped">Author/recipient's name</div>
   *     </div>
   *     <div class="message_count lr_narrow">(Number of messages)</div>
   *   </div>
   *   <div class="correspondent_email cropped">Author/recipient's email
   *     address</div>
   * </li>
   *
   * @param address The email address of the correspondent as a
   *        msgIAddressObject.
   * @param count The number of messages from this correspondent.
   * @param histogram The histogram for the correspondent.
   * @return The HTML structure.
   */
  _makeCorrespondentItem(address, count, histogram) {
    let name = MessageUtils.formatDisplayNameNoYou(address.email, address.name);

    let row = document.createElement("li");
    row.address = address;

    let horiz = document.createElement("div");
    horiz.classList.add("left_right");
    row.appendChild(horiz);

    let correspondentWrapperNode = document.createElement("div");
    correspondentWrapperNode.classList.add("lr_wide");
    horiz.appendChild(correspondentWrapperNode);

    let correspondentNode = document.createElement("div");
    correspondentNode.classList.add("correspondent_name", "cropped");
    correspondentNode.setAttribute("tabindex", 0);
    correspondentNode.textContent = name || address.toString();
    MessageUtils.addOverflowTooltip(correspondentNode);

    // Add click/context menu handlers
    let server = this.context.folder.server;
    MessageUtils.addCommandListener(correspondentNode, (event) => {
      if (event.button == 0 || event.button == undefined) {
        let format = event.shiftKey ? Ci.nsIMsgCompFormat.OppositeOfDefault :
          Ci.nsIMsgCompFormat.Default;
        let fullAddress = MailServices.headerParser.makeMimeHeader(
          [address], 1
        );
        let fields = (address.email.indexOf("@") != -1 ||
                      server.type == "rss") ?
                     { to: fullAddress } : { newsgroups: fullAddress };
        MessageUtils.composeMessageToAddress(fields, server, format);
      }
    });
    MessageUtils.addContextMenu(correspondentNode, this.menu);

    correspondentWrapperNode.appendChild(correspondentNode);

    let countNode = document.createElement("div");
    countNode.classList.add("message_count", "lr_narrow");
    countNode.textContent = "(" + count.toLocaleString() + ")";
    horiz.appendChild(countNode);

    if (name) {
      let emailNode = document.createElement("div");
      emailNode.classList.add("correspondent_email", "cropped");
      emailNode.textContent = address.email;
      MessageUtils.addOverflowTooltip(emailNode);
      row.appendChild(emailNode);
    }

    // Add subset data for sparkline
    correspondentNode.data = histogram.data();
    correspondentNode.addEventListener("mouseenter", function(e) {
      this.sparklineWidget.subsetData(e.target.data);
    }.bind(this), true);
    correspondentNode.addEventListener("mouseleave", function(e) {
      this.sparklineWidget.subsetData([]);
    }.bind(this), true);

    return row;
  }

  /**
   * Compose a message to the selected correspondent from the context menu.
   *
   * @param event The triggering event.
   */
  contextComposeMessageTo(event) {
    // XXX: make the shift key work (this requires toolkit changes).
    let address = event.triggerNode.parentNode.parentNode.parentNode.address;
    let server = this.context.folder.server;
    let fullAddress = MailServices.headerParser.makeMimeHeader([address], 1);
    let fields = (address.email.indexOf("@") != -1 ||
                  this.context.folder.server.type == "rss") ?
                 { to: fullAddress } : { newsgroups: fullAddress };
    MessageUtils.composeMessageToAddress(fields, server);
  }

  /**
   * Copy the address of the selected correspondent from the context menu.
   *
   * @param event The triggering event.
   */
  contextCopyAddress(event) {
    let address = event.triggerNode.parentNode.parentNode.parentNode.address;

    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(address.email);
  }

  /**
   * Filter the thread pane by the address of the selected correspondent.
   *
   * @param event The triggering event.
   */
  contextFilter(event) {
    let address = event.triggerNode.parentNode.parentNode.parentNode.address;
    let fv = {text: address.email, states: {}};
    if (this.context.isOutgoingFolder)
      fv.states.recipients = true;
    else
      fv.states.sender = true;

    global.QuickFilterBarMuxer.setFilterValue("text", fv);
    global.QuickFilterBarMuxer._showFilterBar(true);
    global.QuickFilterBarMuxer.updateSearch();
  }
}

/**
 * The top threads visualization shows a list of the threads with the most
 * messages in this folder.
 */
class TopThreadsWidget {
  /**
   *
   * Create a new TopThreadsWidget.
   *
   * @param root The root element of the HTML for this visualization.
   * @param sparklineWidget The sparkline widget to use for the correspondent
   *        sparkline overlay.
   */
  constructor(root, sparklineWidget) {
    this.root = root;
    this.sparklineWidget = sparklineWidget;

    // Hook up the context menu.
    this.menu = new MessageUtils.ContextMenu(
      this.root.querySelector("menu[type=\"context\"]"), this
    );
  }

  /**
   * The maximum number of threads to store in our cache.
   */
  maxCache = 100;

  /**
   * The maximum number of rows to display in the summary.
   */
  maxRows = 7;

  /**
   * A function to be called once the widget has been registered with the main
   * summary object.
   *
   * @param context The FolderSummary object holding this widget.
   */
  onregistered(context) {
    this.context = context;
  }

  /**
   * Initialize the top threads object.
   */
  init() {
    this.threads = new Stats.MRUArray(
      this.maxRows, this.maxCache, this._threadCompare, this._threadEquals
    );
    this.stale = true;
  }

  /**
   * Uninitialize the top threads object.
   */
  uninit() {
    this._clear();
    delete this.threads;
  }

  /**
   * Do some processing on a message in this folder.
   *
   * @param message The message to process.
   * @param deleted true if the message was deleted, false otherwise.
   */
  processMessage(message, deleted) {
    this.stale = true;

    let thread;
    if (this.context.isVirtualFolder)
      thread = global.gFolderDisplay.view.dbView
                     .getThreadContainingMsgHdr(message);
    else
      thread = this.context.folder.msgDatabase
                   .GetThreadContainingMsgHdr(message);

    let threadKey = thread.threadKey;
    if (!deleted && thread.numChildren) {
      let index = this.threads.update({
        threadKey: threadKey,
        root: thread.getRootHdr({}),
        count: thread.numChildren,
        date: thread.newestMsgDate,
      });

      if (index !== null) {
        let t = this.threads.get(index);
        if (!t.histogram)
          t.histogram = new Stats.AccumulatingHistogram(Stats.bin_by_day(30));
        t.histogram.add(message.date);
      }
    } else if (thread.numChildren == 0) {
      return this.threads.remove({threadKey: threadKey}, false);
    } else if (deleted) {
      let index = this.threads.indexOf({threadKey: threadKey});
      if (index !== null)
        this.threads.get(index).histogram.remove(message.date);
    }
    return false;
  }

  /**
   * Render the top thread list. This includes the subset of the sparkline for
   * each thread, to be shown on hover.
   */
  render() {
    let list = this.root.querySelector(".threads_list");
    for (let threadInfo of this.threads) {
      let { root, count, histogram } = threadInfo;
      list.appendChild(this._makeThreadItem(root, count, histogram));
    }
    this.stale = true;
  }

  /**
   * Re-render the top threads list.
   */
  update() {
    if (this.stale) {
      this._clear();
      this.render();
    }
  }

  /**
   * Clear the top threads list.
   */
  _clear() {
    let list = this.root.querySelector(".threads_list");
    while (list.lastChild)
      list.removeChild(list.lastChild);
  }

  /**
   * Compare two threads based on the number of contained messages, and the date
   * of the newest message.
   *
   * @param a The first thread.
   * @param b The second thread.
   * @return 1 if a > b, -1 if a < b, 0 if a == b.
   */
  _threadCompare(a, b) {
    return b.count - a.count || b.date - a.date || b.threadKey - a.threadKey;
  }

  /**
   * Check if two threads are equal.
   *
   * @param a The first thread.
   * @param b The second thread.
   * @return true if the threads are equal, false otherwise.
   */
  _threadEquals(a, b) {
    return a.threadKey == b.threadKey;
  }

  /**
   * Given an nsIMsgThread, a histogram, and an onclick handler, create a
   * structure like so:
   *
   * <li>
   *   <div class="left_right">
   *     <div class="lr_wide">
   *       <div class="thread_subject cropped">Subject of the email</div>
   *     </div>
   *     <div class="message_count lr_narrow">(Number of messages)</div>
   *   </div>
   * </li>
   *
   * @param root the root message of the thread
   * @param count the number of messages in this thread
   * @param histogram the histogram for the thread
   * @return The HTML structure.
   */
  _makeThreadItem(root, count, histogram) {
    let row = document.createElement("li");
    row.message = root;

    let horiz = document.createElement("div");
    horiz.classList.add("left_right");
    row.appendChild(horiz);

    let subjectWrapperNode = document.createElement("div");
    subjectWrapperNode.classList.add("lr_wide");
    horiz.appendChild(subjectWrapperNode);

    let subjectNode = document.createElement("div");
    subjectNode.classList.add("thread_subject", "cropped");
    subjectNode.setAttribute("tabindex", 0);
    subjectNode.textContent = root.mime2DecodedSubject ||
                              formatString("noSubject");
    MessageUtils.addOverflowTooltip(subjectNode);

    // Add click/context menu handlers.
    MessageUtils.addCommandListener(subjectNode, (event) => {
      if (event.button > 1)
        return;
      else if (MessageUtils.isMessageIndexed(root) &&
               (event.ctrlKey || event.button == 1)) {
        global.gConversationOpener.openConversationForMessages([root]);
      }
      else {
        global.gFolderTreeView.selectFolder(root.folder);
        global.gFolderDisplay.selectMessage(root);
        global.gFolderDisplay.doCommand(Ci.nsMsgViewCommandType.selectThread);
      }
    });
    MessageUtils.addContextMenu(subjectNode, this.menu);

    subjectWrapperNode.appendChild(subjectNode);

    let countNode = document.createElement("div");
    countNode.classList.add("message_count", "lr_narrow");
    countNode.textContent = "(" + count.toLocaleString() + ")";
    horiz.appendChild(countNode);

    // Add subset data for sparkline.
    subjectNode.data = histogram.data();
    subjectNode.addEventListener("mouseenter", (e) => {
      this.sparklineWidget.subsetData(e.target.data);
    }, true);
    subjectNode.addEventListener("mouseleave", (e) => {
      this.sparklineWidget.subsetData([]);
    }, true);

    return row;
  }

  /**
   * Called when the top threads context menu is opened.
   *
   * @param event The triggering event.
   */
  showContextMenu(event) {
    let item = this.menu.item("OpenInConversation");
    let message = event.triggerNode.parentNode.parentNode.parentNode.message;
    item.disabled = !MessageUtils.isMessageIndexed(message);
  }

  /**
   * Open the selected message in a conversation from the context menu
   *
   * @param event The triggering event.
   */
  contextOpenInConversation(event) {
    let message = event.triggerNode.parentNode.parentNode.parentNode.message;
    global.gConversationOpener.openConversationForMessages([message]);
  }
}

/**
 * The recent messages visualization shows a list of relevant messages in the
 * folder.
 */
class TopMessagesWidget {
  /**
   * Create a new TopMessagesWidget.
   *
   * @param root The root element of the HTML for this visualization.
   */
  constructor(root) {
    this.root = root;

    // Hook up the context menu.
    this.menu = new MessageUtils.ContextMenu(
      this.root.querySelector("menu[type=\"context\"]"), this
    );
  }

  /**
   * The maximum number of messages to store in our cache.
   */
  maxCache = 100;

  /**
   * The maximum number of rows to display in the summary.
   */
  maxRows = 7;

  /**
   * A function to be called once the widget has been registered with the main
   * summary object.
   *
   * @param context The FolderSummary object holding this widget.
   */
  onregistered(context) {
    this.context = context;
  }

  /**
   * Initialize the recent messages object.
   */
  init() {
    this.messages = new Stats.MRUArray(
      this.maxRows, this.maxCache, this._messageCompare, this._messageEquals
    );
    this.stale = true;
  }

  /**
   * Uninitialize the recent messages object.
   */
  uninit() {
    this._clear();
    delete this.messages;
    delete this.incomplete;
  }

  /**
   * Do some processing on a message in this folder.
   *
   * @param message The message to process.
   * @param deleted true if the message was deleted, false otherwise.
   */
  processMessage(message, deleted) {
    this.stale = true;
    let messageInfo = { message: message, score: this._messageScore(message) };

    if (!deleted) {
      this.messages.add(messageInfo);
      return false;
    } else {
      return this.messages.remove(messageInfo, true);
    }
  }

  /**
   * Update the state of a message in this folder.
   *
   * @param message The message to update.
   * @param oldFlags The old flags for the message (as a bitset).
   * @param newFlags The new flags for the message (as a bitset).
   */
  updateMessageFlags(message, oldFlags, newFlags) {
    this.stale = true;

    // We only care about unread/starred changes
    const flags = Ci.nsMsgMessageFlags;
    if ( ((oldFlags & flags.Read)   == (newFlags & flags.Read)) &&
         ((oldFlags & flags.Marked) == (newFlags & flags.Marked)) )
      return;

    let messageInfo = { message: message, score: this._messageScore(message) };
    this.messages.update(messageInfo);
  }

  /**
   * Render the recent messages list.
   */
  render() {
    let list = this.root.querySelector(".messages_list");
    for (let messageInfo of this.messages) {
      let message = messageInfo.message;
      list.appendChild(this._makeMessageItem(message));
    }

    this.stale = false;
  }

  /**
   * Re-render the recent messages list.
   */
  update() {
    if (this.stale) {
      this._clear();
      this.render();
    }
  }

  /**
   * Clear the recent messages list.
   */
  _clear() {
    let list = this.root.querySelector(".messages_list");
    while (list.lastChild)
      list.removeChild(list.lastChild);
  }

  /**
   * Compute the score of a message based on a combination of its date and
   * unread/starred status.
   *
   * @param message The nsIMsgDBHdr to compute the score for.
   * @return The message score.
   */
  _messageScore(message) {
    const DAY = 24 * 60 * 60 * 1000000; // microseconds
    let score = message.date;

    if (!message.isRead)
      score += 30 * DAY;
    if (message.isFlagged)
      score += 30 * DAY;
    return score;
  }

  /**
   * Compare two messageInfo objects based on their calculated scores.
   *
   * @param a The first messageInfo.
   * @param b The second messageInfo.
   * @return 1 if a > b, -1 if a < b, 0 if a == b.
   */
  _messageCompare(a, b) {
    return b.score - a.score || b.message.messageKey - a.message.messageKey;
  }

  /**
   * Check if two messageInfo objects are equal based on their messages.
   *
   * @param a The first messageInfo.
   * @param b The second messageInfo.
   * @return true if the messages are equal, false otherwise.
   */
  _messageEquals(a, b) {
    return a.message == b.message;
  }

  /**
   * Given a message and an onclick handler, create a structure like so:
   *
   * <li class="message">
   *   <div class="star"/>
   *   <div class="subject_and_author">
   *     <div class="message_subject cropped">Subject of the email</div>
   *     <div class="message_author cropped">Author of the email</div>
   *   </div>
   * </li>
   *
   * @param message The msgHdr for the message.
   * @return The HTML structure.
   */
  _makeMessageItem(message) {
    let row = document.createElement("li");
    row.classList.add("message");
    if (!message.isRead)
      row.classList.add("unread");
    if (message.isFlagged)
      row.classList.add("starred");
    row.message = message;

    let star = document.createElement("div");
    star.classList.add("star");
    row.appendChild(star);

    let subjectAndAuthor = document.createElement("div");
    subjectAndAuthor.classList.add("subject_and_author");
    subjectAndAuthor.folder = message.folder;
    subjectAndAuthor.messageKey = message.messageKey;
    row.appendChild(subjectAndAuthor);

    let subjectNode = document.createElement("div");
    subjectNode.classList.add("message_subject", "cropped");
    subjectNode.setAttribute("tabindex", 0);
    if (message.flags & Ci.nsMsgMessageFlags.HasRe)
      subjectNode.textContent = "Re: "; // Hardcoded to match how TB works.
    subjectNode.textContent += message.mime2DecodedSubject ||
                               formatString("noSubject");
    MessageUtils.addOverflowTooltip(subjectNode);

    // Add click/context menu handlers
    MessageUtils.addCommandListener(subjectNode, (event) => {
      if (event.button > 1) {
        return;
      } else if (event.ctrlKey || event.button == 1) {
        MessageUtils.displayMessage(
          message, null, global.document.getElementById("tabmail"),
          event.shiftKey
        );
      } else if (event.shiftKey) {
        MailUtils.openMessageInNewWindow(message);
      } else {
        global.gFolderDisplay.selectMessage(message);
        global.document.getElementById("messagepane").focus();
      }
    });
    MessageUtils.addContextMenu(subjectNode, this.menu);

    subjectAndAuthor.appendChild(subjectNode);

    let personNode = document.createElement("div");
    personNode.classList.add("cropped");
    if (this.context.isOutgoingFolder) {
      personNode.classList.add("message_recipient");
      personNode.textContent = DisplayNameUtils.formatDisplayNameList(
        message.mime2DecodedTo || message.mime2DecodedRecipients, "to"
      );
    } else {
      personNode.classList.add("message_author");
      personNode.textContent = DisplayNameUtils.formatDisplayNameList(
        message.mime2DecodedAuthor, "from"
      );
    }
    MessageUtils.addOverflowTooltip(personNode);
    subjectAndAuthor.appendChild(personNode);

    return row;
  }

  /**
   * Called when the top threads context menu is opened.
   *
   * @param event The triggering event.
   */
  showContextMenu(event) {
    let item = this.menu.item("OpenInConversation");
    let message = event.triggerNode.parentNode.parentNode.message;
    item.disabled = !MessageUtils.isMessageIndexed(message);
  }

  /**
   * Open the selected message in a new window from the context menu
   *
   * @param event The triggering event.
   */
  contextOpenInNewWindow(event) {
    let message = event.triggerNode.parentNode.parentNode.message;
    MailUtils.openMessageInNewWindow(message);
  }

  /**
   * Open the selected message in a new tab from the context menu
   *
   * @param event The triggering event.
   */
  contextOpenInNewTab(event) {
    // XXX: make the shift key work (this requires toolkit changes).
    let message = this.menu.triggerNode.parentNode.parentNode.message;
    MessageUtils.openMessageInTab(
      message, null, global.document.getElementById("tabmail")
    );
  }

  /**
   * Open the selected message in a conversation from the context menu
   *
   * @param event The triggering event.
   */
  contextOpenInConversation(event) {
    let message = this.menu.triggerNode.parentNode.parentNode.message;
    global.gConversationOpener.openConversationForMessages([message]);
  }
}

/**
 * The tag dots visualization shows a list of dots representing the tag data for
 * each message in the folder.
 */
class TagDotsWidget {
  /**
   * Create a new TagDotsWidget.
   *
   * @param root The root element of the HTML for this visualization.
   */
  constructor(root) {
    this.root = root;
  }

  /**
   * A function to be called once the widget has been registered with the main
   * summary object.
   *
   * @param context The FolderSummary object holding this widget.
   */
  onregistered(context) {
    this.context = context;
  }

  /**
   * Initialize the tag dots object.
   *
   * @param context The FolderSummary object.
   */
  init(context) {
    this.context = context;
    this.dots = [];
    let tagService = Cc["@mozilla.org/messenger/tagservice;1"]
                       .getService(Ci.nsIMsgTagService);
    this.allTags = Array.from(tagService.getAllTags({}), (i) => {
      return {tag: i, count: 0};
    });
    this.stale = true;

    this.root.classList.add("hidden");
  }

  /**
   * Uninitialize the tag dots object.
   */
  uninit() {
    delete this.dots;
    delete this.allTags;
  }

  /**
   * Do some processing on a message in this folder.
   *
   * @param message The message to process.
   * @param deleted true if the message was deleted, false otherwise.
   */
  processMessage(message, deleted) {
    this.stale = true;
    let keywords = this._getKeywordsForMessage(message);

    if (!deleted) {
      let tags = [];
      for (let tagInfo of this.allTags) {
        if (tagInfo.tag.key in keywords) {
          tagInfo.count++;
          tags.push(tagInfo.tag);
        }
      }
      if (tags.length)
        this.dots.push({ message: message, tags: tags });
    } else {
      for (let tagInfo of this.allTags) {
        if (tagInfo.tag.key in keywords)
          tagInfo.count--;
      }

      for (let i = 0; i < this.dots.length; i++) {
        if (this.dots[i].message == message) {
          this.dots.splice(i, 1);
          break;
        }
      }
    }
  }

  /**
   * Update the tags of a message in this folder.
   *
   * @param message The message to update.
   */
  updateMessageTags(message) {
    this.stale = true;
    let index = null;
    for (let i = 0; index == null && i < this.dots.length; i++) {
      if (this.dots[i].message == message)
        index = i;
    }

    if (index == null) {
      // A newly-tagged message.
      this.processMessage(message);
    } else {
      // A previously-tagged message.
      let oldTags = this.dots[index].tags;
      let newKeywords = this._getKeywordsForMessage(message);

      this.dots[index].tags = [];
      for (let tagInfo of this.allTags) {
        if (oldTags.indexOf(tagInfo.tag) != -1)
          tagInfo.count--;
        if (tagInfo.tag.key in newKeywords) {
          this.dots[index].tags.push(tagInfo.tag);
          tagInfo.count++;
        }
      }

      // No tags, so remove it!
      if (Object.keys(newKeywords).length == 0)
        this.dots.splice(index, 1);
    }
  }

  /**
   * Render the tag dots chart. If the document hasn't fully loaded yet, we
   * should wait until it does, just to be sure the size of the canvas is right.
   * Also, set up an event listener to redraw the chart when we resize the
   * frame.
   */
  render() {
    if (document.readyState == "complete") {
      this._render(true);
    } else {
      window.addEventListener("load", () => {
        this._render(true);
      }, false);
    }

    if (!this._hasResize) {
      this._hasResize = true;

      // Re-render the tag dots, but only once per second. This has the happy
      // side-effect of fixing a strange bug with the width of the tagDots
      // canvas when switching from account summary to folder summary.
      let lastResize = 0;
      window.addEventListener("resize", () => {
        // A width of zero for the document is a bad sign...
        if (document.body.clientWidth == 0)
          return;

        let now = Date.now();
        if (now - lastResize > 1000) {
          this._render();
          lastResize = now;
        }
      }, false);
    }

    this.stale = false;
  }

  /**
   * Re-render the tag dots chart.
   */
  update() {
    if (this.stale)
      this.render();
  }

  /**
   * Render the tag dots chart for real.
   *
   * @param force true if the chart should be drawn no matter what. Otherwise,
   *        only draw the chart if the width has changed (and is non-zero).
   */
  _render(force) {
    if (this.dots.length === 0) {
      this.root.classList.add("hidden");
      return;
    }
    this.root.classList.remove("hidden");

    let tagDots = this.root.querySelector(".tag_dots");
    let width = tagDots.offsetWidth;

    // Only render if the width is non-zero and different from the previous
    // width, or if we're forcing a render (e.g. when rendering for the first
    // time).
    if ((!force && width == this.chartWidth) || width == 0)
      return;
    this.chartWidth = width;

    let r = 4;
    let dotSpacing = 2*r + 1;
    let legendMargin = 4;
    let legendSpacing = 16;
    let rowMax = Math.floor(width / dotSpacing);
    let dotHeight = Math.ceil(this.dots.length / rowMax) * dotSpacing;
    let estHeight = dotHeight + legendMargin + legendSpacing *
                    (this.allTags.length + 1);

    let vis = new pv.Panel().canvas(tagDots)
      .width(width)
      .height(estHeight);

    // Show a sorted list of all the tags as little dots
    this.dots.sort(this._tagComparator);
    let i = 0;
    for (let {message: message, tags: tags} of this.dots) {
      let xIndex = i % rowMax;
      let yIndex = Math.floor(i / rowMax);
      i++;

      let x = dotSpacing * (0.5 + xIndex);
      let y = dotSpacing * (0.5 + yIndex);

      let data = Array.from(tags, (i) => [1, i.color, message]);
      let scale = 2 * Math.PI / tags.length;
      // The Re: is hardcoded to match how TB works.
      let subject = message.flags & Ci.nsMsgMessageFlags.HasRe ? "Re: " : "";
      subject += message.mime2DecodedSubject ||
                 formatString("noSubject");
      let wedge = vis.add(pv.Wedge)
        .data(data)
        .left(x)
        .top(y)
        .title(subject)
        .cursor("pointer")
        .event("click", (data) => {
          global.gFolderDisplay.selectMessage(data[2]);
          global.document.getElementById("messagepane").focus();
        })
        .outerRadius(r)
        .angle((d) => d[0] * scale)
        .fillStyle((d) => d[1]);
    }

    // Add a legend showing the counts for each (used) tag
    let yOffset = dotHeight + legendMargin;
    let xOffset = dotSpacing;
    let numTags = 0;
    for (let tagInfo of this.allTags) {
      if (tagInfo.count == 0) continue;
      numTags++;

      yOffset += legendSpacing;
      vis.add(pv.Dot)
        .top(yOffset - legendSpacing/2)
        .left(xOffset)
        .fillStyle(tagInfo.tag.color)
        .strokeStyle("transparent")
        .anchor("right")
          .add(pv.Label)
          .text(tagInfo.tag.tag + ": " + tagInfo.count);
    }

    vis.render();
    let realHeight = dotHeight + legendMargin + legendSpacing * numTags;
    tagDots.style.height = realHeight + "px";
  }

  /**
   * Get a dictionary of the keywords (tag keys) for a message
   *
   * @param message The message to get the keywords for.
   * @return A dictionary of keywords.
   */
  _getKeywordsForMessage(message) {
    let keywords = message.getStringProperty("keywords");
    if (keywords == "")
      return {};

    let keywordMap = {};
    for (let keyword of keywords.split(" "))
      keywordMap[keyword] = true;
    return keywordMap;
  }

  /**
   * Sort the tag dots based on which tags are set on them.
   *
   * @param a The first tag dot (an array of tags).
   * @param b The second tag dot (an array of tags).
   * @return 1 if a > b, -1 if a < b, 0 if a == b.
   */
  _tagComparator(a, b) {
    let a_tagscore = a.tags.reduce((x, y) => x + y);
    let b_tagscore = b.tags.reduce((x, y) => x + y);
    return a_tagscore > b_tagscore;
  }
}

var gFolderSummary = new FolderSummary();
var gSparklineWidget = new SparklineWidget(document.getElementById("spark"));

gFolderSummary.registerAnalyzer(gSparklineWidget);
gFolderSummary.registerAnalyzer(new TopCorrespondentsWidget(
  document.getElementById("correspondents"), gSparklineWidget
));
gFolderSummary.registerAnalyzer(new TopThreadsWidget(
  document.getElementById("threads"), gSparklineWidget
));
gFolderSummary.registerAnalyzer(new TopMessagesWidget(
  document.getElementById("messages")
));
gFolderSummary.registerAnalyzer(new TagDotsWidget(
  document.getElementById("tags")
));
