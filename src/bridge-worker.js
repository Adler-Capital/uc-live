// UC Live Bridge worker - dedicated-worker timers are NOT throttled when the tab
// is hidden, so this is the bridge's heartbeat. The page just listens for ticks.
setInterval(() => postMessage("tick"), 1000);
