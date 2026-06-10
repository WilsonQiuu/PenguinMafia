const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');

const {
    ensureTrainerRole,
    ensureWelcomeCategory
} = require('./bootstrap.js');
const sql = require('../db.js');

const BUTTON_PREFIX = 'trainer';

function buttonId(action, userId) {
    return `${BUTTON_PREFIX}:${action}:${userId}`;
}

function button(action, userId, label = 'Next', style = ButtonStyle.Success) {
    return new ButtonBuilder()
        .setCustomId(buttonId(action, userId))
        .setLabel(label)
        .setStyle(style);
}

function row(...components) {
    return new ActionRowBuilder().addComponents(...components);
}

function sanitizeChannelName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28) || 'trainer';
}

function trainerChannelTopic(userId) {
    return `Penguin Mafia trainer onboarding:${userId}`;
}

function introMessage(member) {
    return {
        content:
            `# 🐧🎓 PENGUIN TRAINER OFFER\n\n` +
            `Congratulations ${member}!\n\n` +
            `You have been chosen because the team thinks you are a good fit to train new recruits.\n\n` +
            `Do you accept this position?`,
        components: [
            row(
                button('accept', member.id, 'Accept', ButtonStyle.Success),
                button('reject', member.id, 'Reject', ButtonStyle.Danger)
            )
        ]
    };
}

function welcomeRecruitsMessage(userId) {
    return {
        content:
            `# 🐧 TRAINING\n\n` +
            `Use \`/training\` anytime to come back here.\n\n` +
            `## Part 1 • First Recruit\n\n` +
            `Do **not** explain everything at once.\n\n` +
            `First goal only:\n` +
            `🐧 Find **1 recruit**\n` +
            `🎨 They put on **any penguin skin**\n` +
            `🔗 They join with your invite\n\n` +
            `If the bot misses it, have them use:\n` +
            `\`/join recruiter:@YourDiscord\``,
        components: [
            row(button('graphs', userId, 'Part 2'))
        ]
    };
}

function graphTrainingMessage(userId) {
    return {
        content:
            `# 🎩 Part 2 • Captain Goal\n\n` +
            `After they get recruit #1, reveal the next step.\n\n` +
            `Goal:\n` +
            `🐧 Recruit **2 more penguins**\n` +
            `📊 Reach **3 direct recruits total**\n` +
            `🎩 Become **Penguin Captain**\n\n` +
            `Keep it simple. One iceberg at a time.`,
        components: [
            row(button('team', userId, 'Part 3'))
        ]
    };
}

function teamBuildingMessage(userId) {
    return {
        content:
            `# 🎓 Part 3 • Train A Captain\n\n` +
            `After Captain, their job is not just recruiting.\n\n` +
            `Goal:\n` +
            `🐧 Get more recruits\n` +
            `🎩 Train **at least 1 recruit** to Captain\n` +
            `🎓 Unlock the option to accept **Penguin Trainer**\n\n` +
            `Trainer is a side role. It does not replace Penguin rank.`,
        components: [
            row(
                button('accept_trainer', userId, 'Accept Trainer', ButtonStyle.Primary),
                button('rankpath', userId, 'Part 4')
            )
        ]
    };
}

function rankPathMessage(userId) {
    return {
        content:
            `# ⭐ Part 4 • General Goal\n\n` +
            `Now they are building leaders.\n\n` +
            `Goal:\n` +
            `🎩 Help **2 more recruits** become Captains\n` +
            `📊 Reach **3 direct Captains total**\n` +
            `⭐ Become **Penguin General**`,
        components: [
            row(button('powers', userId, 'Part 5'))
        ]
    };
}

function powersMessage(userId) {
    return {
        content:
            `# 👑 Part 5 • Emperor Goal\n\n` +
            `Final climb. Biggest iceberg.\n\n` +
            `Goal:\n` +
            `⭐ Help **2 recruits** become Generals\n` +
            `👑 Become **Emperor Penguin**\n\n` +
            `Train slowly. Reveal the next goal only when they finish the current one.`,
        components: [
            row(button('finish', userId, 'Finish'))
        ]
    };
}

function finalMessage(userId) {
    return {
        content:
            `# ✅ TRAINER TRAINING COMPLETE\n\n` +
            `You are ready to train new recruits.\n\n` +
            `Press **Done** to close this room.`,
        components: [
            row(button('done', userId, 'Done'))
        ]
    };
}

async function scheduleTrainerChannelDelete(interaction, reason = 'Penguin Mafia Trainer onboarding completed') {
    const channel = interaction.channel;
    let countdownMessage = null;

    try {
        countdownMessage = await interaction.followUp({
            content: '💣🐧 This Trainer training room will self destruct in **10**...',
            fetchReply: true
        });
    } catch (error) {
        console.error(`Failed to start Trainer onboarding countdown in ${channel?.id || 'unknown'}:`);
        console.error(error);
    }

    for (let seconds = 9; seconds >= 1; seconds--) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!countdownMessage) continue;

        try {
            await countdownMessage.edit({
                content: `💣🐧 This Trainer training room will self destruct in **${seconds}**...`
            });
        } catch {
            countdownMessage = null;
        }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    setTimeout(async () => {
        try {
            if (channel?.deletable) {
                await channel.delete(reason);
            }
        } catch (error) {
            console.error(`Failed to delete Trainer onboarding channel ${channel?.id || 'unknown'}:`);
            console.error(error);
        }
    }, 1_000);
}

async function ensureTrainerOnboardingChannel(member, context = {}) {
    const guild = member.guild;
    const channels = context.channelCache || await guild.channels.fetch();
    const topic = trainerChannelTopic(member.id);
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
            deny: [
                PermissionFlagsBits.ViewChannel
            ]
        },
        {
            id: guild.client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.ManageChannels
            ]
        },
        {
            id: member.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
            ]
        }
    ];

    if (process.env.DON_DISCORD_ID) {
        permissionOverwrites.push({
            id: process.env.DON_DISCORD_ID,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.ManageChannels
            ]
        });
    }

    if (!channel) {
        channel = await guild.channels.create({
            name: `🎓-trainer-${sanitizeChannelName(member.user.username)}`,
            type: ChannelType.GuildText,
            parent: category.id,
            topic,
            permissionOverwrites,
            reason: 'Penguin Mafia Trainer onboarding'
        });

        if (context.channelCache) {
            context.channelCache.set(channel.id, channel);
        }
    } else {
        await channel.permissionOverwrites.set(
            permissionOverwrites,
            'Penguin Mafia Trainer onboarding permissions'
        );
    }

    return channel;
}

function isTrainerOfferMessage(message, userId) {
    if (message.author.id !== message.client.user.id) {
        return false;
    }

    return message.components.some(actionRow => {
        return actionRow.components.some(component => {
            return (
                component.customId === buttonId('accept', userId) ||
                component.customId === buttonId('reject', userId)
            );
        });
    });
}

async function startTrainerOnboardingForMember(member, context = {}) {
    const channel = await ensureTrainerOnboardingChannel(member, context);
    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const offerAlreadyStarted = recentMessages?.some(message => {
        return isTrainerOfferMessage(message, member.id);
    });

    if (offerAlreadyStarted) {
        return channel;
    }

    await channel.send(introMessage(member));
    return channel;
}

async function startTrainerTrainingForMember(member, context = {}) {
    const channel = await ensureTrainerOnboardingChannel(member, context);

    await channel.send(welcomeRecruitsMessage(member.id));
    return channel;
}

async function hasDirectCaptain(playerId) {
    const rows = await sql`
        select count(*)::int as count
        from players
        where parent_discord_id = ${playerId}
            and rank_name in ('Penguin Captain', 'Penguin General', 'Emperor Penguin')
    `;

    return Number(rows[0]?.count || 0) >= 1;
}

async function handleTrainerButton(interaction) {
    const parts = interaction.customId.split(':');

    if (parts[0] !== BUTTON_PREFIX) return false;

    const action = parts[1];
    const targetUserId = parts[2];

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '🐧 This Trainer training room belongs to another penguin.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (action === 'reject') {
        await interaction.update({
            content: '# ❌ TRAINER POSITION REJECTED\n\nNo Trainer role was added. This room will now self destruct.',
            components: []
        });
        await scheduleTrainerChannelDelete(interaction, 'Penguin Mafia Trainer onboarding rejected');
        return true;
    }

    if (action === 'accept') {
        const member = await interaction.guild.members.fetch(targetUserId);
        const { trainerRole } = await ensureTrainerRole(interaction.guild);

        if (!member.roles.cache.has(trainerRole.id)) {
            await member.roles.add(trainerRole, 'Penguin Mafia Trainer accepted onboarding');
        }

        await interaction.update(welcomeRecruitsMessage(targetUserId));
        return true;
    }

    if (action === 'graphs') {
        await interaction.update(graphTrainingMessage(targetUserId));
        return true;
    }

    if (action === 'team') {
        await interaction.update(teamBuildingMessage(targetUserId));
        return true;
    }

    if (action === 'accept_trainer') {
        const member = await interaction.guild.members.fetch(targetUserId);

        if (!(await hasDirectCaptain(targetUserId))) {
            await interaction.reply({
                content:
                    `🐧 Not yet.\n\n` +
                    `To accept **Penguin Trainer**, you need at least **1 direct recruit** at **Penguin Captain or higher**.`,
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        const { trainerRole } = await ensureTrainerRole(interaction.guild);

        if (!member.roles.cache.has(trainerRole.id)) {
            await member.roles.add(trainerRole, 'Penguin Mafia Trainer accepted from /training');
        }

        await interaction.reply({
            content: `✅ **Penguin Trainer accepted.**\n\nYou now have the **${trainerRole.name}** role.`,
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (action === 'rankpath') {
        await interaction.update(rankPathMessage(targetUserId));
        return true;
    }

    if (action === 'powers') {
        await interaction.update(powersMessage(targetUserId));
        return true;
    }

    if (action === 'finish') {
        await interaction.update(finalMessage(targetUserId));
        return true;
    }

    if (action === 'done') {
        await interaction.update({
            content: '# ✅ TRAINER TRAINING COMPLETE\n\nThis room will now self destruct.',
            components: []
        });
        await scheduleTrainerChannelDelete(interaction);
        return true;
    }

    return false;
}

module.exports = {
    handleTrainerButton,
    startTrainerOnboardingForMember,
    startTrainerTrainingForMember
};
