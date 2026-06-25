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
    formatPayoutLine
} = require('./payouts.js');
const {
    enqueueGiveawayPayouts,
    processPendingGiveawayPayoutsForGuild
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
    setMemberNicknameToIgn
} = require('./nicknames.js');

const GIVEAWAY_CHANNEL_ID =
    process.env.GIVEAWAY_CHANNEL_ID || '1517413426358390814';
const GIVEAWAY_WINNER_CHANNEL_ID =
    process.env.GIVEAWAY_WINNER_CHANNEL_ID || '1519484184425398312';
const GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID =
    process.env.GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID || '1498442322638147604';
const GIVEAWAY_BUTTON_PREFIX = 'giveaway_enter:';
const GIVEAWAY_LEAVE_BUTTON_PREFIX = 'giveaway_leave:';
const GIVEAWAY_ENTER_ALL_BUTTON_ID = 'giveaway_enter_all';
const GIVEAWAY_LEAVE_ALL_BUTTON_ID = 'giveaway_leave_all';
const GIVEAWAY_NOTIFY_BUTTON_ID = 'giveaway_notify_role';
const GIVEAWAY_END_BUTTON_PREFIX = 'giveaway_end:';
const GIVEAWAY_CLOSE_BUTTON_PREFIX = 'giveaway_close:';
const GIVEAWAY_LINK_MODAL_PREFIX = 'giveaway_link:';
const MIN_GIVEAWAY_DURATION_MS = 60 * 1000;
const MAX_GIVEAWAY_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PAYMENT_BOT_USER = 'Ash_L567';

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
        days: 24 * 60 * 60 * 1000
    };
    const tokenPattern = /(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)/g;
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
        throw new Error('Use a duration like `30m`, `1h`, `1 hour`, `2h 30m`, or `1d`.');
    }

    if (durationMs < MIN_GIVEAWAY_DURATION_MS) {
        throw new Error('Giveaway duration must be at least 1 minute.');
    }

    if (durationMs > MAX_GIVEAWAY_DURATION_MS) {
        throw new Error('Giveaway duration cannot be longer than 30 days.');
    }

    return durationMs;
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
            amount,
            ends_at
        )
        values (
            ${options.guildId},
            ${options.channelId},
            ${options.hostDiscordId},
            ${options.amount.toString()}::bigint,
            ${endsAt}
        )
        returning *
    `;

    return rows[0];
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

async function fetchGiveawayChannel(guild, giveaway) {
    const channel = guild.channels.cache.get(giveaway.channel_id) ||
        (await guild.channels.fetch(giveaway.channel_id).catch(() => null));

    if (!channel?.isTextBased()) {
        return null;
    }

    return channel;
}

async function fetchGiveawayWinnerChannel(guild) {
    return fetchGiveawayTextChannel(guild, GIVEAWAY_WINNER_CHANNEL_ID);
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

async function announceGiveawayStarted(guild, giveaway, boardMessage = null, totalActiveAmount = null) {
    const announcementChannel = await fetchGiveawayTextChannel(guild, GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID);

    if (!announcementChannel) {
        return null;
    }

    const totalLine = totalActiveAmount === null
        ? ''
        : `\nTotal active giveaway money in <#${GIVEAWAY_CHANNEL_ID}>: **${formatDonationAmount(totalActiveAmount)}**.`;

    return announcementChannel.send({
        content:
            `<@&${GIVEAWAY_PING_ROLE_ID}>\n\n` +
            `<@${giveaway.host_discord_id}> started a **${formatDonationAmount(giveaway.amount)}** giveaway. ` +
            `Go to <#${GIVEAWAY_CHANNEL_ID}> to join.` +
            totalLine +
            (boardMessage ? `\n${boardMessage.url}` : ''),
        allowedMentions: {
            roles: [GIVEAWAY_PING_ROLE_ID],
            users: [giveaway.host_discord_id]
        }
    });
}

async function recordGiveawayDonation(guild, giveaway, db = sql) {
    const rows = await db`
        update players
        set
            donations = donations + ${BigInt(giveaway.amount).toString()}::bigint,
            updated_at = now()
        where discord_id = ${giveaway.host_discord_id}
        returning donations
    `;
    const donationRow = rows[0];

    if (!donationRow) {
        throw new Error(`Giveaway host ${giveaway.host_discord_id} was not found while recording donation credit.`);
    }

    await postGiveawayDonationEvent(guild, {
        playerId: giveaway.host_discord_id,
        amount: BigInt(giveaway.amount),
        newTotal: donationRow.donations
    }).catch(error => {
        console.error(`Could not post giveaway donation event for giveaway ${giveaway.id}:`);
        console.error(error);
        return false;
    });

    await updateDonationLeaderboardForGuild(guild, db).catch(error => {
        console.error(`Could not refresh donation leaderboard after giveaway ${giveaway.id}:`);
        console.error(error);
        return false;
    });

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

    await updateDonationLeaderboardForGuild(guild, db).catch(error => {
        console.error(`Could not refresh donation leaderboard after ${options.source || 'Minecraft payment'}:`);
        console.error(error);
        return false;
    });

    return {
        playerId,
        amount: donationAmount,
        newTotal: donationRow.donations
    };
}

async function sendWeeklyGiveawayPingReminderForGuild(guild, db = sql) {
    const totalAmount = await activeGiveawayTotalAmount(guild.id, db);

    if (totalAmount <= 0n) {
        return {
            sent: 0,
            failed: 0,
            skipped: true,
            totalAmount
        };
    }

    const role = guild.roles.cache.get(GIVEAWAY_PING_ROLE_ID) ||
        (await guild.roles.fetch(GIVEAWAY_PING_ROLE_ID).catch(() => null));

    if (!role) {
        console.warn(`Giveaway ping role ${GIVEAWAY_PING_ROLE_ID} was not found.`);
        return {
            sent: 0,
            failed: 0,
            skipped: true,
            totalAmount
        };
    }

    const rows = await db`
        select discord_id
        from players
        where status = 'active'
            and welcome_completed = true
        order by discord_display_name asc, discord_username asc
    `;
    let sent = 0;
    let failed = 0;

    for (const player of rows) {
        const member = guild.members.cache.get(player.discord_id) ||
            (await guild.members.fetch(player.discord_id).catch(() => null));

        if (!member || member.user.bot || member.roles.cache.has(role.id)) {
            continue;
        }

        await member.send({
            content:
                `🎉 Penguin Mafia has **${formatDonationAmount(totalAmount)}** in active giveaways right now in <#${GIVEAWAY_CHANNEL_ID}>.\n\n` +
                `You do not currently have the giveaway ping role. Use the **Notify Me** button in the giveaway channel or react in <#${REACTION_ROLES_CHANNEL_ID}> if you want new giveaway pings.`,
            allowedMentions: {
                parse: []
            }
        }).then(() => {
            sent += 1;
        }).catch(error => {
            failed += 1;
            console.log(`Could not DM weekly giveaway reminder to ${player.discord_id}: ${error.message}`);
        });
    }

    return {
        sent,
        failed,
        skipped: false,
        totalAmount
    };
}

async function startFundedGiveaway(guild, options, db = sql) {
    const giveaway = await createGiveaway({
        guildId: options.guildId,
        channelId: options.channelId,
        hostDiscordId: options.hostDiscordId,
        amount: options.amount,
        durationMs: options.durationMs
    }, db);
    const boardMessage = await upsertActiveGiveawaysBoard(guild, db);
    const activeGiveaways = await fetchActiveGiveawayRows(guild.id, db);
    const totalActiveAmount = totalGiveawayAmount(activeGiveaways);

    await recordGiveawayDonation(guild, giveaway, db);
    await announceGiveawayStarted(guild, giveaway, boardMessage, totalActiveAmount);

    return {
        giveaway,
        boardMessage
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
            and amount <= ${paidAmount.toString()}::bigint
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

        const donationPlayer = await findPlayerByMinecraftPaymentName(paymentPlayer, db);

        if (!donationPlayer) {
            return {
                status: 'donation_unmatched',
                minecraftName: payment.player,
                paidAmount
            };
        }

        const donation = await recordDirectDonation(
            guild,
            donationPlayer.discord_id,
            paidAmount,
            db,
            {
                source: `unmatched Minecraft payment from ${payment.player || paymentPlayer}`
            }
        );

        return {
            status: 'donation_recorded',
            player: donationPlayer,
            donation,
            paidAmount
        };
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

        const overpaidAmount = paidAmount - BigInt(claimedRequest.amount);
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

    const playerRows = await db`
        select
            discord_id,
            minecraft_ign,
            minecraft_edition
        from players
        where discord_id = ${interaction.user.id}
            and status = 'active'
            and welcome_completed = true
        limit 1
    `;
    const player = playerRows[0];

    if (!player) {
        await interaction.editReply('❌ You need to be a registered Penguin Mafia player to enter giveaways.');
        return true;
    }

    if (!player.minecraft_ign || !player.minecraft_edition) {
        await interaction.editReply('❌ Link your Minecraft account first with `/penguinlink` before entering giveaways.');
        return true;
    }

    const activeGiveaways = await db`
        select id, host_discord_id
        from giveaways
        where guild_id = ${interaction.guild.id}
            and status = 'active'
            and ends_at > now()
        order by ends_at asc, id asc
    `;
    const eligibleGiveaways = activeGiveaways.filter(giveaway => {
        return giveaway.host_discord_id !== interaction.user.id;
    });
    let inserted = 0;

    for (const giveaway of eligibleGiveaways) {
        const insertedRows = await db`
            insert into giveaway_entries (
                giveaway_id,
                player_discord_id
            )
            values (
                ${giveaway.id},
                ${interaction.user.id}
            )
            on conflict (giveaway_id, player_discord_id) do nothing
            returning giveaway_id
        `;

        if (insertedRows.length > 0) {
            inserted++;
        }
    }

    await upsertActiveGiveawaysBoard(interaction.guild, db);

    const ownSkipped = activeGiveaways.length - eligibleGiveaways.length;

    if (eligibleGiveaways.length === 0) {
        await interaction.editReply(
            ownSkipped > 0
                ? 'ℹ️ The only active giveaway is yours, so you were not entered.'
                : 'ℹ️ There are no active giveaways to enter right now.'
        );
        return true;
    }

    await interaction.editReply(
        `✅ Entered **${inserted}** new giveaway${inserted === 1 ? '' : 's'}. ` +
        `You are now in **${eligibleGiveaways.length}** active giveaway${eligibleGiveaways.length === 1 ? '' : 's'} you are eligible for.` +
        (ownSkipped > 0 ? ` Skipped **${ownSkipped}** of your own giveaway${ownSkipped === 1 ? '' : 's'}.` : '')
    );
    return true;
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

    await upsertActiveGiveawaysBoard(interaction.guild, db);
    await interaction.editReply(
        removedRows.length > 0
            ? `✅ Left **${removedRows.length}** active giveaway${removedRows.length === 1 ? '' : 's'}.`
            : 'ℹ️ You were not entered in any active giveaways.'
    );
    return true;
}

async function enterGiveaway(interaction, db = sql) {
    if (!interaction.customId.startsWith(GIVEAWAY_BUTTON_PREFIX)) {
        return false;
    }

    const giveawayId = interaction.customId.slice(GIVEAWAY_BUTTON_PREFIX.length);

    const playerRows = await db`
        select
            discord_id,
            minecraft_ign,
            minecraft_edition
        from players
        where discord_id = ${interaction.user.id}
            and status = 'active'
            and welcome_completed = true
        limit 1
    `;

    if (playerRows.length === 0) {
        await interaction.reply({
            content: '❌ You need to be a registered Penguin Mafia player to enter.',
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

    const player = playerRows[0];

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

    const inserted = await db`
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
    const countRows = await db`
        select count(*)::int as count
        from giveaway_entries
        where giveaway_id = ${giveaway.id}
    `;
    const entrantCount = countRows[0].count;

    await interaction.message.edit(renderGiveaway(giveaway, entrantCount));
    await upsertActiveGiveawaysBoard(interaction.guild, db);
    await interaction.editReply(
        inserted.length > 0
            ? `✅ You entered the giveaway! There ${entrantCount === 1 ? 'is' : 'are'} now **${entrantCount}** entrant${entrantCount === 1 ? '' : 's'}.`
            : `ℹ️ You are already entered. There ${entrantCount === 1 ? 'is' : 'are'} **${entrantCount}** entrant${entrantCount === 1 ? '' : 's'}.`
    );
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
                updated_at = now()
            where discord_id = ${interaction.user.id}
                and status = 'active'
                and welcome_completed = true
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
        await interaction.editReply('❌ You need to be a registered Penguin Mafia player to enter.');
        return true;
    }

    await setMemberNicknameToIgn(interaction.member, minecraftIgn);

    const channel = await fetchGiveawayChannel(interaction.guild, giveaway);
    const message = channel
        ? await fetchGiveawayMessage(channel, giveaway)
        : null;

    if (message) {
        await message.edit(renderGiveaway(giveaway, entryResult.entrantCount));
    }
    await upsertActiveGiveawaysBoard(interaction.guild, db);

    const editionLabel = minecraftEdition === 'bedrock' ? 'Bedrock' : 'Java';

    await interaction.editReply(
        `✅ Account linked and giveaway entry complete!\n\n` +
        `IGN: **${minecraftIgn}**\n` +
        `Edition: **${editionLabel}**\n` +
        `Entrants: **${entryResult.entrantCount}**`
    );
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

    const removedRows = await db`
        delete from giveaway_entries
        where giveaway_id = ${giveaway.id}
            and player_discord_id = ${interaction.user.id}
        returning player_discord_id
    `;
    const countRows = await db`
        select count(*)::int as count
        from giveaway_entries
        where giveaway_id = ${giveaway.id}
    `;
    const entrantCount = countRows[0].count;

    await interaction.message.edit(renderGiveaway(giveaway, entrantCount));
    await upsertActiveGiveawaysBoard(interaction.guild, db);
    await interaction.editReply(
        removedRows.length > 0
            ? `✅ You left the giveaway. There ${entrantCount === 1 ? 'is' : 'are'} now **${entrantCount}** entrant${entrantCount === 1 ? '' : 's'}.`
            : 'ℹ️ You were not entered in this giveaway.'
    );
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

async function handleGiveawayButton(interaction, db = sql) {
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

    const channel = await fetchGiveawayWinnerChannel(guild);
    const cleanupMessageIds = [];

    await refreshActiveGiveawaysBoard(guild, db);

    if (winnerId) {
        await enqueueGiveawayPayouts(guild, giveaway, payoutResult, db);
    }

    if (channel && winnerId) {
        const payoutMessageIds = await sendPayoutAnnouncement(
            channel,
            giveaway,
            payoutResult,
            winnerId
        );
        cleanupMessageIds.push(...payoutMessageIds);

        processPendingGiveawayPayoutsForGuild(guild, db).catch(error => {
            console.error(`Could not settle giveaway payout ${giveaway.id}:`);
            console.error(error);
        });
    } else if (winnerId) {
        processPendingGiveawayPayoutsForGuild(guild, db).catch(error => {
            console.error(`Could not settle giveaway payout ${giveaway.id}:`);
            console.error(error);
        });
    } else if (channel) {
        const noWinnerMessage = await channel.send({
            content:
                `Hosted by: <@${giveaway.host_discord_id}>\n` +
                'The giveaway ended with no entrants, so no winner was chosen.',
            allowedMentions: {
                users: []
            }
        });
        cleanupMessageIds.push(noWinnerMessage.id);
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
    const winnerChannel = await fetchGiveawayWinnerChannel(guild);
    const originalChannel = guild.channels.cache.get(giveaway.channel_id) ||
        (await guild.channels.fetch(giveaway.channel_id).catch(() => null));
    const channels = [];

    if (winnerChannel?.isTextBased()) {
        channels.push(winnerChannel);
    }

    if (
        originalChannel?.isTextBased() &&
        !channels.some(channel => channel.id === originalChannel.id)
    ) {
        channels.push(originalChannel);
    }

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
    GIVEAWAY_ANNOUNCEMENT_CHANNEL_ID,
    GIVEAWAY_BUTTON_PREFIX,
    GIVEAWAY_CHANNEL_ID,
    GIVEAWAY_WINNER_CHANNEL_ID,
    addGiveawayPingRole,
    announceGiveawayStarted,
    activeGiveawayTotalAmount,
    cleanupEndedGiveawaysForGuild,
    closeGiveawayMessages,
    createGiveaway,
    createGiveawayPaymentRequest,
    endGiveawayEarly,
    enterGiveaway,
    finishExpiredGiveawaysForGuild,
    finishGiveaway,
    giveawayPaymentBotUser,
    giveawayLinkModal,
    handleGiveawayButton,
    handleGiveawayLinkModal,
    leaveGiveaway,
    parseGiveawayDuration,
    processIncomingGiveawayPayment,
    renderGiveaway,
    renderGiveawayHostControls,
    sendWeeklyGiveawayPingReminderForGuild,
    startFundedGiveaway,
    upsertActiveGiveawaysBoard
};
