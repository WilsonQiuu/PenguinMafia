const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    LabelBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const sql = require('../db.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('./donations.js');
const {
    calculatePayout,
    formattedMinecraftIgn,
    formatPayoutLine
} = require('./payouts.js');
const {
    formatMinecraftPaymentAmountFromCents
} = require('./commissionPayments.js');
const {
    postDonationEvent,
    postGiveawayDonationEvent
} = require('./events.js');
const {
    updateDonationLeaderboardForGuild
} = require('./leaderboards.js');
const {
    GIVEAWAY_PING_ROLE_ID,
    REACTION_ROLES_CHANNEL_ID
} = require('./reactionRoles.js');
const {
    ELECTION_LEADERBOARD_CHANNEL_ID
} = require('./elections.js');
const {
    setMemberNicknameToIgn
} = require('./nicknames.js');
const { isDon } = require('./staff.js');

const GIVEAWAY_CHANNEL_ID =
    process.env.GIVEAWAY_CHANNEL_ID || '1517413426358390814';
const GIVEAWAY_WINNER_CHANNEL_ID =
    process.env.GIVEAWAY_WINNER_CHANNEL_ID || '1536602944605134958';
const GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID =
    process.env.GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID || '1498442322638147604';
const GIVEAWAY_BUTTON_PREFIX = 'giveaway_enter:';
const GIVEAWAY_LEAVE_BUTTON_PREFIX = 'giveaway_leave:';
const GIVEAWAY_ENTER_ALL_BUTTON_ID = 'giveaway_enter_all';
const GIVEAWAY_LEAVE_ALL_BUTTON_ID = 'giveaway_leave_all';
const GIVEAWAY_NOTIFY_BUTTON_ID = 'giveaway_notify_role';
const GIVEAWAY_END_BUTTON_PREFIX = 'giveaway_end:';
const GIVEAWAY_CLOSE_BUTTON_PREFIX = 'giveaway_close:';
const GIVEAWAY_DISMISS_BUTTON_PREFIX = 'giveaway_dismiss:';
const GIVEAWAY_HOST_ACCEPT_PREFIX = 'giveaway_host_accept:';
const GIVEAWAY_HOST_REJECT_PREFIX = 'giveaway_host_reject:';
const GIVEAWAY_HOST_PAID_PREFIX = 'giveaway_host_paid:';
const GIVEAWAY_HOST_CANCEL_PREFIX = 'giveaway_host_cancel:';
const GIVEAWAY_LINK_MODAL_PREFIX = 'giveaway_link:';
const MIN_GIVEAWAY_DURATION_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MILLION_AMOUNT = 1_000_000n;
const DAILY_GIVEAWAY_AMOUNT_STEP = 20_000_000n;
const MAX_GIVEAWAY_DURATION_MS = WEEK_MS;
const GIVEAWAY_PAYMENT_MATCH_TOLERANCE = 100_000n;
const DEFAULT_PAYMENT_BOT_USER = 'Ash_L567';
const ACTIVE_GIVEAWAYS_BOARD_REFRESH_DELAY_MS = 1_500;
const DONATION_LEADERBOARD_REFRESH_DELAY_MS = 2_000;
const GIVEAWAY_MESSAGE_REFRESH_DELAY_MS = 1_250;
const activeGiveawaysBoardRefreshes = new Map();
const donationLeaderboardRefreshes = new Map();
const giveawayMessageRefreshes = new Map();
const APPROVED_GIVEAWAY_HOSTS = Object.freeze([
    Object.freeze({ discordId: '352217415905574914', minecraftIgn: 'itsWSQ' }),
    Object.freeze({ discordId: '719063111008780338', minecraftIgn: 'rainbowbeltzz' })
]);

function dismissButton(ownerId) {
    return new ButtonBuilder()
        .setCustomId(`${GIVEAWAY_DISMISS_BUTTON_PREFIX}${ownerId}`)
        .setLabel('✕')
        .setStyle(ButtonStyle.Secondary);
}

function dismissRow(ownerId) {
    return new ActionRowBuilder().addComponents(dismissButton(ownerId));
}

function sponsorName(request) {
    return `<@${request.sponsor_discord_id}>`;
}

function sponsoredGiveawayHostRequestPayload(request) {
    return {
        content:
            `# 🎁 Giveaway Hosting Request\n\n` +
            `${sponsorName(request)} wants to sponsor a **${formatDonationAmount(request.amount)}** giveaway.\n` +
            `If you are online and ready to receive the payment at **${request.host_minecraft_ign}**, accept below.\n\n` +
            `The giveaway will not start until you confirm that you received the payment.`,
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${GIVEAWAY_HOST_ACCEPT_PREFIX}${request.id}`)
                    .setLabel('Accept')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`${GIVEAWAY_HOST_REJECT_PREFIX}${request.id}`)
                    .setLabel('Reject')
                    .setStyle(ButtonStyle.Danger),
                dismissButton(request.host_discord_id)
            )
        ],
        allowedMentions: { users: [request.sponsor_discord_id] }
    };
}

function sponsoredGiveawayPaymentPayload(request) {
    return {
        content:
            `# 💰 Giveaway Payment Ready\n\n` +
            `<@${request.host_discord_id}> accepted your **${formatDonationAmount(request.amount)}** giveaway.\n` +
            `Send the payment to **${request.host_minecraft_ign}** in DonutSMP:\n\n` +
            `\`\`\`text\n/pay ${request.host_minecraft_ign} ${formatDonationAmount(request.amount)}\n\`\`\`\n` +
            `The host will start the giveaway after confirming they received it.`,
        components: [dismissRow(request.sponsor_discord_id)],
        allowedMentions: { users: [request.host_discord_id] }
    };
}

function sponsoredGiveawayPaymentConfirmationPayload(request) {
    return {
        content:
            `✅ You accepted ${sponsorName(request)}'s **${formatDonationAmount(request.amount)}** giveaway.\n\n` +
            `Wait until **${request.host_minecraft_ign}** receives the payment, then confirm below to start it.`,
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${GIVEAWAY_HOST_PAID_PREFIX}${request.id}`)
                    .setLabel('Payment Received — Start')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`${GIVEAWAY_HOST_CANCEL_PREFIX}${request.id}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Danger),
                dismissButton(request.host_discord_id)
            )
        ],
        allowedMentions: { users: [request.sponsor_discord_id] }
    };
}

function giveawayRegistrationHelpMessage() {
    return (
        `❌ I could not find your Penguin Mafia player profile.\n\n` +
        `If you already finished welcome, run this once to refresh your linked account:\n` +
        `\`/penguinlink ign:<your ign> edition:<java or bedrock>\``
    );
}

function giveawayLinkHelpMessage(player = null) {
    const currentIgn = player?.minecraft_ign
        ? `\nCurrent IGN on file: **${player.minecraft_ign}**`
        : '';
    const missingEdition = player?.minecraft_ign && !player?.minecraft_edition
        ? `\nYour IGN is linked, but your Minecraft edition is missing.`
        : '';

    return (
        `❌ Your Minecraft account link is incomplete.${currentIgn}${missingEdition}\n\n` +
        `Please refresh it with:\n` +
        `\`/penguinlink ign:<your ign> edition:<java or bedrock>\`\n\n` +
        `Then try entering the giveaway again.`
    );
}

async function fetchGiveawayPlayer(discordId, db = sql) {
    const rows = await db`
        select
            discord_id,
            minecraft_ign,
            minecraft_edition,
            status,
            welcome_completed
        from players
        where discord_id = ${discordId}
        limit 1
    `;

    return rows[0] || null;
}

async function restoreActiveGiveawayPlayer(player, db = sql) {
    if (!player?.discord_id || player.status === 'active') {
        return player;
    }

    const rows = await db`
        update players
        set
            status = 'active',
            updated_at = now()
        where discord_id = ${player.discord_id}
            and minecraft_ign is not null
            and minecraft_edition is not null
        returning
            discord_id,
            minecraft_ign,
            minecraft_edition,
            status,
            welcome_completed
    `;

    return rows[0] || player;
}

function giveawayPaymentBotUser() {
    return process.env.BOT_USER?.trim() || DEFAULT_PAYMENT_BOT_USER;
}

function normalizeMinecraftUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function parseMinecraftPaymentAmount(amount) {
    const normalizedAmount = String(amount || '').replace(/[$,\s]/g, '');

    return parseDonationAmount(normalizedAmount);
}

function parseGiveawayDuration(input) {
    const rawDuration = input.trim().toLowerCase();
    const unitMilliseconds = {
        m: 60 * 1000,
        min: 60 * 1000,
        mins: 60 * 1000,
        minute: 60 * 1000,
        minutes: 60 * 1000,
        h: 60 * 60 * 1000,
        hr: 60 * 60 * 1000,
        hrs: 60 * 60 * 1000,
        hour: 60 * 60 * 1000,
        hours: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
        w: WEEK_MS,
        week: WEEK_MS,
        weeks: WEEK_MS
    };
    const tokenPattern = /(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)/g;
    let durationMs = 0;
    let matchedText = '';
    let match;

    while ((match = tokenPattern.exec(rawDuration)) !== null) {
        durationMs += Number(match[1]) * unitMilliseconds[match[2]];
        matchedText += match[0];
    }

    const normalizedInput = rawDuration.replace(/\s+/g, '');
    const normalizedMatches = matchedText.replace(/\s+/g, '');

    if (!matchedText || normalizedMatches !== normalizedInput) {
        throw new Error('Use a duration like `30m`, `1h`, `1 hour`, `2h 30m`, `1d`, or `1w`.');
    }

    if (durationMs < MIN_GIVEAWAY_DURATION_MS) {
        throw new Error('Giveaway duration must be at least 1 minute.');
    }

    if (durationMs > MAX_GIVEAWAY_DURATION_MS) {
        throw new Error('Giveaway duration cannot be longer than 7 days.');
    }

    return durationMs;
}

function maxGiveawayDurationForAmount(amount) {
    const prizeAmount = BigInt(amount);

    if (prizeAmount < DAILY_GIVEAWAY_AMOUNT_STEP) {
        return Number(prizeAmount / MILLION_AMOUNT) * HOUR_MS;
    }

    const unlockedDays = Number(prizeAmount / DAILY_GIVEAWAY_AMOUNT_STEP);

    return Math.min(unlockedDays * DAY_MS, MAX_GIVEAWAY_DURATION_MS);
}

function formatDurationLimit(durationMs) {
    if (durationMs >= DAY_MS) {
        const days = durationMs / DAY_MS;

        if (days === 7) {
            return '7 days / 1 week';
        }

        return `${days} day${days === 1 ? '' : 's'}`;
    }

    const hours = durationMs / HOUR_MS;

    if (hours >= 1) {
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }

    const minutes = Math.max(1, durationMs / (60 * 1000));

    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function validateGiveawayDurationForAmount(amount, durationMs) {
    const maxDurationMs = maxGiveawayDurationForAmount(amount);

    if (durationMs <= maxDurationMs) {
        return true;
    }

    throw new Error(
        `That prize pool can run for up to **${formatDurationLimit(maxDurationMs)}**.\n` +
        `Duration limits: every full **1m** unlocks **1 hour** up to **20m**; ` +
        `then every full **20m** unlocks **1 day**, capped at **7 days / 1 week**.`
    );
}

function enterGiveawayButton(giveawayId, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(`${GIVEAWAY_BUTTON_PREFIX}${giveawayId}`)
        .setLabel('Enter')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled);
}

function leaveGiveawayButton(giveawayId, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(`${GIVEAWAY_LEAVE_BUTTON_PREFIX}${giveawayId}`)
        .setLabel('Leave')
        .setEmoji('👋')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
}

function enterAllGiveawaysButton(disabled = false) {
    return new ButtonBuilder()
        .setCustomId(GIVEAWAY_ENTER_ALL_BUTTON_ID)
        .setLabel('Enter All')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled);
}

function leaveAllGiveawaysButton(disabled = false) {
    return new ButtonBuilder()
        .setCustomId(GIVEAWAY_LEAVE_ALL_BUTTON_ID)
        .setLabel('Leave All')
        .setEmoji('👋')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
}

function giveawayNotifyButton() {
    return new ButtonBuilder()
        .setCustomId(GIVEAWAY_NOTIFY_BUTTON_ID)
        .setLabel('Notify Me')
        .setEmoji('🔔')
        .setStyle(ButtonStyle.Primary);
}

function renderGiveawayHostControls(giveaway, options = {}) {
    const title = options.private === false
        ? `🎛️ **Giveaway Controls for <@${giveaway.host_discord_id}>**`
        : '🎛️ **Private Giveaway Controls**';
    const visibilityLine = options.private === false
        ? 'Only the giveaway host can use these buttons.'
        : 'Only you can see this panel.';

    return {
        content:
            `${title}\n\n` +
            `${visibilityLine}\n` +
            `**End Giveaway** closes entries and randomly picks a winner.\n` +
            `The original giveaway post is deleted immediately when it ends.\n` +
            `**Close Giveaway Messages** deletes the remaining winner and payout results.\n\n` +
            `If you do not close them manually, the result messages are deleted automatically **12 hours after it ends**.`,
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${GIVEAWAY_END_BUTTON_PREFIX}${giveaway.id}`)
                    .setLabel('End Giveaway & Pick Winner')
                    .setEmoji('🏁')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`${GIVEAWAY_CLOSE_BUTTON_PREFIX}${giveaway.id}`)
                    .setLabel('Close Giveaway Messages')
                    .setEmoji('🗑️')
                    .setStyle(ButtonStyle.Secondary)
            )
        ]
    };
}

function renderGiveaway(giveaway, entrantCount, winnerId = null, options = {}) {
    const endsAt = Math.floor(new Date(giveaway.ends_at).getTime() / 1000);
    const ended = giveaway.status !== 'active';
    const result = ended
        ? (winnerId
            ? `Winner: <@${winnerId}>`
            : 'No winner was chosen because nobody entered.')
        : `Ends <t:${endsAt}:R> (<t:${endsAt}:F>)`;

    return {
        content:
            (!ended ? `<@&${GIVEAWAY_PING_ROLE_ID}>\n\n` : '') +
            `# 🎉 PENGUIN MAFIA GIVEAWAY\n\n` +
            `Prize Pool: **${formatDonationAmount(giveaway.amount)}**\n` +
            `Hosted by: <@${giveaway.host_discord_id}>\n` +
            (giveaway.sponsor_discord_id && giveaway.sponsor_discord_id !== giveaway.host_discord_id
                ? `Sponsored by: <@${giveaway.sponsor_discord_id}>\n`
                : '') +
            `${result}\n\n` +
            `Entrants: **${entrantCount}**\n\n` +
            (ended
                ? (winnerId
                    ? 'This giveaway has ended. The complete commission payout is shown below.'
                    : 'This giveaway has ended.')
                : (
                    `If you win, you receive **your rank commission percentage** of the prize.\n` +
                    `The rest follows your recruiter chain using the exact same commission split as \`/pay\`.`
                )),
        components: [
            new ActionRowBuilder().addComponents(
                enterGiveawayButton(giveaway.id, ended),
                leaveGiveawayButton(giveaway.id, ended)
            )
        ],
        allowedMentions: {
            users: winnerId ? [winnerId] : [],
            roles: !ended && options.pingGiveawayRole
                ? [GIVEAWAY_PING_ROLE_ID]
                : []
        }
    };
}

function renderActiveGiveawaysBoard(activeGiveaways) {
    const hasActiveGiveaways = activeGiveaways.length > 0;
    const totalAmount = totalGiveawayAmount(activeGiveaways);
    const lines = [
        '# 🎉 ACTIVE GIVEAWAYS',
        ''
    ].filter(line => line !== null);

    if (!hasActiveGiveaways) {
        lines.push('No active giveaways right now.');
    }

    for (let index = 0; index < activeGiveaways.length; index++) {
        const giveaway = activeGiveaways[index];
        const endsAt = Math.floor(new Date(giveaway.ends_at).getTime() / 1000);
        const entrantCount = Number(giveaway.entrant_count || 0);
        const line =
            `${index + 1}. <@${giveaway.host_discord_id}> | ` +
            `**${formatDonationAmount(giveaway.amount)}** | ` +
            `<t:${endsAt}:R> | ` +
            `**${entrantCount}** ${entrantCount === 1 ? 'entry' : 'entries'}`;

        if (lines.join('\n').length + line.length > 1750) {
            lines.push(`...and **${activeGiveaways.length - index}** more active giveaway${activeGiveaways.length - index === 1 ? '' : 's'}.`);
            break;
        }

        lines.push(line);
    }

    if (hasActiveGiveaways) {
        lines.push('', `Total active prize pool: **${formatDonationAmount(totalAmount)}**`);
    }

    return {
        content: lines.join('\n').trim(),
        components: [
            new ActionRowBuilder().addComponents(
                enterAllGiveawaysButton(!hasActiveGiveaways),
                leaveAllGiveawaysButton(!hasActiveGiveaways),
                giveawayNotifyButton()
            )
        ],
        allowedMentions: {
            parse: []
        }
    };
}

function totalGiveawayAmount(giveaways) {
    return giveaways.reduce((total, giveaway) => {
        return total + BigInt(giveaway.amount);
    }, 0n);
}

async function createGiveaway(options, db = sql) {
    const endsAt = new Date(Date.now() + options.durationMs);
    const rows = await db`
        insert into giveaways (
            guild_id,
            channel_id,
            host_discord_id,
            sponsor_discord_id,
            amount,
            ends_at
        )
        values (
            ${options.guildId},
            ${options.channelId},
            ${options.hostDiscordId},
            ${options.sponsorDiscordId || options.hostDiscordId},
            ${options.amount.toString()}::bigint,
            ${endsAt}
        )
        returning *
    `;

    return rows[0];
}

async function createSponsoredGiveawayRequest(options, db = sql) {
    await db`
        update giveaway_payment_requests
        set status = 'cancelled', updated_at = now()
        where guild_id = ${options.guildId}
            and sponsor_discord_id = ${options.sponsorDiscordId}
            and status in ('awaiting_acceptance', 'pending_payment')
    `;

    const rows = await db`
        insert into giveaway_payment_requests (
            guild_id,
            channel_id,
            host_discord_id,
            host_minecraft_ign,
            payment_bot_user,
            sponsor_discord_id,
            amount,
            duration_ms,
            status
        )
        values (
            ${options.guildId},
            ${options.channelId},
            ${options.hostDiscordId},
            ${options.hostMinecraftIgn},
            ${options.hostMinecraftIgn},
            ${options.sponsorDiscordId},
            ${options.amount.toString()}::bigint,
            ${options.durationMs.toString()}::bigint,
            'awaiting_acceptance'
        )
        returning *
    `;

    return rows[0];
}

async function sendSponsoredGiveawayHostRequest(guild, request) {
    const host = guild.client.users.cache.get(request.host_discord_id) ||
        await guild.client.users.fetch(request.host_discord_id).catch(() => null);

    if (!host) {
        throw new Error('The selected payment host could not be reached on Discord.');
    }

    return host.send(sponsoredGiveawayHostRequestPayload(request));
}

async function createGiveawayPaymentRequest(options, db = sql) {
    await db`
        update giveaway_payment_requests
        set
            status = 'cancelled',
            updated_at = now()
        where guild_id = ${options.guildId}
            and host_discord_id = ${options.hostDiscordId}
            and status = 'pending'
    `;

    const rows = await db`
        insert into giveaway_payment_requests (
            guild_id,
            channel_id,
            host_discord_id,
            host_minecraft_ign,
            payment_bot_user,
            amount,
            duration_ms
        )
        values (
            ${options.guildId},
            ${options.channelId},
            ${options.hostDiscordId},
            ${options.hostMinecraftIgn},
            ${options.paymentBotUser},
            ${options.amount.toString()}::bigint,
            ${options.durationMs.toString()}::bigint
        )
        returning *
    `;

    return rows[0];
}

async function createDonationPaymentRequest(options, db = sql) {
    await db`
        update donation_payment_requests
        set
            status = 'cancelled',
            updated_at = now()
        where guild_id = ${options.guildId}
            and donor_discord_id = ${options.donorDiscordId}
            and status = 'pending'
    `;

    const rows = await db`
        insert into donation_payment_requests (
            guild_id,
            donor_discord_id,
            donor_minecraft_ign,
            payment_bot_user,
            amount
        )
        values (
            ${options.guildId},
            ${options.donorDiscordId},
            ${options.donorMinecraftIgn},
            ${options.paymentBotUser},
            ${options.amount.toString()}::bigint
        )
        returning *
    `;

    return rows[0];
}

async function fetchGiveawayChannel(guild, giveaway) {
    const channel = guild.channels.cache.get(giveaway.channel_id) ||
        (await guild.channels.fetch(giveaway.channel_id).catch(() => null));

    if (!channel?.isTextBased()) {
        return null;
    }

    return channel;
}

async function fetchGiveawayWinnerChannel(guild) {
    const configuredChannel = await fetchGiveawayTextChannel(
        guild,
        GIVEAWAY_WINNER_CHANNEL_ID
    );

    if (configuredChannel) {
        return configuredChannel;
    }

    // Discord channel IDs change when a channel is deleted and recreated. Find
    // the replacement by name so a stale environment variable cannot silently
    // suppress every winner announcement.
    const cachedChannel = guild.channels.cache.find(channel => {
        return channel?.isTextBased() &&
            String(channel.name || '').toLowerCase().includes('giveaway-winners');
    });

    if (cachedChannel) {
        console.warn(
            `Configured giveaway winner channel ${GIVEAWAY_WINNER_CHANNEL_ID} was not found; ` +
            `using #${cachedChannel.name} (${cachedChannel.id}).`
        );
        return cachedChannel;
    }

    const fetchedChannels = await guild.channels.fetch().catch(() => null);
    const fetchedChannel = fetchedChannels?.find(channel => {
        return channel?.isTextBased() &&
            String(channel.name || '').toLowerCase().includes('giveaway-winners');
    }) || null;

    if (fetchedChannel) {
        console.warn(
            `Configured giveaway winner channel ${GIVEAWAY_WINNER_CHANNEL_ID} was not found; ` +
            `using #${fetchedChannel.name} (${fetchedChannel.id}).`
        );
    }

    return fetchedChannel;
}

async function fetchGiveawayAnnouncementChannel(guild) {
    const configuredChannel = await fetchGiveawayTextChannel(
        guild,
        GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID
    );

    if (configuredChannel) {
        return configuredChannel;
    }

    // Discord channel IDs change when a channel is deleted and recreated. Fall
    // back to the server's general chat by name so a stale environment
    // variable cannot silently suppress every giveaway-starting announcement
    // (which is supposed to appear in general chat).
    const isGeneralChat = channel => channel?.isTextBased() &&
        /general/i.test(String(channel.name || ''));

    const cachedChannel = guild.channels.cache.find(isGeneralChat);

    if (cachedChannel) {
        console.warn(
            `Configured giveaway announcement channel ${GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID} was not found; ` +
            `using #${cachedChannel.name} (${cachedChannel.id}).`
        );
        return cachedChannel;
    }

    const fetchedChannels = await guild.channels.fetch().catch(() => null);
    const fetchedChannel = fetchedChannels?.find(isGeneralChat) || null;

    if (fetchedChannel) {
        console.warn(
            `Configured giveaway announcement channel ${GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID} was not found; ` +
            `using #${fetchedChannel.name} (${fetchedChannel.id}).`
        );
    }

    return fetchedChannel;
}

async function fetchGiveawayResultChannels(guild, giveaway) {
    const winnerChannel = await fetchGiveawayWinnerChannel(guild);
    const originalChannel = await fetchGiveawayChannel(guild, giveaway);

    return [winnerChannel, originalChannel].filter((channel, index, channels) => {
        return channel && channels.findIndex(candidate => candidate.id === channel.id) === index;
    });
}

async function fetchGiveawayMessage(channel, giveaway) {
    if (!giveaway.message_id) {
        return null;
    }

    return channel.messages.fetch(giveaway.message_id).catch(() => null);
}

async function fetchActiveGiveawayRows(guildId, db = sql) {
    return db`
        select
            g.*,
            coalesce(entry_counts.entrant_count, 0)::int as entrant_count
        from giveaways g
        left join (
            select
                giveaway_id,
                count(*)::int as entrant_count
            from giveaway_entries
            group by giveaway_id
        ) entry_counts
            on entry_counts.giveaway_id = g.id
        where g.guild_id = ${guildId}
            and g.status = 'active'
            and g.ends_at > now()
        order by g.ends_at desc, g.id desc
    `;
}

async function activeGiveawayTotalAmount(guildId, db = sql) {
    const activeGiveaways = await fetchActiveGiveawayRows(guildId, db);

    return totalGiveawayAmount(activeGiveaways);
}

async function fetchGiveawayTextChannel(guild, channelId) {
    const channel = guild.channels.cache.get(channelId) ||
        (await guild.channels.fetch(channelId).catch(() => null));

    if (!channel?.isTextBased()) {
        return null;
    }

    return channel;
}

async function fetchGiveawayBoardMessage(channel, guildId, db = sql) {
    const boardRows = await db`
        select message_id
        from giveaway_boards
        where guild_id = ${guildId}
        limit 1
    `;
    const boardMessageId = boardRows[0]?.message_id || null;

    if (boardMessageId) {
        const message = await channel.messages.fetch(boardMessageId).catch(() => null);

        if (message) {
            return message;
        }
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);

    return recentMessages?.find(message => {
        return message.author.id === channel.client.user.id &&
            message.content.includes('ACTIVE GIVEAWAYS');
    }) || null;
}

async function upsertActiveGiveawaysBoard(guild, db = sql) {
    const channel = await fetchGiveawayTextChannel(guild, GIVEAWAY_CHANNEL_ID);

    if (!channel) {
        console.error(
            `Could not post the active giveaways board for ${guild.name}: ` +
            `configured giveaway channel ${GIVEAWAY_CHANNEL_ID} was not found.`
        );
        return null;
    }

    const activeGiveaways = await fetchActiveGiveawayRows(guild.id, db);
    const payload = renderActiveGiveawaysBoard(activeGiveaways);
    let message = await fetchGiveawayBoardMessage(channel, guild.id, db);

    if (message) {
        message = await message.edit(payload);
    } else {
        message = await channel.send(payload);
    }

    await db`
        insert into giveaway_boards (
            guild_id,
            channel_id,
            message_id,
            updated_at
        )
        values (
            ${guild.id},
            ${channel.id},
            ${message.id},
            now()
        )
        on conflict (guild_id) do update
        set
            channel_id = excluded.channel_id,
            message_id = excluded.message_id,
            updated_at = now()
    `;

    return message;
}

function scheduleCoalescedTask(tasks, key, delayMs, runner, errorLabel) {
    let task = tasks.get(key);

    if (!task) {
        task = {
            running: false,
            timer: null,
            pending: false,
            runner,
            errorLabel
        };
        tasks.set(key, task);
    }

    task.runner = runner;
    task.errorLabel = errorLabel;
    task.pending = true;

    if (task.timer) {
        clearTimeout(task.timer);
        task.timer = null;
    }

    if (!task.running) {
        task.timer = setTimeout(() => {
            runCoalescedTask(tasks, key, delayMs);
        }, delayMs);
    }
}

async function runCoalescedTask(tasks, key, delayMs) {
    const task = tasks.get(key);

    if (!task || task.running) {
        return;
    }

    if (task.timer) {
        clearTimeout(task.timer);
        task.timer = null;
    }

    task.running = true;
    task.pending = false;

    try {
        await task.runner();
    } catch (error) {
        console.error(task.errorLabel || `Scheduled task ${key} failed:`);
        console.error(error);
    } finally {
        task.running = false;

        if (task.pending) {
            task.timer = setTimeout(() => {
                runCoalescedTask(tasks, key, delayMs);
            }, delayMs);
        } else {
            tasks.delete(key);
        }
    }
}

function scheduleActiveGiveawaysBoardRefresh(guild, db = sql) {
    scheduleCoalescedTask(
        activeGiveawaysBoardRefreshes,
        guild.id,
        ACTIVE_GIVEAWAYS_BOARD_REFRESH_DELAY_MS,
        () => upsertActiveGiveawaysBoard(guild, db),
        `Could not refresh active giveaway board for ${guild.name}:`
    );
}

function scheduleDonationLeaderboardRefresh(guild, db = sql) {
    scheduleCoalescedTask(
        donationLeaderboardRefreshes,
        guild.id,
        DONATION_LEADERBOARD_REFRESH_DELAY_MS,
        () => updateDonationLeaderboardForGuild(guild, db),
        `Could not refresh donation leaderboard for ${guild.name}:`
    );
}

async function refreshGiveawayMessage(guild, giveawayId, db = sql, fallbackMessage = null) {
    const rows = await db`
        select *
        from giveaways
        where id = ${giveawayId}
        limit 1
    `;
    const giveaway = rows[0];

    if (!giveaway) {
        return null;
    }

    const countRows = await db`
        select count(*)::int as count
        from giveaway_entries
        where giveaway_id = ${giveaway.id}
    `;
    const entrantCount = countRows[0].count;
    const channel = fallbackMessage ? null : await fetchGiveawayChannel(guild, giveaway);
    const message = fallbackMessage ||
        (channel ? await fetchGiveawayMessage(channel, giveaway) : null);

    if (!message) {
        return null;
    }

    return message.edit(renderGiveaway(giveaway, entrantCount, giveaway.winner_discord_id));
}

function scheduleGiveawayMessageRefresh(guild, giveawayId, db = sql, fallbackMessage = null) {
    scheduleCoalescedTask(
        giveawayMessageRefreshes,
        `${guild.id}:${giveawayId}`,
        GIVEAWAY_MESSAGE_REFRESH_DELAY_MS,
        () => refreshGiveawayMessage(guild, giveawayId, db, fallbackMessage),
        `Could not refresh giveaway message ${giveawayId} for ${guild.name}:`
    );
}

async function announceGiveawayStarted(guild, giveaway, boardMessage = null, totalActiveAmount = null) {
    const announcementChannel = await fetchGiveawayAnnouncementChannel(guild);

    if (!announcementChannel) {
        console.error(
            `Giveaway-starting announcement could not be sent for ${guild.name}: ` +
            `configured announcement channel ${GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID} was not found and no #general chat exists.`
        );
        return null;
    }

    const totalLine = totalActiveAmount === null
        ? ''
        : `\nTotal active giveaway money in <#${GIVEAWAY_CHANNEL_ID}>: **${formatDonationAmount(totalActiveAmount)}**.`;

    try {
        return await announcementChannel.send({
            content:
                `<@&${GIVEAWAY_PING_ROLE_ID}>\n\n` +
                (giveaway.sponsor_discord_id && giveaway.sponsor_discord_id !== giveaway.host_discord_id
                    ? `<@${giveaway.sponsor_discord_id}> sponsored a **${formatDonationAmount(giveaway.amount)}** giveaway hosted by <@${giveaway.host_discord_id}>. `
                    : `<@${giveaway.host_discord_id}> started a **${formatDonationAmount(giveaway.amount)}** giveaway. `) +
                `Go to <#${GIVEAWAY_CHANNEL_ID}> to join.` +
                totalLine +
                (boardMessage ? `\n${boardMessage.url}` : ''),
            allowedMentions: {
                roles: [GIVEAWAY_PING_ROLE_ID],
                users: [...new Set(
                    [giveaway.host_discord_id, giveaway.sponsor_discord_id].filter(Boolean)
                )]
            }
        });
    } catch (error) {
        // A missing/inaccessible announcement channel should log loudly
        // instead of failing the whole giveaway-creation command.
        console.error(`Could not post giveaway-starting announcement for ${guild.name}:`);
        console.error(error);
        return null;
    }
}

async function recordGiveawayDonation(guild, giveaway, db = sql) {
    const creditedPlayerId = giveaway.sponsor_discord_id || giveaway.host_discord_id;
    const rows = await db`
        update players
        set
            donations = donations + ${BigInt(giveaway.amount).toString()}::bigint,
            updated_at = now()
        where discord_id = ${creditedPlayerId}
        returning donations
    `;
    const donationRow = rows[0];

    if (!donationRow) {
        throw new Error(`Giveaway sponsor ${creditedPlayerId} was not found while recording donation credit.`);
    }

    await postGiveawayDonationEvent(guild, {
        playerId: creditedPlayerId,
        amount: BigInt(giveaway.amount),
        newTotal: donationRow.donations
    }).catch(error => {
        console.error(`Could not post giveaway donation event for giveaway ${giveaway.id}:`);
        console.error(error);
        return false;
    });

    scheduleDonationLeaderboardRefresh(guild, db);

    return donationRow.donations;
}

async function findPlayerByMinecraftPaymentName(minecraftName, db = sql) {
    const normalizedName = normalizeMinecraftUsername(minecraftName);
    const nameWithoutLeadingDot = normalizedName.startsWith('.')
        ? normalizedName.slice(1)
        : normalizedName;

    if (!normalizedName) {
        return null;
    }

    const rows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            minecraft_edition,
            donations
        from players
        where minecraft_ign is not null
            and (
                lower(minecraft_ign) = ${normalizedName}
                or lower(minecraft_ign) = ${nameWithoutLeadingDot}
                or (
                    minecraft_edition = 'bedrock'
                    and lower(concat('.', minecraft_ign)) = ${normalizedName}
                )
            )
        order by
            case
                when lower(minecraft_ign) = ${normalizedName} then 0
                when minecraft_edition = 'bedrock' and lower(concat('.', minecraft_ign)) = ${normalizedName} then 1
                else 2
            end,
            updated_at desc
        limit 1
    `;

    return rows[0] || null;
}

async function recordDirectDonation(guild, playerId, amount, db = sql, options = {}) {
    const donationAmount = BigInt(amount);

    if (donationAmount <= 0n) {
        return null;
    }

    const rows = await db`
        update players
        set
            donations = donations + ${donationAmount.toString()}::bigint,
            updated_at = now()
        where discord_id = ${playerId}
        returning donations
    `;
    const donationRow = rows[0];

    if (!donationRow) {
        throw new Error(`Player ${playerId} was not found while recording donation credit.`);
    }

    await postDonationEvent(guild, {
        playerId,
        amount: donationAmount,
        newTotal: donationRow.donations
    }).catch(error => {
        console.error(`Could not post donation event for ${options.source || 'Minecraft payment'}:`);
        console.error(error);
        return false;
    });

    scheduleDonationLeaderboardRefresh(guild, db);

    return {
        playerId,
        amount: donationAmount,
        newTotal: donationRow.donations
    };
}

function weeklyElectionAndGiveawayReminderMessage(totalAmount) {
    const giveawayLine = totalAmount > 0n
        ? `There is currently **${formatDonationAmount(totalAmount)}** in active giveaway prize pools in <#${GIVEAWAY_CHANNEL_ID}>.`
        : `There are no active giveaway prize pools right now, but new giveaways are posted in <#${GIVEAWAY_CHANNEL_ID}>.`;

    return (
        `🗳️🐧 **Penguin Mafia DON Election Started!** 🐧🗳️\n\n` +
        `The weekly 24-hour election is open. Vote for the next **DON** with:\n` +
        `\`/vote player:@Player\`\n\n` +
        `Every player gets **1 vote**. You can vote for yourself, and you can change your vote any time before the election ends.\n` +
        `Received-vote transfers with \`/transfervotes\` close during the final **12 hours**.\n` +
        `Vote and watch the leaderboard in <#${ELECTION_LEADERBOARD_CHANNEL_ID}>.\n\n` +
        `If Discord says you are not registered yet, finish the welcome onboarding first.\n\n` +
        `🎉 **Giveaway Reminder**\n` +
        `${giveawayLine}\n\n` +
        `Want giveaway pings? Use the **Notify Me** button in the giveaway channel or react in <#${REACTION_ROLES_CHANNEL_ID}>.`
    );
}

async function sendWeeklyElectionAndGiveawayReminderForGuild(guild, db = sql) {
    const totalAmount = await activeGiveawayTotalAmount(guild.id, db);
    const members = await guild.members.fetch();
    const message = weeklyElectionAndGiveawayReminderMessage(totalAmount);
    let sent = 0;
    let failed = 0;
    let skippedMembers = 0;

    for (const [, member] of members) {
        if (!member || member.user.bot) {
            skippedMembers += 1;
            continue;
        }

        await member.send({
            content: message,
            components: [dismissRow(member.id)],
            allowedMentions: {
                parse: []
            }
        }).then(() => {
            sent += 1;
        }).catch(error => {
            failed += 1;
            console.log(`Could not DM weekly election/giveaway reminder to ${member.user.id}: ${error.message}`);
        });
    }

    return {
        sent,
        failed,
        skippedMembers,
        checked: members.size,
        skipped: false,
        totalAmount
    };
}

async function sendWeeklyGiveawayPingReminderForGuild(guild, db = sql) {
    return sendWeeklyElectionAndGiveawayReminderForGuild(guild, db);
}

async function startFundedGiveaway(guild, options, db = sql) {
    const giveaway = await createGiveaway({
        guildId: options.guildId,
        channelId: options.channelId,
        hostDiscordId: options.hostDiscordId,
        sponsorDiscordId: options.sponsorDiscordId || options.hostDiscordId,
        amount: options.amount,
        durationMs: options.durationMs
    }, db);
    const activeGiveaways = await fetchActiveGiveawayRows(guild.id, db);
    const totalActiveAmount = totalGiveawayAmount(activeGiveaways);

    scheduleActiveGiveawaysBoardRefresh(guild, db);
    await recordGiveawayDonation(guild, giveaway, db);
    await announceGiveawayStarted(guild, giveaway, null, totalActiveAmount);

    return {
        giveaway,
        boardMessage: null
    };
}

async function processIncomingGiveawayPayment(guild, payment, db = sql) {
    const paymentPlayer = normalizeMinecraftUsername(payment.player);
    const paymentPlayerWithoutLeadingDot = paymentPlayer.startsWith('.')
        ? paymentPlayer.slice(1)
        : paymentPlayer;
    let paidAmount;

    if (!paymentPlayer) {
        return {
            status: 'ignored'
        };
    }

    try {
        paidAmount = parseMinecraftPaymentAmount(payment.amount);
    } catch {
        return {
            status: 'ignored'
        };
    }

    const acceptablePaidAmount = paidAmount + GIVEAWAY_PAYMENT_MATCH_TOLERANCE;
    const matchingRows = await db`
        select *
        from giveaway_payment_requests
        where guild_id = ${guild.id}
            and status = 'pending'
            and (
                lower(host_minecraft_ign) = ${paymentPlayer}
                or lower(host_minecraft_ign) = ${paymentPlayerWithoutLeadingDot}
                or lower(concat('.', host_minecraft_ign)) = ${paymentPlayer}
            )
            and amount <= ${acceptablePaidAmount.toString()}::bigint
        order by created_at asc
        limit 1
    `;
    const request = matchingRows[0];

    if (!request) {
        const lowRows = await db`
            select *
            from giveaway_payment_requests
            where guild_id = ${guild.id}
                and status = 'pending'
                and (
                    lower(host_minecraft_ign) = ${paymentPlayer}
                    or lower(host_minecraft_ign) = ${paymentPlayerWithoutLeadingDot}
                    or lower(concat('.', host_minecraft_ign)) = ${paymentPlayer}
                )
            order by created_at asc
            limit 1
        `;

        if (lowRows[0]) {
            return {
                status: 'too_low',
                request: lowRows[0],
                paidAmount
            };
        }

        const donationRows = await db`
            select *
            from donation_payment_requests
            where guild_id = ${guild.id}
                and status = 'pending'
                and (
                    lower(donor_minecraft_ign) = ${paymentPlayer}
                    or lower(donor_minecraft_ign) = ${paymentPlayerWithoutLeadingDot}
                    or lower(concat('.', donor_minecraft_ign)) = ${paymentPlayer}
                )
                and amount <= ${paidAmount.toString()}::bigint
            order by created_at asc
            limit 1
        `;
        const donationRequest = donationRows[0];

        if (!donationRequest) {
            const lowDonationRows = await db`
                select *
                from donation_payment_requests
                where guild_id = ${guild.id}
                    and status = 'pending'
                    and (
                        lower(donor_minecraft_ign) = ${paymentPlayer}
                        or lower(donor_minecraft_ign) = ${paymentPlayerWithoutLeadingDot}
                        or lower(concat('.', donor_minecraft_ign)) = ${paymentPlayer}
                    )
                order by created_at asc
                limit 1
            `;

            if (lowDonationRows[0]) {
                return {
                    status: 'donation_too_low',
                    request: lowDonationRows[0],
                    paidAmount
                };
            }

            return {
                status: 'donation_unmatched',
                minecraftName: payment.player,
                paidAmount
            };
        }

        const claimedDonationRows = await db`
            update donation_payment_requests
            set
                status = 'processing',
                paid_amount = ${paidAmount.toString()}::bigint,
                payment_message = ${payment.message || null},
                paid_at = now(),
                updated_at = now()
            where id = ${donationRequest.id}
                and status = 'pending'
            returning *
        `;
        const claimedDonationRequest = claimedDonationRows[0];

        if (!claimedDonationRequest) {
            return {
                status: 'already_processing'
            };
        }

        try {
            const donation = await recordDirectDonation(
                guild,
                claimedDonationRequest.donor_discord_id,
                paidAmount,
                db,
                {
                    source: `donation request ${claimedDonationRequest.id}`
                }
            );

            await db`
                update donation_payment_requests
                set
                    status = 'recorded',
                    updated_at = now()
                where id = ${claimedDonationRequest.id}
            `;

            return {
                status: 'donation_recorded',
                request: claimedDonationRequest,
                donation,
                paidAmount
            };
        } catch (error) {
            await db`
                update donation_payment_requests
                set
                    status = 'failed',
                    updated_at = now()
                where id = ${claimedDonationRequest.id}
            `;

            throw error;
        }
    }

    const claimedRows = await db`
        update giveaway_payment_requests
        set
            status = 'processing',
            paid_amount = ${paidAmount.toString()}::bigint,
            payment_message = ${payment.message || null},
            paid_at = now(),
            updated_at = now()
        where id = ${request.id}
            and status = 'pending'
        returning *
    `;
    const claimedRequest = claimedRows[0];

    if (!claimedRequest) {
        return {
            status: 'already_processing'
        };
    }

    try {
        const {
            giveaway,
            boardMessage
        } = await startFundedGiveaway(guild, {
            guildId: claimedRequest.guild_id,
            channelId: claimedRequest.channel_id,
            hostDiscordId: claimedRequest.host_discord_id,
            amount: BigInt(claimedRequest.amount),
            durationMs: Number(claimedRequest.duration_ms)
        }, db);

        await db`
            update giveaway_payment_requests
            set
                status = 'hosted',
                giveaway_id = ${giveaway.id},
                updated_at = now()
            where id = ${claimedRequest.id}
        `;

        const requestedAmount = BigInt(claimedRequest.amount);
        const overpaidAmount = paidAmount - requestedAmount;
        const acceptedShortfallAmount = overpaidAmount < 0n ? -overpaidAmount : 0n;
        const overpaidDonation = overpaidAmount > 0n
            ? await recordDirectDonation(
                guild,
                claimedRequest.host_discord_id,
                overpaidAmount,
                db,
                {
                    source: `giveaway overpayment for request ${claimedRequest.id}`
                }
            )
            : null;

        return {
            status: 'hosted',
            request: claimedRequest,
            giveaway,
            message: boardMessage,
            paidAmount,
            overpaidAmount,
            acceptedShortfallAmount,
            overpaidDonation
        };
    } catch (error) {
        await db`
            update giveaway_payment_requests
            set
                status = 'failed',
                updated_at = now()
            where id = ${claimedRequest.id}
        `;

        throw error;
    }
}

function manualGiveawayPayoutDetails(payoutResult) {
    const commands = [];
    const unresolved = [];

    for (const payout of payoutResult?.payouts || []) {
        const amountCents = BigInt(payout.amountCents || 0);

        if (amountCents <= 0n) {
            continue;
        }

        const player = payout.player || {};
        const validEdition = ['java', 'bedrock'].includes(player.minecraft_edition);

        if (!player.minecraft_ign || !validEdition) {
            const playerLabel = player.discord_id
                ? `<@${player.discord_id}>`
                : player.discord_display_name || player.discord_username || 'Unknown player';
            unresolved.push(
                `${playerLabel} — ${formatMinecraftPaymentAmountFromCents(amountCents)} ` +
                '(missing a complete Minecraft account link)'
            );
            continue;
        }

        commands.push(
            `/pay ${formattedMinecraftIgn(player)} ` +
            `${formatMinecraftPaymentAmountFromCents(amountCents)}`
        );
    }

    return { commands, unresolved };
}

function chunkPayoutLines(lines, maxCharacters = 1_500) {
    const chunks = [];
    let current = [];
    let currentLength = 0;

    for (const line of lines) {
        const additionLength = line.length + (current.length > 0 ? 1 : 0);

        if (current.length > 0 && currentLength + additionLength > maxCharacters) {
            chunks.push(current);
            current = [];
            currentLength = 0;
        }

        current.push(line);
        currentLength += line.length + (current.length > 1 ? 1 : 0);
    }

    if (current.length > 0) {
        chunks.push(current);
    }

    return chunks;
}

function manualGiveawayPayoutDmChunks(giveaway, payoutResult, winnerId) {
    const { commands, unresolved } = manualGiveawayPayoutDetails(payoutResult);
    const commandChunks = chunkPayoutLines(commands);
    const messages = [];
    const header =
        `# 🎁 Manual Giveaway Payouts\n\n` +
        `Giveaway: **#${giveaway.id}**\n` +
        `Winner: <@${winnerId}>\n` +
        `Amount: **${formatDonationAmount(giveaway.amount)}**\n\n`;

    if (commandChunks.length === 0) {
        messages.push(
            `${header}No copy-ready payment commands could be created. ` +
            `Review the unresolved recipients below before paying anyone.`
        );
    } else {
        commandChunks.forEach((lines, index) => {
            const intro = index === 0
                ? `${header}Copy and paste these commands into Minecraft:\n`
                : `# 🎁 Manual Giveaway Payouts — Continued\n\n`;
            messages.push(`${intro}\`\`\`text\n${lines.join('\n')}\n\`\`\``);
        });
    }

    for (const unresolvedChunk of chunkPayoutLines(unresolved)) {
        messages.push(
            `## ⚠️ Manual review required\n` +
            `The bot could not safely create commands for these recipients:\n\n` +
            `${unresolvedChunk.join('\n')}`
        );
    }

    return messages;
}

async function sendManualGiveawayPayoutDm(guild, giveaway, payoutResult, winnerId) {
    const host = guild.client.users.cache.get(giveaway.host_discord_id) ||
        await guild.client.users.fetch(giveaway.host_discord_id).catch(() => null);

    if (!host) {
        return false;
    }

    for (const content of manualGiveawayPayoutDmChunks(
        giveaway,
        payoutResult,
        winnerId
    )) {
        await host.send({
            content,
            components: [dismissRow(giveaway.host_discord_id)],
            allowedMentions: {
                parse: []
            }
        });
    }

    return true;
}

function payoutAnnouncementChunks(giveaway, payoutResult, winnerId) {
    const payoutLines = payoutResult.payouts.map((payout, index) => {
        return formatPayoutLine(payout, index, {
            includeDiscordMention: payout.amountCents > 0n,
            includeLabel: false
        });
    });
    const header =
        `# 🎉 GIVEAWAY WINNER & PAYOUT\n\n` +
        `Hosted by: <@${giveaway.host_discord_id}>\n` +
        `Winner: <@${winnerId}>\n` +
        `Giveaway amount: **${formatDonationAmount(giveaway.amount)}**\n` +
        `## Pay List\n`;
    const chunks = [];
    let current = header;

    for (const line of payoutLines) {
        const addition = `${current.endsWith('\n') ? '' : '\n'}${line}`;

        if (current.length + addition.length > 1850) {
            chunks.push(current);
            current = `## Pay List Continued\n${line}`;
        } else {
            current += addition;
        }
    }

    chunks.push(current);

    return chunks;
}

async function sendPayoutAnnouncement(channel, giveaway, payoutResult, winnerId) {
    const chunks = payoutAnnouncementChunks(giveaway, payoutResult, winnerId);
    const paidUserIds = [...new Set(
        payoutResult.payouts
            .filter(payout => payout.amountCents > 0n)
            .map(payout => payout.player.discord_id)
            .filter(Boolean)
    )];
    const sentMessageIds = [];

    for (let index = 0; index < chunks.length; index++) {
        const payload = {
            content: chunks[index],
            components: [dismissRow(giveaway.host_discord_id)],
            allowedMentions: {
                users: paidUserIds
            }
        };

        let sentMessage;

        sentMessage = await channel.send(payload);

        sentMessageIds.push(sentMessage.id);
    }

    return sentMessageIds;
}

async function refreshActiveGiveawaysBoard(guild, db = sql) {
    try {
        return await upsertActiveGiveawaysBoard(guild, db);
    } catch (error) {
        console.error(`Could not refresh active giveaway board for ${guild.name}:`);
        console.error(error);
        return null;
    }
}

function giveawayLinkModal(giveawayId, player) {
    const ignInput = new TextInputBuilder()
        .setCustomId('giveaway_link_ign')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Your Minecraft username')
        .setMinLength(3)
        .setMaxLength(16)
        .setRequired(true);

    if (player.minecraft_ign) {
        ignInput.setValue(player.minecraft_ign);
    }

    const editionSelect = new StringSelectMenuBuilder()
        .setCustomId('giveaway_link_edition')
        .setPlaceholder('Choose Java or Bedrock')
        .setRequired(true)
        .addOptions(
            {
                label: 'Java',
                value: 'java',
                default: player.minecraft_edition === 'java'
            },
            {
                label: 'Bedrock',
                value: 'bedrock',
                default: player.minecraft_edition === 'bedrock'
            }
        );

    return new ModalBuilder()
        .setCustomId(`${GIVEAWAY_LINK_MODAL_PREFIX}${giveawayId}`)
        .setTitle('Link Account & Enter')
        .addLabelComponents(
            new LabelBuilder()
                .setLabel('Minecraft IGN')
                .setDescription('Enter the account name that should receive payment.')
                .setTextInputComponent(ignInput),
            new LabelBuilder()
                .setLabel('Minecraft Edition')
                .setDescription('Choose the edition you play.')
                .setStringSelectMenuComponent(editionSelect)
        );
}

async function addGiveawayPingRole(interaction) {
    if (interaction.customId !== GIVEAWAY_NOTIFY_BUTTON_ID) {
        return false;
    }

    await interaction.deferReply({ ephemeral: true });

    const member = interaction.member ||
        (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));
    const role = interaction.guild.roles.cache.get(GIVEAWAY_PING_ROLE_ID) ||
        (await interaction.guild.roles.fetch(GIVEAWAY_PING_ROLE_ID).catch(() => null));

    if (!member) {
        await interaction.editReply('❌ Could not find your server member record.');
        return true;
    }

    if (!role) {
        await interaction.editReply('❌ The giveaway ping role is not configured correctly.');
        return true;
    }

    if (member.roles.cache.has(role.id)) {
        await interaction.editReply(`ℹ️ You already have ${role}.`);
        return true;
    }

    await member.roles.add(role, 'Selected giveaway notifications from active giveaway board');
    await interaction.editReply(`✅ You will be notified for new giveaways. Added ${role}.`);
    return true;
}

async function enterAllActiveGiveaways(interaction, db = sql) {
    if (interaction.customId !== GIVEAWAY_ENTER_ALL_BUTTON_ID) {
        return false;
    }

    await interaction.deferReply({ ephemeral: true });

    const player = await restoreActiveGiveawayPlayer(
        await fetchGiveawayPlayer(interaction.user.id, db),
        db
    );

    if (!player) {
        await interaction.editReply(giveawayRegistrationHelpMessage());
        return true;
    }

    if (!player.minecraft_ign || !player.minecraft_edition) {
        await interaction.editReply(giveawayLinkHelpMessage(player));
        return true;
    }

    const result = await enterAllActiveGiveawaysForUser(
        interaction.guild,
        interaction.user.id,
        db
    );

    if (result.eligible_count === 0) {
        await interaction.editReply(
            result.own_skipped > 0
                ? 'ℹ️ The only active giveaway is yours, so you were not entered.'
                : 'ℹ️ There are no active giveaways to enter right now.'
        );
        return true;
    }

    await interaction.editReply(
        `✅ Entered **${result.inserted_count}** new giveaway${result.inserted_count === 1 ? '' : 's'}. ` +
        `You are now in **${result.eligible_count}** active giveaway${result.eligible_count === 1 ? '' : 's'} you are eligible for.` +
        (result.own_skipped > 0 ? ` Skipped **${result.own_skipped}** of your own giveaway${result.own_skipped === 1 ? '' : 's'}.` : '')
    );
    return true;
}

async function enterAllActiveGiveawaysForUser(guild, userId, db = sql) {
    const resultRows = await db`
        with active_giveaways as (
            select id, host_discord_id
            from giveaways
            where guild_id = ${guild.id}
                and status = 'active'
                and ends_at > now()
        ),
        eligible_giveaways as (
            select id
            from active_giveaways
            where host_discord_id <> ${userId}
        ),
        inserted_entries as (
            insert into giveaway_entries (
                giveaway_id,
                player_discord_id
            )
            select
                id,
                ${userId}
            from eligible_giveaways
            on conflict (giveaway_id, player_discord_id) do nothing
            returning giveaway_id
        )
        select
            (select count(*) from eligible_giveaways)::int as eligible_count,
            (select count(*) from active_giveaways where host_discord_id = ${userId})::int as own_skipped,
            (select count(*) from inserted_entries)::int as inserted_count
    `;
    const result = resultRows[0] || {
        eligible_count: 0,
        own_skipped: 0,
        inserted_count: 0
    };

    if (result.inserted_count > 0) {
        scheduleActiveGiveawaysBoardRefresh(guild, db);
    }

    return result;
}

async function leaveAllActiveGiveaways(interaction, db = sql) {
    if (interaction.customId !== GIVEAWAY_LEAVE_ALL_BUTTON_ID) {
        return false;
    }

    await interaction.deferReply({ ephemeral: true });

    const removedRows = await db`
        delete from giveaway_entries ge
        using giveaways g
        where ge.giveaway_id = g.id
            and ge.player_discord_id = ${interaction.user.id}
            and g.guild_id = ${interaction.guild.id}
            and g.status = 'active'
            and g.ends_at > now()
        returning ge.giveaway_id
    `;

    await interaction.editReply(
        removedRows.length > 0
            ? `✅ Left **${removedRows.length}** active giveaway${removedRows.length === 1 ? '' : 's'}.`
            : 'ℹ️ You were not entered in any active giveaways.'
    );

    if (removedRows.length > 0) {
        scheduleActiveGiveawaysBoardRefresh(interaction.guild, db);
    }

    return true;
}

async function enterGiveaway(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_BUTTON_PREFIX)) {
        return false;
    }

    const giveawayId = interaction.customId.slice(GIVEAWAY_BUTTON_PREFIX.length);

    const player = await restoreActiveGiveawayPlayer(
        await fetchGiveawayPlayer(interaction.user.id, db),
        db
    );

    if (!player) {
        await interaction.reply({
            content: giveawayRegistrationHelpMessage(),
            ephemeral: true
        });
        return true;
    }

    const giveawayRows = await db`
        select *
        from giveaways
        where id = ${giveawayId}
        limit 1
    `;
    const giveaway = giveawayRows[0];

    if (!giveaway || giveaway.status !== 'active' || new Date(giveaway.ends_at).getTime() <= Date.now()) {
        if (giveaway?.status === 'active') {
            await finishGiveaway(interaction.guild, giveaway.id, db);
        }

        await interaction.reply({
            content: '❌ This giveaway has already ended.',
            ephemeral: true
        });
        return true;
    }

    if (interaction.user.id === giveaway.host_discord_id) {
        await interaction.reply({
            content: '❌ You cannot enter your own giveaway.',
            ephemeral: true
        });
        return true;
    }

    if (!player.minecraft_ign || !player.minecraft_edition) {
        await interaction.showModal(giveawayLinkModal(giveaway.id, player));
        return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const resultRows = await db`
        with inserted_entry as (
            insert into giveaway_entries (
                giveaway_id,
                player_discord_id
            )
            values (
                ${giveaway.id},
                ${interaction.user.id}
            )
            on conflict (giveaway_id, player_discord_id) do nothing
            returning player_discord_id
        )
        select
            (select count(*) from inserted_entry)::int as inserted_count,
            ((
                select count(*)::int
                from giveaway_entries
                where giveaway_id = ${giveaway.id}
            ) + (select count(*) from inserted_entry)::int) as entrant_count
    `;
    const result = resultRows[0];
    const entrantCount = result.entrant_count;

    await interaction.editReply(
        result.inserted_count > 0
            ? `✅ You entered the giveaway! There ${entrantCount === 1 ? 'is' : 'are'} now **${entrantCount}** entrant${entrantCount === 1 ? '' : 's'}.`
            : `ℹ️ You are already entered. There ${entrantCount === 1 ? 'is' : 'are'} **${entrantCount}** entrant${entrantCount === 1 ? '' : 's'}.`
    );

    if (result.inserted_count > 0) {
        scheduleGiveawayMessageRefresh(interaction.guild, giveaway.id, db, interaction.message);
        scheduleActiveGiveawaysBoardRefresh(interaction.guild, db);
    }

    return true;
}

async function handleGiveawayLinkModal(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_LINK_MODAL_PREFIX)) {
        return false;
    }

    const giveawayId = interaction.customId.slice(GIVEAWAY_LINK_MODAL_PREFIX.length);
    const minecraftIgn = interaction.fields.getTextInputValue('giveaway_link_ign').trim();
    const minecraftEdition = interaction.fields.getStringSelectValues('giveaway_link_edition')[0];

    if (!/^[A-Za-z0-9_]{3,16}$/.test(minecraftIgn)) {
        await interaction.reply({
            content: '❌ Minecraft usernames must be 3–16 characters and can only use letters, numbers, and underscores.',
            ephemeral: true
        });
        return true;
    }

    if (!['java', 'bedrock'].includes(minecraftEdition)) {
        await interaction.reply({
            content: '❌ Choose either Java or Bedrock.',
            ephemeral: true
        });
        return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const giveawayRows = await db`
        select *
        from giveaways
        where id = ${giveawayId}
        limit 1
    `;
    const giveaway = giveawayRows[0];

    if (!giveaway || giveaway.status !== 'active' || new Date(giveaway.ends_at).getTime() <= Date.now()) {
        if (giveaway?.status === 'active') {
            await finishGiveaway(interaction.guild, giveaway.id, db);
        }

        await interaction.editReply('❌ This giveaway has already ended.');
        return true;
    }

    if (interaction.user.id === giveaway.host_discord_id) {
        await interaction.editReply('❌ You cannot enter your own giveaway.');
        return true;
    }

    const displayName =
        interaction.member?.displayName ||
        interaction.user.globalName ||
        interaction.user.username;

    const entryResult = await db.begin(async transaction => {
        const playerRows = await transaction`
            update players
            set
                discord_username = ${interaction.user.username},
                discord_display_name = ${displayName},
                minecraft_ign = ${minecraftIgn},
                minecraft_edition = ${minecraftEdition},
                status = 'active',
                updated_at = now()
            where discord_id = ${interaction.user.id}
            returning discord_id
        `;

        if (playerRows.length === 0) {
            return null;
        }

        const insertedRows = await transaction`
            insert into giveaway_entries (
                giveaway_id,
                player_discord_id
            )
            values (
                ${giveaway.id},
                ${interaction.user.id}
            )
            on conflict (giveaway_id, player_discord_id) do nothing
            returning player_discord_id
        `;
        const countRows = await transaction`
            select count(*)::int as count
            from giveaway_entries
            where giveaway_id = ${giveaway.id}
        `;

        return {
            entrantCount: countRows[0].count,
            inserted: insertedRows.length > 0
        };
    });

    if (!entryResult) {
        await interaction.editReply(giveawayRegistrationHelpMessage());
        return true;
    }

    const editionLabel = minecraftEdition === 'bedrock' ? 'Bedrock' : 'Java';

    await interaction.editReply(
        `✅ Account linked and giveaway entry complete!\n\n` +
        `IGN: **${minecraftIgn}**\n` +
        `Edition: **${editionLabel}**\n` +
        `Entrants: **${entryResult.entrantCount}**`
    );

    setMemberNicknameToIgn(interaction.member, minecraftIgn).catch(error => {
        console.error(`Could not update nickname for ${interaction.user.id} after giveaway link modal:`);
        console.error(error);
    });

    if (entryResult.inserted) {
        scheduleGiveawayMessageRefresh(interaction.guild, giveaway.id, db);
        scheduleActiveGiveawaysBoardRefresh(interaction.guild, db);
    }

    return true;
}

async function leaveGiveaway(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_LEAVE_BUTTON_PREFIX)) {
        return false;
    }

    const giveawayId = interaction.customId.slice(GIVEAWAY_LEAVE_BUTTON_PREFIX.length);
    await interaction.deferReply({ ephemeral: true });

    const giveawayRows = await db`
        select *
        from giveaways
        where id = ${giveawayId}
        limit 1
    `;
    const giveaway = giveawayRows[0];

    if (!giveaway || giveaway.status !== 'active' || new Date(giveaway.ends_at).getTime() <= Date.now()) {
        if (giveaway?.status === 'active') {
            await finishGiveaway(interaction.guild, giveaway.id, db);
        }

        await interaction.editReply('❌ This giveaway has already ended.');
        return true;
    }

    const resultRows = await db`
        with removed_entry as (
            delete from giveaway_entries
            where giveaway_id = ${giveaway.id}
                and player_discord_id = ${interaction.user.id}
            returning player_discord_id
        )
        select
            (select count(*) from removed_entry)::int as removed_count,
            greatest(0, (
                select count(*)::int
                from giveaway_entries
                where giveaway_id = ${giveaway.id}
            ) - (select count(*) from removed_entry)::int) as entrant_count
    `;
    const result = resultRows[0];
    const entrantCount = result.entrant_count;

    await interaction.editReply(
        result.removed_count > 0
            ? `✅ You left the giveaway. There ${entrantCount === 1 ? 'is' : 'are'} now **${entrantCount}** entrant${entrantCount === 1 ? '' : 's'}.`
            : 'ℹ️ You were not entered in this giveaway.'
    );

    if (result.removed_count > 0) {
        scheduleGiveawayMessageRefresh(interaction.guild, giveaway.id, db, interaction.message);
        scheduleActiveGiveawaysBoardRefresh(interaction.guild, db);
    }

    return true;
}

async function endGiveawayEarly(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_END_BUTTON_PREFIX)) {
        return false;
    }

    const giveawayId = interaction.customId.slice(GIVEAWAY_END_BUTTON_PREFIX.length);
    await interaction.deferReply({ ephemeral: true });

    const giveawayRows = await db`
        select *
        from giveaways
        where id = ${giveawayId}
        limit 1
    `;
    const giveaway = giveawayRows[0];

    if (!giveaway) {
        await interaction.editReply('❌ This giveaway could not be found.');
        return true;
    }

    if (interaction.user.id !== giveaway.host_discord_id) {
        await interaction.editReply('❌ Only the giveaway host can end it early.');
        return true;
    }

    if (giveaway.status !== 'active') {
        await interaction.editReply('ℹ️ This giveaway has already ended.');
        return true;
    }

    const result = await finishGiveaway(interaction.guild, giveaway.id, db);

    if (!result) {
        await interaction.editReply('ℹ️ This giveaway has already ended.');
        return true;
    }

    await interaction.editReply(
        result.winnerId
            ? `✅ Giveaway ended early. <@${result.winnerId}> was randomly selected as the winner.`
            : '✅ Giveaway ended early. Nobody had entered, so no winner was selected.'
    );
    return true;
}

async function fetchSponsoredRequest(requestId, db = sql) {
    const rows = await db`
        select *
        from giveaway_payment_requests
        where id = ${requestId}
        limit 1
    `;

    return rows[0] || null;
}

async function dmGiveawayUser(client, userId, payload) {
    const user = client.users.cache.get(userId) ||
        await client.users.fetch(userId).catch(() => null);

    if (!user) {
        throw new Error(`Could not reach Discord user ${userId}.`);
    }

    return user.send(payload);
}

async function dismissGiveawayMessage(interaction) {
    if (!interaction.customId.startsWith(GIVEAWAY_DISMISS_BUTTON_PREFIX)) {
        return false;
    }

    const ownerId = interaction.customId.slice(GIVEAWAY_DISMISS_BUTTON_PREFIX.length);

    if (interaction.user.id !== ownerId && !isDon(interaction.user.id)) {
        await interaction.reply({
            content: '❌ Only the recipient or the Don can remove this message.',
            ephemeral: true
        });
        return true;
    }

    await interaction.deferUpdate();
    await interaction.message.delete().catch(() => null);
    return true;
}

async function acceptSponsoredGiveaway(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_HOST_ACCEPT_PREFIX)) {
        return false;
    }

    const requestId = interaction.customId.slice(GIVEAWAY_HOST_ACCEPT_PREFIX.length);
    const current = await fetchSponsoredRequest(requestId, db);

    if (!current || interaction.user.id !== current.host_discord_id) {
        await interaction.reply({ content: '❌ This hosting request is not for you.', ephemeral: true });
        return true;
    }

    const rows = await db`
        update giveaway_payment_requests
        set status = 'pending_payment', accepted_at = now(), updated_at = now()
        where id = ${requestId}
            and host_discord_id = ${interaction.user.id}
            and status = 'awaiting_acceptance'
        returning *
    `;
    const request = rows[0];

    if (!request) {
        await interaction.reply({ content: 'ℹ️ This request was already handled.', ephemeral: true });
        return true;
    }

    try {
        await dmGiveawayUser(
            interaction.client,
            request.sponsor_discord_id,
            sponsoredGiveawayPaymentPayload(request)
        );
    } catch (error) {
        await db`
            update giveaway_payment_requests
            set status = 'failed', updated_at = now()
            where id = ${request.id} and status = 'pending_payment'
        `;
        throw error;
    }

    await interaction.update(sponsoredGiveawayPaymentConfirmationPayload(request));
    return true;
}

async function rejectSponsoredGiveaway(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_HOST_REJECT_PREFIX)) {
        return false;
    }

    const requestId = interaction.customId.slice(GIVEAWAY_HOST_REJECT_PREFIX.length);
    const rows = await db`
        update giveaway_payment_requests
        set status = 'rejected', updated_at = now()
        where id = ${requestId}
            and host_discord_id = ${interaction.user.id}
            and status = 'awaiting_acceptance'
        returning *
    `;
    const request = rows[0];

    if (!request) {
        await interaction.reply({ content: 'ℹ️ This request was already handled or is not for you.', ephemeral: true });
        return true;
    }

    await interaction.update({
        content: `❌ You declined ${sponsorName(request)}'s giveaway request.`,
        components: [dismissRow(request.host_discord_id)],
        allowedMentions: { users: [request.sponsor_discord_id] }
    });
    await dmGiveawayUser(interaction.client, request.sponsor_discord_id, {
        content: `<@${request.host_discord_id}> declined your giveaway request. You can run \`/giveaway\` again and choose an available host.`,
        components: [dismissRow(request.sponsor_discord_id)],
        allowedMentions: { users: [request.host_discord_id] }
    }).catch(() => null);
    return true;
}

async function cancelSponsoredGiveaway(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_HOST_CANCEL_PREFIX)) {
        return false;
    }

    const requestId = interaction.customId.slice(GIVEAWAY_HOST_CANCEL_PREFIX.length);
    const rows = await db`
        update giveaway_payment_requests
        set status = 'cancelled', updated_at = now()
        where id = ${requestId}
            and host_discord_id = ${interaction.user.id}
            and status = 'pending_payment'
        returning *
    `;
    const request = rows[0];

    if (!request) {
        await interaction.reply({ content: 'ℹ️ This request was already handled or is not for you.', ephemeral: true });
        return true;
    }

    await interaction.update({
        content: `❌ Giveaway cancelled. Do not accept a payment for this request.`,
        components: [dismissRow(request.host_discord_id)]
    });
    await dmGiveawayUser(interaction.client, request.sponsor_discord_id, {
        content: '❌ The payment host cancelled your giveaway request. Do not send the payment.',
        components: [dismissRow(request.sponsor_discord_id)]
    }).catch(() => null);
    return true;
}

async function confirmSponsoredGiveawayPayment(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_HOST_PAID_PREFIX)) {
        return false;
    }

    const requestId = interaction.customId.slice(GIVEAWAY_HOST_PAID_PREFIX.length);
    const rows = await db`
        update giveaway_payment_requests
        set status = 'processing', paid_at = now(), updated_at = now()
        where id = ${requestId}
            and host_discord_id = ${interaction.user.id}
            and status = 'pending_payment'
        returning *
    `;
    const request = rows[0];

    if (!request) {
        await interaction.reply({ content: 'ℹ️ This request was already handled or is not for you.', ephemeral: true });
        return true;
    }

    await interaction.deferUpdate();

    try {
        const guild = interaction.client.guilds.cache.get(request.guild_id) ||
            await interaction.client.guilds.fetch(request.guild_id);
        const { giveaway } = await startFundedGiveaway(guild, {
            guildId: request.guild_id,
            channelId: request.channel_id,
            hostDiscordId: request.host_discord_id,
            sponsorDiscordId: request.sponsor_discord_id,
            amount: BigInt(request.amount),
            durationMs: Number(request.duration_ms)
        }, db);

        await db`
            update giveaway_payment_requests
            set status = 'hosted', giveaway_id = ${giveaway.id}, updated_at = now()
            where id = ${request.id}
        `;
        await interaction.editReply({
            content: `✅ Payment confirmed. Giveaway **#${giveaway.id}** is now live.`,
            components: [dismissRow(request.host_discord_id)]
        });
        await dmGiveawayUser(interaction.client, request.sponsor_discord_id, {
            content: `✅ <@${request.host_discord_id}> confirmed your payment. Giveaway **#${giveaway.id}** is now live.`,
            components: [dismissRow(request.sponsor_discord_id)],
            allowedMentions: { users: [request.host_discord_id] }
        }).catch(() => null);
    } catch (error) {
        await db`
            update giveaway_payment_requests
            set status = 'failed', updated_at = now()
            where id = ${request.id}
        `;
        throw error;
    }

    return true;
}

async function handleGiveawayButton(interaction, db = sql) {
    if (await dismissGiveawayMessage(interaction)) {
        return true;
    }

    if (await acceptSponsoredGiveaway(interaction, db)) {
        return true;
    }

    if (await rejectSponsoredGiveaway(interaction, db)) {
        return true;
    }

    if (await cancelSponsoredGiveaway(interaction, db)) {
        return true;
    }

    if (await confirmSponsoredGiveawayPayment(interaction, db)) {
        return true;
    }

    if (await addGiveawayPingRole(interaction)) {
        return true;
    }

    if (await enterAllActiveGiveaways(interaction, db)) {
        return true;
    }

    if (await leaveAllActiveGiveaways(interaction, db)) {
        return true;
    }

    if (await enterGiveaway(interaction, db)) {
        return true;
    }

    if (await leaveGiveaway(interaction, db)) {
        return true;
    }

    if (await endGiveawayEarly(interaction, db)) {
        return true;
    }

    return closeGiveawayMessages(interaction, db);
}

async function finishGiveaway(guild, giveawayId, db = sql) {
    const prepared = await db.begin(async tx => {
        const giveawayRows = await tx`
            select *
            from giveaways
            where id = ${giveawayId}
                and status = 'active'
            for update
        `;
        const activeGiveaway = giveawayRows[0];

        if (!activeGiveaway) {
            return null;
        }

        const countRows = await tx`
            select count(*)::int as count
            from giveaway_entries
            where giveaway_id = ${activeGiveaway.id}
        `;
        const winnerRows = await tx`
            select player_discord_id
            from giveaway_entries
            where giveaway_id = ${activeGiveaway.id}
            order by random()
            limit 1
        `;
        const entrantCount = countRows[0].count;
        const winnerId = winnerRows[0]?.player_discord_id || null;
        const payoutResult = winnerId
            ? await calculatePayout(
                winnerId,
                BigInt(activeGiveaway.amount),
                process.env.DON_DISCORD_ID,
                tx
            )
            : null;

        if (winnerId && !payoutResult) {
            throw new Error(`Giveaway winner ${winnerId} is no longer in the player database.`);
        }

        const endedRows = await tx`
            update giveaways
            set
                status = 'ended',
                ended_at = now(),
                winner_discord_id = ${winnerId}
            where id = ${activeGiveaway.id}
                and status = 'active'
            returning *
        `;

        return {
            giveaway: endedRows[0],
            entrantCount,
            winnerId,
            payoutResult
        };
    });

    if (!prepared) {
        return null;
    }

    const {
        giveaway,
        entrantCount,
        payoutResult,
        winnerId
    } = prepared;

    const resultChannels = await fetchGiveawayResultChannels(guild, giveaway);
    const cleanupMessageIds = [];

    await refreshActiveGiveawaysBoard(guild, db);

    if (winnerId) {
        let announced = false;

        for (const resultChannel of resultChannels) {
            try {
                const payoutMessageIds = await sendPayoutAnnouncement(
                    resultChannel,
                    giveaway,
                    payoutResult,
                    winnerId
                );
                cleanupMessageIds.push(...payoutMessageIds);
                announced = true;
                break;
            } catch (error) {
                console.error(
                    `Could not announce giveaway ${giveaway.id} in channel ${resultChannel.id}; ` +
                    'trying the fallback channel:'
                );
                console.error(error);
            }
        }

        if (!announced) {
            console.error(
                `Giveaway ${giveaway.id} selected winner ${winnerId}, but no result channel was available.`
            );
        }

        await sendManualGiveawayPayoutDm(guild, giveaway, payoutResult, winnerId).catch(error => {
            console.error(`Could not DM manual payout commands for giveaway ${giveaway.id}:`);
            console.error(error);
            return false;
        });
    } else {
        for (const resultChannel of resultChannels) {
            try {
                const noWinnerMessage = await resultChannel.send({
                    content:
                        `Hosted by: <@${giveaway.host_discord_id}>\n` +
                        'The giveaway ended with no entrants, so no winner was chosen.',
                    components: [dismissRow(giveaway.host_discord_id)],
                    allowedMentions: {
                        users: []
                    }
                });
                cleanupMessageIds.push(noWinnerMessage.id);
                break;
            } catch (error) {
                console.error(
                    `Could not announce empty giveaway ${giveaway.id} in channel ${resultChannel.id}; ` +
                    'trying the fallback channel:'
                );
                console.error(error);
            }
        }
    }

    await db`
        update giveaways
        set
            cleanup_due_at = now() + interval '12 hours',
            cleanup_message_ids = ${sql.json([...new Set(cleanupMessageIds)])}
        where id = ${giveaway.id}
    `;

    return {
        giveaway,
        entrantCount,
        payoutResult,
        winnerId
    };
}

async function finishExpiredGiveawaysForGuild(guild, db = sql) {
    const rows = await db`
        select id
        from giveaways
        where guild_id = ${guild.id}
            and status = 'active'
            and ends_at <= now()
        order by ends_at asc
    `;
    const finished = [];

    for (const row of rows) {
        const result = await finishGiveaway(guild, row.id, db);

        if (result) {
            finished.push(result);
        }
    }

    return finished;
}

async function deleteGiveawayMessages(guild, giveaway) {
    const channels = await fetchGiveawayResultChannels(guild, giveaway);

    if (channels.length === 0) {
        return {
            deleted: 0,
            failed: true
        };
    }

    const messageIds = Array.isArray(giveaway.cleanup_message_ids)
        ? giveaway.cleanup_message_ids
        : [];
    let deleted = 0;
    let failed = false;

    for (const messageId of messageIds) {
        let message = null;

        for (const channel of channels) {
            message = await channel.messages.fetch(messageId).catch(() => null);

            if (message) {
                break;
            }
        }

        if (!message) {
            continue;
        }

        try {
            await message.delete();
            deleted++;
        } catch (error) {
            failed = true;
            console.warn(
                `Could not delete giveaway message ${messageId} for giveaway ${giveaway.id}: ${error.message}`
            );
        }
    }

    return {
        deleted,
        failed
    };
}

async function closeGiveawayMessages(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_CLOSE_BUTTON_PREFIX)) {
        return false;
    }

    const giveawayId = interaction.customId.slice(GIVEAWAY_CLOSE_BUTTON_PREFIX.length);
    await interaction.deferReply({ ephemeral: true });

    const rows = await db`
        select *
        from giveaways
        where id = ${giveawayId}
        limit 1
    `;
    const giveaway = rows[0];

    if (!giveaway) {
        await interaction.editReply('❌ This giveaway could not be found.');
        return true;
    }

    if (interaction.user.id !== giveaway.host_discord_id) {
        await interaction.editReply('❌ Only the giveaway host can close its messages.');
        return true;
    }

    if (giveaway.status === 'active') {
        await interaction.editReply(
            '❌ End the giveaway and pick a winner before closing its messages.'
        );
        return true;
    }

    if (giveaway.cleaned_at) {
        await interaction.editReply('ℹ️ This giveaway’s messages have already been closed.');
        return true;
    }

    const result = await deleteGiveawayMessages(interaction.guild, giveaway);

    if (result.failed) {
        await interaction.editReply(
            '❌ Some giveaway messages could not be deleted. Please try the close button again.'
        );
        return true;
    }

    await db`
        update giveaways
        set cleaned_at = now()
        where id = ${giveaway.id}
            and cleaned_at is null
    `;

    await interaction.editReply(
        `✅ Giveaway closed. Deleted **${result.deleted}** giveaway message${result.deleted === 1 ? '' : 's'}.`
    );
    return true;
}

async function cleanupEndedGiveawaysForGuild(guild, db = sql) {
    const rows = await db`
        select
            id,
            channel_id,
            cleanup_message_ids
        from giveaways
        where guild_id = ${guild.id}
            and status = 'ended'
            and cleanup_due_at is not null
            and cleanup_due_at <= now()
            and cleaned_at is null
        order by cleanup_due_at asc
    `;
    const cleaned = [];

    for (const giveaway of rows) {
        const result = await deleteGiveawayMessages(guild, giveaway);

        if (result.failed) {
            continue;
        }

        await db`
            update giveaways
            set cleaned_at = now()
            where id = ${giveaway.id}
                and cleaned_at is null
        `;
        cleaned.push(giveaway.id);
    }

    return cleaned;
}

module.exports = {
    APPROVED_GIVEAWAY_HOSTS,
    GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID,
    GIVEAWAY_BUTTON_PREFIX,
    GIVEAWAY_CHANNEL_ID,
    GIVEAWAY_WINNER_CHANNEL_ID,
    addGiveawayPingRole,
    announceGiveawayStarted,
    activeGiveawayTotalAmount,
    cleanupEndedGiveawaysForGuild,
    closeGiveawayMessages,
    createDonationPaymentRequest,
    createGiveaway,
    createGiveawayPaymentRequest,
    createSponsoredGiveawayRequest,
    endGiveawayEarly,
    enterGiveaway,
    enterAllActiveGiveawaysForUser,
    finishExpiredGiveawaysForGuild,
    finishGiveaway,
    fetchGiveawayWinnerChannel,
    giveawayPaymentBotUser,
    giveawayLinkModal,
    handleGiveawayButton,
    handleGiveawayLinkModal,
    leaveGiveaway,
    maxGiveawayDurationForAmount,
    manualGiveawayPayoutDetails,
    manualGiveawayPayoutDmChunks,
    parseGiveawayDuration,
    processIncomingGiveawayPayment,
    renderGiveaway,
    renderGiveawayHostControls,
    sendSponsoredGiveawayHostRequest,
    sponsoredGiveawayHostRequestPayload,
    sponsoredGiveawayPaymentPayload,
    sendWeeklyElectionAndGiveawayReminderForGuild,
    sendWeeklyGiveawayPingReminderForGuild,
    startFundedGiveaway,
    upsertActiveGiveawaysBoard,
    validateGiveawayDurationForAmount
};
