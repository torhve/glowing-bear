/**
 * The dev-server address, written once.
 *
 * `webServer.url`, `use.baseURL`, the harness's first navigation and the failure-path dev-server
 * probe all have to agree on this address. A probe pointed somewhere the suite is not serving
 * reports a dead server, which turns the one line in a failure that distinguishes a lost dev server
 * from a lost app session into a lie.
 */
export const APP_URL = 'http://localhost:8001';
