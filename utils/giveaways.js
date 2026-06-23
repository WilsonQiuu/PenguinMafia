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
    formatCents,
    formatDonationAmount
} = require('./donations.js');
const {
    calculatePayout,
    formatPayoutLine,
    linkedAccountLabel
} = require('./payouts.js');
const {
    GIVEAWAY_PING_ROLE_ID
} = require('./reactionRoles.js');
const {
    setMemberNicknameToIgn
} = require('./nicknames.js');

const GIVEAWAY_CHANNEL_ID =
    process.env.GIVEAWAY_CHANNEL_ID || '1517413426358390814';
const GIVEAWAY_BUTTON_PREFIX = 'giveaway_enter:';
const GIVEAWAY_LEAVE_BUTTON_PREFIX = 'giveaway_leave:';
const GIVEAWAY_END_BUTTON_PREFIX = 'giveaway_end:';
const GIVEAWAY_CLOSE_BUTTON_PREFIX = 'giveaway_close:';
const GIVEAWAY_LINK_MODAL_PREFIX = 'giveaway_link:';
const MIN_GIVEAWAY_DURATION_MS = 60 * 1000;
const MAX_GIVEAWAY_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

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

function renderGiveawayHostControls(giveaway) {
    return {
        content:
            `🎛️ **Private Giveaway Controls**\n\n` +
            `Only you can see this panel.\n` +
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
                    `The rest follows your recruiter chain using the exact same commission split as \`/pay\`.\n\n` +
                    `Click **Enter** for your chance to win, or **Leave** to withdraw your entry.`
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

async function fetchGiveawayChannel(guild, giveaway) {
    const channel = guild.channels.cache.get(giveaway.channel_id) ||
        (await guild.channels.fetch(giveaway.channel_id).catch(() => null));

    if (!channel?.isTextBased()) {
        return null;
    }

    return channel;
}

async function fetchGiveawayMessage(channel, giveaway) {
    if (!giveaway.message_id) {
        return null;
    }

    return channel.messages.fetch(giveaway.message_id).catch(() => null);
}

function payoutAnnouncementChunks(giveaway, payoutResult, winnerId) {
    const payoutLines = payoutResult.payouts.map((payout, index) => {
        return formatPayoutLine(payout, index, {
            includeDiscordMention: payout.amountCents > 0n
        });
    });
    const header =
        `# 🎉 GIVEAWAY WINNER & PAYOUT\n\n` +
        `Hosted by: <@${giveaway.host_discord_id}>\n` +
        `Winner: <@${winnerId}>\n` +
        `Winner account: **${linkedAccountLabel(payoutResult.player)}**\n` +
        `Giveaway amount: **${formatDonationAmount(giveaway.amount)}**\n` +
        `Total distributed: **${formatCents(payoutResult.totalPaidCents)}**\n\n` +
        `## Complete Pay List\n`;
    const footer =
        `\n\nThe winner received their rank commission. The remaining money followed their recruiter chain exactly like \`/pay\`.` +
        (payoutResult.stoppedAtFinalRank ? `\nFinal rank reached: **yes**` : '');
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

    if (current.length + footer.length <= 1950) {
        current += footer;
        chunks.push(current);
    } else {
        chunks.push(current);
        chunks.push(footer.trim());
    }

    return chunks;
}

async function sendPayoutAnnouncement(channel, message, giveaway, payoutResult, winnerId) {
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

        if (index === 0 && message) {
            sentMessage = await message.reply(payload);
        } else {
            sentMessage = await channel.send(payload);
        }

        sentMessageIds.push(sentMessage.id);
    }

    return sentMessageIds;
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
    const giveawayRows = await db`
        update giveaways
        set
            status = 'ended',
            ended_at = now()
        where id = ${giveawayId}
            and status = 'active'
        returning *
    `;
    const giveaway = giveawayRows[0];

    if (!giveaway) {
        return null;
    }

    const countRows = await db`
        select count(*)::int as count
        from giveaway_entries
        where giveaway_id = ${giveaway.id}
    `;
    const winnerRows = await db`
        select player_discord_id
        from giveaway_entries
        where giveaway_id = ${giveaway.id}
        order by random()
        limit 1
    `;
    const entrantCount = countRows[0].count;
    const winnerId = winnerRows[0]?.player_discord_id || null;
    const payoutResult = winnerId
        ? await calculatePayout(
            winnerId,
            BigInt(giveaway.amount),
            process.env.DON_DISCORD_ID,
            db
        )
        : null;

    if (winnerId && !payoutResult) {
        throw new Error(`Giveaway winner ${winnerId} is no longer in the player database.`);
    }

    if (winnerId) {
        await db`
            update giveaways
            set winner_discord_id = ${winnerId}
            where id = ${giveaway.id}
        `;
    }

    const channel = await fetchGiveawayChannel(guild, giveaway);
    const message = channel
        ? await fetchGiveawayMessage(channel, giveaway)
        : null;
    const cleanupMessageIds = [];

    if (channel && winnerId) {
        const payoutMessageIds = await sendPayoutAnnouncement(
            channel,
            message,
            giveaway,
            payoutResult,
            winnerId
        );
        cleanupMessageIds.push(...payoutMessageIds);
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

    if (message) {
        try {
            await message.delete();
        } catch (error) {
            cleanupMessageIds.push(message.id);
            console.warn(
                `Could not immediately delete giveaway message ${message.id} for giveaway ${giveaway.id}: ${error.message}`
            );
        }
    }

    await db`
        update giveaways
        set
            cleanup_due_at = now() + interval '12 hours',
            cleanup_message_ids = ${JSON.stringify([...new Set(cleanupMessageIds)])}::jsonb
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
    const channel = guild.channels.cache.get(giveaway.channel_id) ||
        (await guild.channels.fetch(giveaway.channel_id).catch(() => null));

    if (!channel?.isTextBased()) {
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
        const message = await channel.messages.fetch(messageId).catch(() => null);

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
    GIVEAWAY_BUTTON_PREFIX,
    GIVEAWAY_CHANNEL_ID,
    cleanupEndedGiveawaysForGuild,
    closeGiveawayMessages,
    createGiveaway,
    endGiveawayEarly,
    enterGiveaway,
    finishExpiredGiveawaysForGuild,
    finishGiveaway,
    giveawayLinkModal,
    handleGiveawayButton,
    handleGiveawayLinkModal,
    leaveGiveaway,
    parseGiveawayDuration,
    renderGiveaway,
    renderGiveawayHostControls
};
