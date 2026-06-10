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
            `# 1 • WELCOME NEW RECRUITS\n\n` +
            `When a new player joins from welcome, greet them in the server.\n\n` +
            `Say hi, make them feel seen, and help them get comfortable.\n\n` +
            `After they are welcomed, move them into the **Recruit Training VC**.`,
        components: [
            row(button('graphs', userId))
        ]
    };
}

function graphTrainingMessage(userId) {
    return {
        content:
            `# 2 • SHOW THEM THE TREE\n\n` +
            `Have the recruit run \`/graph\` so they can see their team.\n\n` +
            `Their graph will probably be empty at first. That is okay.\n\n` +
            `Then show them a graph of another player with a few recruits, and another player with an even bigger team.`,
        components: [
            row(button('team', userId))
        ]
    };
}

function teamBuildingMessage(userId) {
    return {
        content:
            `# 3 • HELP THEM BUILD\n\n` +
            `Explain that we can help them build their own team, and they will lead that team.\n\n` +
            `Their first goal is simple: find their **first recruit**.\n\n` +
            `Let them go recruit. When they come back, help them understand the next step.`,
        components: [
            row(button('rankpath', userId))
        ]
    };
}

function rankPathMessage(userId) {
    return {
        content:
            `# 4 • EXPLAIN THE PATH\n\n` +
            `After their first recruit, they need **2 more recruits** to become **Penguin Captain**.\n\n` +
            `After Captain, their next goal is to help one of their own recruits become Captain. That unlocks the option to become a Trainer.\n\n` +
            `After that, they help **2 more recruits** become Captain to reach **Penguin General**.\n\n` +
            `After General, they help **2 recruits** reach General to finally become **Emperor Penguin**.`,
        components: [
            row(button('powers', userId))
        ]
    };
}

function powersMessage(userId) {
    return {
        content:
            `# 5 • TRAINER TOOLS\n\n` +
            `Trainer does **not** replace your Penguin rank.\n\n` +
            `You can be Captain + Trainer, General + Trainer, or Emperor + Trainer.\n\n` +
            `As a Trainer, you can move new recruits into separate voice channels and mute disruptive players who interrupt training.\n\n` +
            `Use that power to keep training clean, not to show off.`,
        components: [
            row(button('finish', userId))
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

function isTrainerFlowMessage(message, userId) {
    if (message.author.id !== message.client.user.id) {
        return false;
    }

    return message.components.some(actionRow => {
        return actionRow.components.some(component => {
            return component.customId?.startsWith(`${BUTTON_PREFIX}:`) &&
                component.customId.includes(`:${userId}`);
        });
    });
}

async function startTrainerOnboardingForMember(member, context = {}) {
    const channel = await ensureTrainerOnboardingChannel(member, context);
    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const alreadyStarted = recentMessages?.some(message => {
        return isTrainerFlowMessage(message, member.id);
    });

    if (alreadyStarted) {
        return channel;
    }

    await channel.send(introMessage(member));
    return channel;
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
    startTrainerOnboardingForMember
};
