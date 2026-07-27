// AMC Tracker Activity Monitor - background service worker
// Tracks which domain the active browser tab is on and reports accumulated
// time to the AMC Time Tracker backend roughly once per minute.

var ENDPOINT = 'https://tracker.amclms.com/sync-url-activity';
var FLUSH_ALARM = 'amc_flush';

var currentDomain = null;
var currentTitle = '';
var currentUrl = '';
var segmentStart = null;
var pending = {};

function azDateStr(d) {
    var utc = d.getTime() + d.getTimezoneOffset() * 60000;
    var az = new Date(utc - 7 * 3600000);
    return az.getFullYear() + '-' + String(az.getMonth() + 1).padStart(2, '0') + '-' + String(az.getDate()).padStart(2, '0');
}

function getDomain(url) {
    try {
          var u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
          return u.hostname.replace(/^www\./, '');
    } catch (e) {
          return null;
    }
}

function flushSegment() {
    if (currentDomain && segmentStart) {
          var elapsed = Math.round((Date.now() - segmentStart) / 1000);
          if (elapsed > 0) {
                  if (!pending[currentDomain]) pending[currentDomain] = { seconds: 0, url: currentUrl, title: currentTitle };
                  pending[currentDomain].seconds += elapsed;
                  pending[currentDomain].url = currentUrl;
                  pending[currentDomain].title = currentTitle;
          }
    }
    segmentStart = Date.now();
}

function setActive(domain, url, title) {
    flushSegment();
    currentDomain = domain;
    currentUrl = url || '';
    currentTitle = title || '';
}

async function resolveActiveTab() {
    try {
          var wins = await chrome.windows.getAll({ populate: false });
          var focusedWin = wins.find(function (w) { return w.focused; });
          if (!focusedWin) { setActive(null, '', ''); return; }
          var tabs = await chrome.tabs.query({ active: true, windowId: focusedWin.id });
          if (!tabs || !tabs[0]) { setActive(null, '', ''); return; }
          var tab = tabs[0];
          var domain = getDomain(tab.url || '');
          setActive(domain, tab.url, tab.title);
    } catch (e) {
          setActive(null, '', '');
    }
}

chrome.tabs.onActivated.addListener(resolveActiveTab);
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (tab.active && (changeInfo.url || changeInfo.title)) resolveActiveTab();
});
chrome.windows.onFocusChanged.addListener(function (windowId) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) { setActive(null, '', ''); }
    else resolveActiveTab();
});
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(function (state) {
    if (state === 'active') resolveActiveTab();
    else setActive(null, '', '');
});

chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async function (alarm) {
    if (alarm.name !== FLUSH_ALARM) return;
    flushSegment();
    var stored = await chrome.storage.local.get('amcEmail');
    var email = stored.amcEmail;
    var date = azDateStr(new Date());
    var domains = Object.keys(pending);
    if (!email) { pending = {}; return; }
    for (var i = 0; i < domains.length; i++) {
          var d = domains[i];
          var rec = pending[d];
          if (!rec || rec.seconds <= 0) continue;
          try {
                  await fetch(ENDPOINT, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: email, date: date, domain: d, url: rec.url, title: rec.title, seconds: rec.seconds })
                  });
          } catch (e) { /* dropped on failure; will resume counting on the next cycle */ }
    }
    pending = {};
});

resolveActiveTab();
