import type { FullConfig } from '@playwright/test';
import { closeFixtureQueryBuffers, closeTestBuffers, relayBufferNames } from './helpers/relay-admin';
import { irc } from './helpers/irc-control';

/** The nick the fixture's own bot starts with (`test/irc-server/IRCServer.ts`). */
const FIXTURE_BOT_NICK = 'gbbot';

/** The channel the fixture autojoins and nearly every spec shares. */
const FIXTURE_CHANNEL = '#glowing-bear';

/* gbtest itself persists across test runs on purpose: the channel, the PM and the
 * relay stay up so a run does not have to rebuild them. What must NOT persist is the
 * throwaway channels specs join for themselves — `/part` leaves the buffer behind, so
 * each run added a dozen rows to the sidebar and a dozen candidates to the hotlist,
 * and a later run was asserting against leftovers it never created (53 buffers after
 * a few runs, 47 of them test channels; live probe 2026-10-07).
 *
 * The prefixes below are the channels specs name for themselves. The fixture's own buffers —
 * `#glowing-bear`, the `gbtest` server, `relay.relay.list` — are meant to stay. Query (PM) buffers
 * are the exception and are cleared by name below: a query buffer keeps the name it was created
 * with, so a run that inherits one inherits a name an earlier spec chose. */
const TEST_BUFFER_PREFIXES = [
    'irc.gbtest.#gb',           // #gb-idle-, #gbown…, #gbmshallow/#gbmcapped, #gbhist-, #gb-smsg-, …
    'irc.gbtest.#core-clear-probe',
    'exec.exec.',               // buffers left by exec-based specs
];

export default async function globalTeardown(_config: FullConfig) {
    try {
        const closedChannels = await closeTestBuffers(TEST_BUFFER_PREFIXES);
        // Query buffers are cleared for the reason recorded in closeFixtureQueryBuffers: their name
        // is fixed when WeeChat creates them, so leaving one behind decides which private buffer a
        // later run is allowed to wait for.
        const closedQueries = await closeFixtureQueryBuffers();
        // The bot's nick is fixture state as well. Specs rename it so their private buffer gets a
        // name they chose, and WeeChat renders a JOIN/PART line only for the nick it currently
        // holds: measured with the bot left renamed to `gbbot2`, 12 of 18 planted status markers
        // never reached the chat, so a run that renamed the bot decides whether a later run's
        // status lines exist at all.
        await irc.botNick(FIXTURE_BOT_NICK);
        // Membership is fixture state on the same terms. Raw `PART` lines a spec plants are honoured
        // by WeeChat and take the bot out of the shared channel's nicklist — measured: after
        // `ReadMarker-unreadBadge` ran, the legacy transport's nicklist held only `testuser` and
        // `testuser5`, and a later spec's nick completion produced no replacement (`Received: "gbb"`).
        // Rejoining is idempotent on the fixture server, and the membership is read back rather than
        // assumed, because a restore that silently did nothing would leave the next run inheriting
        // the same nickless channel.
        await irc.botJoin(FIXTURE_CHANNEL);
        const members = await irc.channelMembers(FIXTURE_CHANNEL);
        if (!members.includes(FIXTURE_BOT_NICK)) {
            console.log(`[global-teardown] ${FIXTURE_CHANNEL} did not regain ${FIXTURE_BOT_NICK}; members are ${members.join(', ') || '(none)'}`);
        }
        // Naming what survives, so a leak outside the rules above shows up as a
        // growing list in the run output instead of silently slowing every later run.
        const remaining = await relayBufferNames();
        console.log(
            `[global-teardown] closed ${closedChannels} test channel(s) and ${closedQueries} query buffer(s); gbtest kept running with ${remaining.length} buffers: ${remaining.join(', ')}`,
        );
    } catch (err) {
        // The fixture may already be down (a run that never started it, or a manual
        // `npm run irc:stop`). Teardown is hygiene, not a test: say what happened and
        // leave the exit code to the tests.
        console.log(`[global-teardown] test buffers left in place: ${(err as Error).message}`);
    }
}
