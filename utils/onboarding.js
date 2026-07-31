const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ModalBuilder,
    OverwriteType,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');

const {
    DEFAULT_RANK_NAME,
    ensureRankRoles,
    ensureWelcomeCategory,
    syncMemberRankRole
} = require('./bootstrap.js');
const {
    setMemberNicknameToIgn
} = require('./nicknames.js');
const {
    donDiscordIds
} = require('./staff.js');

const BUTTON_PREFIX = 'welcome';
const MODAL_PREFIX = 'welcome_ign_submit';
const JOIN_ALL_MODAL_PREFIX = 'welcome_join_all_ign';
const WELCOME_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const WELCOME_SELF_DESTRUCT_SECONDS = 30;
const WELCOME_DM_CLEANUP_STATE_FILE = process.env.WELCOME_DM_CLEANUP_STATE_FILE ||
    path.join(__dirname, '..', '.welcome-dm-cleanup-queue.json');

// Tracks exact message ids pending self-destruct in a DM welcome flow, keyed
// by channel id, so a restart mid-countdown can finish deleting precisely
// those messages later - never a broader sweep of the user's other DMs.
function loadPendingWelcomeDmCleanups() {
    try {
        const raw = fs.readFileSync(WELCOME_DM_CLEANUP_STATE_FILE, 'utf8');
        const pending = JSON.parse(raw);
        return pending && typeof pending === 'object' && !Array.isArray(pending)
            ? pending
            : {};
    } catch {
        return {};
    }
}

function savePendingWelcomeDmCleanups(pending) {
    const temporaryFile = `${WELCOME_DM_CLEANUP_STATE_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(pending), 'utf8');
    fs.renameSync(temporaryFile, WELCOME_DM_CLEANUP_STATE_FILE);
}

function recordPendingWelcomeDmCleanup(channelId, messageIds) {
    const pending = loadPendingWelcomeDmCleanups();
    pending[channelId] = [...new Set(messageIds.filter(Boolean))];
    savePendingWelcomeDmCleanups(pending);
}

function clearPendingWelcomeDmCleanup(channelId) {
    const pending = loadPendingWelcomeDmCleanups();

    if (!(channelId in pending)) {
        return;
    }

    delete pending[channelId];
    savePendingWelcomeDmCleanups(pending);
}

async function resumePendingWelcomeDmCleanups(client) {
    const pending = loadPendingWelcomeDmCleanups();
    const channelIds = Object.keys(pending);
    let messagesDeleted = 0;
    let channelsCleaned = 0;

    for (const channelId of channelIds) {
        const messageIds = pending[channelId];
        const remainingMessageIds = [];

        try {
            const channel = await client.channels.fetch(channelId);

            for (const messageId of messageIds) {
                try {
                    await channel.messages.delete(messageId);
                    messagesDeleted++;
                } catch (error) {
                    // Discord's "unknown message" error means it was already
                    // deleted (e.g. right before the restart) - nothing to do.
                    if (error?.code !== 10008) {
                        remainingMessageIds.push(messageId);
                        console.error(`Failed to delete pending welcome DM message ${messageId} in channel ${channelId}:`, error);
                    }
                }
            }

            if (remainingMessageIds.length === 0) {
                channelsCleaned++;
            }
        } catch (error) {
            // An unknown DM channel cannot become fetchable on a later retry.
            // Other errors (temporary API failures, missing access, etc.) stay
            // queued for the next startup.
            if (error?.code !== 10003) {
                remainingMessageIds.push(...messageIds);
                console.error(`Failed to resume welcome DM cleanup for channel ${channelId}:`, error);
            } else {
                channelsCleaned++;
            }
        }

        if (remainingMessageIds.length > 0) {
            recordPendingWelcomeDmCleanup(channelId, remainingMessageIds);
        } else {
            clearPendingWelcomeDmCleanup(channelId);
        }
    }

    return {
        channelsCleaned,
        messagesDeleted
    };
}
let sqlClient = null;

function database() {
    if (!sqlClient) {
        sqlClient = require('../db.js');
    }

    return sqlClient;
}

function giveawayActions() {
    return require('./giveaways.js');
}

function commissionPaymentActions() {
    return require('./commissionPayments.js');
}

function buttonId(action, userId, isTest = false) {
    return `${BUTTON_PREFIX}:${action}:${userId}:${isTest ? 'test' : 'live'}`;
}

function joinAllIgnModalId(userId, edition, isTest = false) {
    return `${JOIN_ALL_MODAL_PREFIX}:${userId}:${edition}:${isTest ? 'test' : 'live'}`;
}

function minecraftEditionLabel(edition) {
    return edition === 'bedrock' ? 'Bedrock' : 'Java';
}

function scopedButton(action, userId, label, style = ButtonStyle.Primary, isTest = false) {
    return new ButtonBuilder()
        .setCustomId(buttonId(action, userId, isTest))
        .setLabel(label)
        .setStyle(style);
}

function row(...components) {
    return new ActionRowBuilder().addComponents(...components);
}

function normalizeWelcomePayload(interaction, message) {
    const payload = {
        ...message
    };

    if (payload.files || interaction.message?.attachments?.size) {
        payload.attachments = [];
    }

    return payload;
}

async function updateWithReadingDelay(interaction, message) {
    await interaction.deferUpdate();

    const resolvedMessage = typeof message === 'function'
        ? await message()
        : await message;

    await interaction.editReply(normalizeWelcomePayload(interaction, resolvedMessage));
}

function sanitizeChannelName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28) || 'new-penguin';
}

function welcomeChannelTopic(userId) {
    return `Penguin Mafia onboarding:${userId}`;
}

function escapeDiscordMarkdown(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/([*_`~|])/g, '\\$1');
}

async function resolveGrandRecruiterId(recruiterId) {
    if (!recruiterId) {
        return null;
    }

    const rows = await database()`
        select parent_discord_id
        from players
        where discord_id = ${recruiterId}
        limit 1
    `;

    return rows[0]?.parent_discord_id || null;
}

function isWelcomeFlowMessage(message, userId) {
    if (message.author.id !== message.client.user.id) {
        return false;
    }

    const hasWelcomeButton = message.components.some(actionRow => {
        return actionRow.components.some(component => {
            return component.customId?.startsWith(`${BUTTON_PREFIX}:`) &&
                component.customId.includes(`:${userId}:live`);
        });
    });

    if (hasWelcomeButton) {
        return true;
    }

    return message.content.includes('PENGUIN MAFIA') &&
        message.content.includes(userId);
}

function introMessage(member, context = {}) {
    const helperMentions = [context.recruiterId, context.grandRecruiterId]
        .filter(Boolean);
    const safeInviterDisplayName = escapeDiscordMarkdown(context.inviterDisplayName || 'your recruiter');
    const parentLine = context.inviterDisplayName
        ? `Our bots detected ${context.recruiterId ? `<@${context.recruiterId}>` : `**${safeInviterDisplayName}**`} as your recruiter. They${context.grandRecruiterId ? ` and <@${context.grandRecruiterId}>` : ''} can see this room and help if you get stuck.`
        : `No recruiter was detected for this join. If someone invited you, use \`/join recruiter:@TheirDiscord\` after this tutorial.`;
    const isTest = Boolean(context.isTest);

    return {
        content:
            `# 🐧 Welcome to the Penguin Mafia!\n\n` +
            `Recruit players, grow your team, win giveaways, and earn rewards together.\n\n` +
            `Let's get you set up in under a minute.\n\n` +
            `${parentLine}`,
        allowedMentions: {
            users: [member.id, ...helperMentions],
            parse: []
        },
        components: [
            row(scopedButton('build_team', member.id, 'Next', ButtonStyle.Success, isTest))
        ]
    };
}

function buildTeamMessage(userId, isTest = false) {
    return {
        content:
            `# 👥 Build Your Team\n\n` +
            `Every player you recruit becomes part of your recruit tree.\n\n` +
            `As your team participates and earns rewards, you'll earn commission bonuses too.\n\n` +
            `Use \`/graph\` to view your recruit tree at any time.\n\n` +
            `More penguins. More power.`,
        components: [
            row(scopedButton('rank_up', userId, 'Next', ButtonStyle.Success, isTest))
        ]
    };
}

function rankUpMessage(userId, isTest = false) {
    return {
        content:
            `# 👑 Climb the Ranks\n\n` +
            `🐧 Penguin Soldier\n` +
            `🎩 Penguin Captain\n` +
            `⭐ Penguin General\n` +
            `👑 Emperor Penguin\n\n` +
            `Recruit active players and help them grow to unlock higher ranks and better commission bonuses.\n\n` +
            `Check #🐧-rank-info for the full breakdown of how ranks and commissions work.`,
        components: [
            row(scopedButton('link_minecraft', userId, 'Next', ButtonStyle.Success, isTest))
        ]
    };
}

function linkMinecraftMessage(userId, isTest = false) {
    return {
        content:
            `# 🎮 One Last Step\n\n` +
            `To send you DonutSMP rewards automatically, we need:\n\n` +
            `📝 Your Minecraft IGN\n` +
            `💻 Your edition (Java or Bedrock)\n\n` +
            `We only use this information to identify your in-game account for payouts and giveaways. We will never ask for your password, email, Microsoft account, or login information.\n\n` +
            `Without your IGN, we can't automatically send giveaway prizes or other rewards.`,
        components: [
            row(
                scopedButton('join_all_ign_java', userId, 'Java', ButtonStyle.Success, isTest),
                scopedButton('join_all_ign_bedrock', userId, 'Bedrock', ButtonStyle.Success, isTest),
                scopedButton('join_all_skip', userId, 'Skip', ButtonStyle.Secondary, isTest)
            )
        ]
    };
}

function finalMessage(userId, linkedIgn = null, edition = null, options = {}) {
    const linkedLine = linkedIgn
        ? `Your account has been linked successfully.\n\n✅ **${linkedIgn}**${edition ? ` (${minecraftEditionLabel(edition)})` : ''}`
        : (options.skipMessage || `⏭️ IGN skipped. Use \`/penguinlink\` later for faster payouts.`);
    const giveawayLine = options.giveawayEntryResult
        ? `\n🎉 Entered **${options.giveawayEntryResult.inserted_count}** new active giveaway${options.giveawayEntryResult.inserted_count === 1 ? '' : 's'} out of **${options.giveawayEntryResult.eligible_count}** eligible.`
        : (options.giveawaySkippedLine ? `\n${options.giveawaySkippedLine}` : '');

    return {
        content:
            `# ✅ You're In!\n\n` +
            `🐧 Welcome to the Penguin Mafia!\n\n` +
            `${linkedLine}${giveawayLine}\n\n` +
            `🎉 You're now a **${DEFAULT_RANK_NAME}**.\n\n` +
            `Use \`/graph\` anytime to view your recruit tree, and visit #🐧-rank-info to learn how ranks and commissions work.\n\n` +
            `Good luck, and start building your empire!`,
        components: []
    };
}

async function scheduleWelcomeChannelDelete(interaction, seconds = WELCOME_SELF_DESTRUCT_SECONDS) {
    const channel = interaction.channel;

    let countdownMessage = null;

    try {
        countdownMessage = await interaction.followUp({
            content: `💣🐧 This secret penguin training room will self destruct in **${seconds}**...`,
            fetchReply: true
        });
    } catch (error) {
        console.error(`Failed to start welcome channel countdown in ${channel?.id || 'unknown'}:`);
        console.error(error);
    }

    for (let remaining = seconds - 1; remaining >= 1; remaining--) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!countdownMessage) continue;

        try {
            await countdownMessage.edit({
                content: `💣🐧 This secret penguin training room will self destruct in **${remaining}**...`
            });
        } catch {
            countdownMessage = null;
        }
    }

    if (seconds > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    try {
        if (!channel?.deletable) {
            console.error(`Failed to delete welcome channel ${channel?.id || 'unknown'}: channel is not deletable.`);
            return false;
        }

        await channel.delete('Penguin Mafia welcome flow completed');
        return true;
    } catch (error) {
        // Unknown channel means another cleanup path already deleted it.
        if (error?.code === 10003) {
            return true;
        }

        console.error(`Failed to delete welcome channel ${channel?.id || 'unknown'}:`);
        console.error(error);
        return false;
    }
}

async function scheduleWelcomeMessageDelete(interaction, seconds = WELCOME_SELF_DESTRUCT_SECONDS) {
    const channelId = interaction.channel.id;
    let finalMessageId = null;

    try {
        const finalMessage = interaction.message || await interaction.fetchReply();
        finalMessageId = finalMessage?.id || null;
    } catch (error) {
        console.error('Failed to resolve welcome final message id for self-destruct tracking:');
        console.error(error);
    }

    let countdownMessage = null;

    try {
        countdownMessage = await interaction.followUp({
            content: `💣 This message will self destruct in **${seconds}**...`,
            fetchReply: true
        });
    } catch (error) {
        console.error('Failed to start welcome message countdown:');
        console.error(error);
    }

    const pendingMessageIds = [finalMessageId, countdownMessage?.id].filter(Boolean);

    if (pendingMessageIds.length > 0) {
        recordPendingWelcomeDmCleanup(channelId, pendingMessageIds);
    }

    for (let remaining = seconds - 1; remaining >= 1; remaining--) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!countdownMessage) continue;

        try {
            await countdownMessage.edit({
                content: `💣 This message will self destruct in **${remaining}**...`
            });
        } catch {
            countdownMessage = null;
        }
    }

    if (seconds > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const remainingMessageIds = [];

    for (const messageId of pendingMessageIds) {
        try {
            await interaction.channel.messages.delete(messageId);
        } catch (error) {
            if (error?.code !== 10008) {
                remainingMessageIds.push(messageId);
                console.error(`Failed to delete welcome DM message ${messageId} in channel ${channelId}:`);
                console.error(error);
            }
        }
    }

    if (remainingMessageIds.length > 0) {
        recordPendingWelcomeDmCleanup(channelId, remainingMessageIds);
    } else {
        clearPendingWelcomeDmCleanup(channelId);
    }
}

async function getOnboardingChannels(guild, context = {}) {
    if (context.channelCache) {
        return context.channelCache;
    }

    return guild.channels.fetch();
}

function rememberOnboardingChannel(context, channel) {
    if (context.channelCache && channel) {
        context.channelCache.set(channel.id, channel);
    }
}

async function ensureWelcomeChannel(member, context = {}) {
    const guild = member.guild;
    const channels = await getOnboardingChannels(guild, context);
    const topic = welcomeChannelTopic(member.id);
    const grandRecruiterId = context.grandRecruiterId !== undefined
        ? context.grandRecruiterId
        : await resolveGrandRecruiterId(context.recruiterId);
    let channel = channels.find(existingChannel => {
        return existingChannel?.type === ChannelType.GuildText && existingChannel.topic === topic;
    });

    const category = await ensureWelcomeCategory(guild, {
        channelCache: context.channelCache,
        requireAvailableSlot: true
    });
    const permissionOverwrites = [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel
            ]
        },
        {
            id: member.id,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
            ]
        }
    ];

    const addMemberOverwrite = (userId, allow) => {
        if (!userId || permissionOverwrites.some(overwrite => overwrite.id === userId)) {
            return;
        }

        permissionOverwrites.push({
            id: userId,
            type: OverwriteType.Member,
            allow
        });
    };

    addMemberOverwrite(context.recruiterId, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
    ]);
    addMemberOverwrite(grandRecruiterId, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
    ]);

    for (const donDiscordId of donDiscordIds()) {
        addMemberOverwrite(donDiscordId, [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages
        ]);
    }

    if (!channel) {
        channel = await guild.channels.create({
            name: `🐧-welcome-${sanitizeChannelName(member.user.username)}`,
            type: ChannelType.GuildText,
            parent: category.id,
            topic,
            permissionOverwrites,
            reason: 'Penguin Mafia private welcome onboarding'
        });
        rememberOnboardingChannel(context, channel);
    } else {
        await channel.permissionOverwrites.set(
            permissionOverwrites,
            'Penguin Mafia private welcome onboarding permissions'
        );
    }

    return channel;
}

async function sendWelcomeReminderIfDue(member, channel) {
    const rows = await database()`
        select welcome_completed, welcome_reminder_sent_at
        from players
        where discord_id = ${member.id}
        limit 1
    `;
    const player = rows[0];

    if (!player || player.welcome_completed) {
        return false;
    }

    const lastReminderAt = player.welcome_reminder_sent_at
        ? new Date(player.welcome_reminder_sent_at).getTime()
        : 0;

    if (lastReminderAt && Date.now() - lastReminderAt < WELCOME_REMINDER_INTERVAL_MS) {
        return false;
    }

    const channelLink = `https://discord.com/channels/${member.guild.id}/${channel.id}`;

    try {
        await member.send({
            content:
                `🐧 Hey! You still need to finish your **Penguin Mafia** welcome setup.\n\n` +
                `Please go to ${channel} and press **Next** until you finish.\n\n` +
                `Direct link: ${channelLink}\n\n` +
                `Once you complete it, you’ll get your **${DEFAULT_RANK_NAME}** role and full server access.`
        });

        await database()`
            update players
            set
                welcome_reminder_sent_at = now(),
                updated_at = now()
            where discord_id = ${member.id}
        `;

        console.log(`Welcome reminder DM sent to ${member.user.tag} for ${channel.name} (${channel.id}).`);
        return true;
    } catch (error) {
        console.log(`Could not DM welcome reminder to ${member.user.tag}: ${error.message}`);
        return false;
    }
}

async function startOnboardingForMember(member, context = {}) {
    const channel = await ensureWelcomeChannel(member, context);
    const isTest = Boolean(context.isTest);
    const grandRecruiterId = context.grandRecruiterId !== undefined
        ? context.grandRecruiterId
        : await resolveGrandRecruiterId(context.recruiterId);
    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const alreadyStarted = recentMessages?.some(message => {
        return isWelcomeFlowMessage(message, member.id);
    });

    if (alreadyStarted && !isTest) {
        return channel;
    }

    await channel.send(introMessage(member, {
        ...context,
        grandRecruiterId
    }));
    return channel;
}

async function remindIncompleteWelcomeMembers(guild) {
    const rows = await database()`
        select discord_id, parent_discord_id
        from players
        where welcome_completed = false
            and (
                welcome_reminder_sent_at is null
                or welcome_reminder_sent_at <= now() - interval '2 days'
            )
    `;

    if (rows.length === 0) {
        return {
            checked: 0,
            sent: 0
        };
    }

    const channelCache = await guild.channels.fetch();
    let sent = 0;

    for (const player of rows) {
        const member = await guild.members.fetch(player.discord_id).catch(() => null);

        if (!member || member.user.bot) {
            continue;
        }

        const channel = await ensureWelcomeChannel(member, {
            channelCache,
            recruiterId: player.parent_discord_id
        });
        const reminderSent = await sendWelcomeReminderIfDue(member, channel);

        if (reminderSent) {
            sent++;
        }
    }

    return {
        checked: rows.length,
        sent
    };
}

async function cleanupWelcomeChannelsForMissingMembers(guild, members) {
    const memberIds = new Set([...members.keys()]);
    const channels = await guild.channels.fetch();
    const staleWelcomeChannels = channels.filter(channel => {
        if (channel?.type !== ChannelType.GuildText) {
            return false;
        }

        const match = String(channel.topic || '').match(/^Penguin Mafia onboarding:(\d{15,25})$/);

        return match && !memberIds.has(match[1]);
    });
    const deletedChannels = [];

    for (const [, channel] of staleWelcomeChannels) {
        try {
            if (!channel.deletable) {
                console.log(`Could not delete stale welcome channel ${channel.name} (${channel.id}): channel is not deletable.`);
                continue;
            }

            await channel.delete('Penguin Mafia stale onboarding cleanup');
            deletedChannels.push(channel);
        } catch (error) {
            console.error(`Could not delete stale welcome channel ${channel.name} (${channel.id}):`);
            console.error(error);
        }
    }

    return deletedChannels;
}

async function cleanupCompletedWelcomeChannels(guild) {
    const channels = await guild.channels.fetch();
    const welcomeChannels = channels.filter(channel => {
        return channel?.type === ChannelType.GuildText &&
            /^Penguin Mafia onboarding:(\d{15,25})$/.test(String(channel.topic || ''));
    });

    if (welcomeChannels.size === 0) {
        return [];
    }

    const memberIds = [...welcomeChannels.values()].map(channel => {
        return String(channel.topic).match(/^Penguin Mafia onboarding:(\d{15,25})$/)[1];
    });

    const rows = await database()`
        select discord_id
        from players
        where discord_id = any(${memberIds})
            and welcome_completed = true
    `;
    const completedMemberIds = new Set(rows.map(row => row.discord_id));
    const deletedChannels = [];

    for (const [, channel] of welcomeChannels) {
        const match = String(channel.topic).match(/^Penguin Mafia onboarding:(\d{15,25})$/);
        const memberId = match[1];

        if (!completedMemberIds.has(memberId)) {
            continue;
        }

        try {
            if (!channel.deletable) {
                console.log(`Could not delete completed welcome channel ${channel.name} (${channel.id}): channel is not deletable.`);
                continue;
            }

            await channel.delete('Penguin Mafia onboarding already completed; self-destruct did not finish before a restart');
            deletedChannels.push(channel);
        } catch (error) {
            console.error(`Could not delete completed welcome channel ${channel.name} (${channel.id}):`);
            console.error(error);
        }
    }

    return deletedChannels;
}

async function cleanupWelcomeChannelForMember(guild, userId) {
    const channels = await guild.channels.fetch();
    const welcomeChannel = channels.find(channel => {
        return channel?.type === ChannelType.GuildText &&
            String(channel.topic || '') === welcomeChannelTopic(userId);
    });

    if (!welcomeChannel) {
        return null;
    }

    try {
        if (!welcomeChannel.deletable) {
            console.log(`Could not delete welcome channel ${welcomeChannel.name} (${welcomeChannel.id}) for ${userId}: channel is not deletable.`);
            return null;
        }

        await welcomeChannel.delete('Penguin Mafia onboarding cleanup for member leave');
        return welcomeChannel;
    } catch (error) {
        console.error(`Could not delete welcome channel ${welcomeChannel.name} (${welcomeChannel.id}) for ${userId}:`);
        console.error(error);
        return null;
    }
}

async function completeOnboarding(member, linkedIgn = null, minecraftEdition = null) {
    await database()`
        update players
        set
            welcome_completed = true,
            minecraft_ign = coalesce(${linkedIgn}, minecraft_ign),
            minecraft_edition = coalesce(${minecraftEdition}, minecraft_edition),
            updated_at = now()
        where discord_id = ${member.id}
    `;

    const { rankRoles } = await ensureRankRoles(member.guild);
    await syncMemberRankRole(member, rankRoles, DEFAULT_RANK_NAME);

    if (linkedIgn) {
        await database()`
            update players
            set
                account_link_reminders_disabled = false,
                account_link_reminder_sent_at = null,
                updated_at = now()
            where discord_id = ${member.id}
        `;

        await setMemberNicknameToIgn(member, linkedIgn);
    }
}

async function skipOnboardingIgn(userId) {
    await database()`
        update players
        set
            account_link_reminders_disabled = true,
            updated_at = now()
        where discord_id = ${userId}
    `;
}

function buildIgnModal(customId, minecraftEdition) {
    const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle(`Link ${minecraftEditionLabel(minecraftEdition)} IGN`);

    const ignInput = new TextInputBuilder()
        .setCustomId('minecraft_ign')
        .setLabel('Minecraft IGN')
        .setPlaceholder('Example: PenguinBoss123')
        .setMinLength(3)
        .setMaxLength(16)
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder().addComponents(ignInput));
    return modal;
}

function validMinecraftIgn(minecraftIgn) {
    return /^[A-Za-z0-9_]{3,16}$/.test(minecraftIgn);
}

async function acknowledgeWelcomeCompletion(interaction) {
    if (interaction.deferred || interaction.replied) {
        return;
    }

    if (typeof interaction.deferUpdate === 'function' && interaction.message) {
        await interaction.deferUpdate();
        return;
    }

    await interaction.deferReply();
}

async function payWelcomeCompletionBonus(interaction, minecraftIgn) {
    const bonusRows = await database()`
        select value from bot_state where key = 'welcome_bonus_paid:' || ${interaction.user.id} limit 1
    `;

    if (bonusRows[0]?.value) {
        return;
    }

    try {
        await commissionPaymentActions().ensureMinecraftBotConnected({
            guild: interaction.guild,
            source: 'Welcome bonus'
        });

        await commissionPaymentActions().payPlayerAfterBusyWait(minecraftIgn, '1000', {
            guild: interaction.guild,
            source: `Welcome bonus for ${interaction.user.id}`,
            actorId: interaction.user.id,
            suppressPaymentLog: true
        });

        await database()`
            insert into bot_state (key, value)
            values ('welcome_bonus_paid:' || ${interaction.user.id}, 'true')
            on conflict (key) do nothing
        `;

        await interaction.user.send(
            `🐧 **Welcome to the Penguin Mafia!**\n\n` +
            `You've received a **1,000** welcome bonus for linking your account!\n\n` +
            `Start recruiting to climb the ranks and earn more rewards. Use \`/graph\` to see your tree.`
        ).catch(() => {});
    } catch (bonusError) {
        console.log(`Welcome bonus failed during onboarding for ${interaction.user.tag}: ${bonusError.message}`);
    }
}

async function respondWithWelcomeFinal(interaction, payload) {
    if (typeof interaction.update === 'function' && interaction.message) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }

        await interaction.editReply(normalizeWelcomePayload(interaction, payload));
        return;
    }

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply(normalizeWelcomePayload(interaction, payload));
        return;
    }

    await interaction.reply(payload);
}

async function finishOnboardingInteraction(interaction, options) {
    const {
        targetUserId,
        isTest,
        linkedIgn = null,
        minecraftEdition = null,
        skipMessage = null,
        giveawaySkippedLine = null,
        enterAllGiveaways = false
    } = options;
    let giveawayEntryResult = null;
    let finalGiveawaySkippedLine = giveawaySkippedLine;

    // Acknowledge before database, Discord role, giveaway, or Minecraft work.
    // Discord invalidates an unacknowledged component/modal interaction after
    // roughly three seconds, which previously prevented the countdown from
    // ever being scheduled when those operations were slow.
    await acknowledgeWelcomeCompletion(interaction);

    if (!isTest) {
        const member = await interaction.guild.members.fetch(targetUserId);
        await completeOnboarding(member, linkedIgn, minecraftEdition);

        if (enterAllGiveaways && linkedIgn && minecraftEdition) {
            try {
                const entryResult = await giveawayActions().enterAllActiveGiveawaysForUser(
                    interaction.guild,
                    targetUserId,
                    database()
                );

                if (entryResult.eligible_count > 0 || entryResult.own_skipped > 0) {
                    giveawayEntryResult = entryResult;
                } else {
                    finalGiveawaySkippedLine = 'ℹ️ There were no active eligible giveaways to enter right now.';
                }
            } catch (error) {
                finalGiveawaySkippedLine = '⚠️ Automatic giveaway entry could not finish. You can enter active giveaways normally after welcome.';
                console.error(`Welcome giveaway entry failed for ${targetUserId}:`);
                console.error(error);
            }
        }
    }

    try {
        await respondWithWelcomeFinal(
            interaction,
            finalMessage(targetUserId, linkedIgn, minecraftEdition, {
                skipMessage,
                giveawayEntryResult,
                giveawaySkippedLine: finalGiveawaySkippedLine
            })
        );
    } finally {
        const cleanupPromise = interaction.channel?.isDMBased?.()
            ? scheduleWelcomeMessageDelete(interaction)
            : scheduleWelcomeChannelDelete(interaction);

        // The database completion flag is the durable source of truth for
        // guild rooms. Startup and weekly maintenance remove a completed room
        // if the process exits while this in-memory countdown is running.
        void cleanupPromise.catch(error => {
            console.error(`Welcome cleanup pipeline failed for channel ${interaction.channel?.id || 'unknown'}:`);
            console.error(error);
        });
    }
}

async function handleWelcomeButton(interaction) {
    const parts = interaction.customId.split(':');

    if (parts[0] !== BUTTON_PREFIX) return false;

    const action = parts[1];
    const targetUserId = parts[2];
    const isTest = parts[3] === 'test';

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '🐧 This welcome training belongs to another penguin.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (
        action === 'start' ||
        action === 'rank_graph' ||
        action === 'build_team' ||
        action === 'ranks' ||
        action.startsWith('direct_recruit_')
    ) {
        await updateWithReadingDelay(interaction, buildTeamMessage(targetUserId, isTest));
        return true;
    }

    if (
        action === 'rank_up' ||
        action === 'recruit' ||
        action === 'why_team' ||
        action.startsWith('general_train_') ||
        action.startsWith('emperor_train_')
    ) {
        await updateWithReadingDelay(interaction, rankUpMessage(targetUserId, isTest));
        return true;
    }

    if (
        action === 'link_minecraft' ||
        action === 'giveaway_prompt' ||
        action === 'account_link_info' ||
        action === 'giveaway_join_all_yes' ||
        action === 'giveaway_pay_yes' ||
        action === 'ign'
    ) {
        await updateWithReadingDelay(interaction, linkMinecraftMessage(targetUserId, isTest));
        return true;
    }

    if (
        action === 'join_all_ign_java' ||
        action === 'join_all_ign_bedrock' ||
        action === 'enter_ign_java' ||
        action === 'enter_ign_bedrock'
    ) {
        const minecraftEdition = action.endsWith('bedrock') ? 'bedrock' : 'java';
        const modalId = joinAllIgnModalId(targetUserId, minecraftEdition, isTest);

        await interaction.showModal(buildIgnModal(modalId, minecraftEdition));
        return true;
    }

    if (
        action === 'join_all_skip' ||
        action === 'skip_ign' ||
        action === 'skip_ign_later' ||
        action === 'giveaway_join_all_no' ||
        action === 'giveaway_pay_no'
    ) {
        await acknowledgeWelcomeCompletion(interaction);

        if (!isTest) {
            await skipOnboardingIgn(targetUserId);
        }

        await finishOnboardingInteraction(interaction, {
            targetUserId,
            isTest,
            skipMessage: `⏭️ Username skipped for now. You can link it later with \`/penguinlink\`.`,
            giveawaySkippedLine: 'Skipped automatic giveaway entry because no Minecraft account was linked.'
        });
        return true;
    }

    if (action === 'done') {
        await acknowledgeWelcomeCompletion(interaction);
        await finishOnboardingInteraction(interaction, {
            targetUserId,
            isTest
        });
        return true;
    }

    return false;
}

async function handleWelcomeModal(interaction) {
    const isJoinAllModal = interaction.customId.startsWith(`${JOIN_ALL_MODAL_PREFIX}:`);

    if (!interaction.customId.startsWith(`${MODAL_PREFIX}:`) && !isJoinAllModal) return false;

    const parts = interaction.customId.split(':');
    const targetUserId = parts[1];
    const minecraftEdition = ['java', 'bedrock'].includes(parts[2]) ? parts[2] : null;
    const isTest = ['java', 'bedrock'].includes(parts[2]) ? parts[3] === 'test' : parts[2] === 'test';

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '🐧 This Minecraft IGN form belongs to another penguin.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const minecraftIgn = interaction.fields.getTextInputValue('minecraft_ign').trim();

    if (!validMinecraftIgn(minecraftIgn)) {
        await interaction.reply({
            content:
                `❌ Invalid Minecraft IGN.\n\n` +
                `Minecraft usernames must be 3-16 characters and can only use letters, numbers, and underscores.`,
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    await acknowledgeWelcomeCompletion(interaction);

    if (!isTest) {
        console.log(`Welcome IGN link for ${interaction.user.tag}: ${minecraftIgn}${minecraftEdition ? ` (${minecraftEditionLabel(minecraftEdition)})` : ''}. Join-all=${isJoinAllModal ? 'yes' : 'no'}.`);
    }

    await finishOnboardingInteraction(interaction, {
        targetUserId,
        isTest,
        linkedIgn: minecraftIgn,
        minecraftEdition,
        enterAllGiveaways: isJoinAllModal
    });

    // Minecraft can be disconnected or busy for up to two minutes. The
    // durable Discord completion and cleanup countdown must already be active
    // before this external side effect is attempted.
    if (!isTest) {
        await payWelcomeCompletionBonus(interaction, minecraftIgn);
    }

    return true;
}

async function startTestOnboardingInDm(userOrMember) {
    const user = userOrMember?.user || userOrMember;

    if (!user?.id || typeof user.createDM !== 'function') {
        throw new Error('A valid Discord player is required for the DM welcome preview.');
    }

    const previewMember = {
        id: user.id,
        user,
        displayName: user.globalName || user.username,
        toString() {
            return `<@${user.id}>`;
        }
    };
    const dm = await user.createDM();

    await dm.send(introMessage(previewMember, {
        isTest: true,
        isDm: true
    }));

    return dm;
}

module.exports = {
    cleanupCompletedWelcomeChannels,
    cleanupWelcomeChannelForMember,
    cleanupWelcomeChannelsForMissingMembers,
    remindIncompleteWelcomeMembers,
    resumePendingWelcomeDmCleanups,
    startTestOnboardingInDm,
    startOnboardingForMember,
    handleWelcomeButton,
    handleWelcomeModal,
    _test: {
        acknowledgeWelcomeCompletion,
        clearPendingWelcomeDmCleanup,
        loadPendingWelcomeDmCleanups,
        recordPendingWelcomeDmCleanup,
        scheduleWelcomeChannelDelete
    }
};
