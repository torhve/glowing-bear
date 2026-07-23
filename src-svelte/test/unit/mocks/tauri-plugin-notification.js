// Mock for @tauri-apps/plugin-notification — used in Vitest tests where the real package is not installed
// Provides no-op stubs matching the plugin's API surface

 
function isPermissionGranted() {
    return Promise.resolve(false);
}

 
function requestPermission() {
    return Promise.resolve('denied');
}

 
function sendNotification(options) {
    // no-op
}

 
async function registerActionTypes(types) {
    // no-op
}

async function pending() {
    return [];
}

 
async function cancel(notifications) {
    // no-op
}

async function cancelAll() {
    // no-op
}

async function active() {
    return [];
}

 
async function removeActive(notifications) {
    // no-op
}

async function removeAllActive() {
    // no-op
}

 
async function createChannel(channel) {
    // no-op
}

 
async function removeChannel(id) {
    // no-op
}

async function channels() {
    return [];
}

 
async function onNotificationReceived(cb) {
    return { remove: () => {} };
}

 
async function onAction(cb) {
    return { remove: () => {} };
}

class Schedule {
    static at() { return {}; }
    static interval() { return {}; }
    static every() { return {}; }
}

const Importance = { None: 0, Min: 1, Low: 2, Default: 3, High: 4 };
const Visibility = { Secret: -1, Private: 0, Public: 1 };

export {
    isPermissionGranted,
    requestPermission,
    sendNotification,
    registerActionTypes,
    pending,
    cancel,
    cancelAll,
    active,
    removeActive,
    removeAllActive,
    createChannel,
    removeChannel,
    channels,
    onNotificationReceived,
    onAction,
    Schedule,
    Importance,
    Visibility,
};
