const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');

const {
    ensureWelcomeCategory
} = require('./bootstrap.js');

const BUTTON_PREFIX = 'trialmod';

function buttonId(action, userId) {
    return `${BUTTON_PREFIX}:${action}:${userId}`;
}

function button(action, userId, label = 'Next') {
    return new ButtonBuilder()
        .setCustomId(buttonId(action, userId))
        .setLabel(label)
        .setStyle(ButtonStyle.Success);
}

function row(...components) {
    return new ActionRowBuilder().addComponents(...components);
}

function sanitizeChannelName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28) || 'trial-mod';
}

function trialModChannelTopic(userId) {
    return `Penguin Mafia trial mod onboarding:${userId}`;
}

function introMessage(member) {
    return {
        content:
            `# 🛡️ TRIAL MOD TRAINING\n\n` +
            `${member}, read this carefully before using Staff powers.\n\n` +
            `Trial Mod is a proving period. Activity, trust, judgment, and how you respond to feedback all matter.\n\n` +
            `Tap **Next** to begin.`,
        components: [
            row(button('expectations', member.id))
        ]
    };
}

function expectationsMessage(userId) {
    return {
        content:
            `# 1 • ACCEPTANCE NOTES\n\n` +
            `When you are accepted as a Trial Mod, you may be given specific notes such as:\n\n` +
            `• Be more active\n` +
            `• Gain trust within the community\n` +
            `• Stop doing certain behaviors\n` +
            `• Improve how you handle situations\n\n` +
            `Do those things. If you ignore your acceptance notes, you will most likely **not** be chosen as Moderator.`,
        components: [
            row(button('mentor', userId))
        ]
    };
}

function mentorMessage(userId) {
    return {
        content:
            `# 2 • YOU ARE BEING WATCHED\n\n` +
            `You may be assigned to a Moderator who watches over you and helps decide if you are ready.\n\n` +
            `That does **not** mean only that Moderator is watching. Other Staff may also notice how you act, how active you are, and how you handle problems.\n\n` +
            `Act like every decision matters, because it does.`,
        components: [
            row(button('groups', userId))
        ]
    };
}

function groupsMessage(userId) {
    return {
        content:
            `# 3 • TRIAL GROUPS\n\n` +
            `Trial Mods are usually accepted in groups.\n\n` +
            `The Moderator watching you may also be watching 1 or 2 other Trial Mods. Usually only **one** Trial Mod from the group becomes Moderator.\n\n` +
            `If nobody performs well, nobody has to be promoted.`,
        components: [
            row(button('warnings', userId))
        ]
    };
}

function warningsMessage(userId) {
    return {
        content:
            `# 4 • ONE WARNING MAX\n\n` +
            `As a Trial Mod, you get **one warning max**.\n\n` +
            `If you mess up once, you may get warned. If you mess up again, you may lose your chance to become Moderator for this run and return to member.\n\n` +
            `Depending on what happened, you may also be blocked from applying again for a period of time. If you apply before that time is up, you may lose the chance to apply again.`,
        components: [
            row(button('moderation', userId))
        ]
    };
}

function moderationMessage(userId) {
    return {
        content:
            `# 5 • MODERATION GUIDELINES\n\n` +
            `Use judgment. Ask higher Staff when unsure.\n\n` +
            `• Excessive swearing or racial slurs: one warning first. After that, timeout up to **1 hour**.\n` +
            `• Phrases like “kys” or “heil *”: timeout up to **1 day**.\n` +
            `• Racism: one warning, then timeout up to **1 hour**. Use 10 minutes unless extreme.\n` +
            `• Cheating like X-Ray, hacked clients, ESP: **1 day timeout**. If caught again, report to Sr Staff ASAP.\n` +
            `• Scamming: **1 day timeout**. If repeated, report to Sr Staff ASAP.\n` +
            `• Self-promotion of external websites or servers: **1 hour timeout**. This does not include social media or livestreams.\n\n` +
            `Do not over-punish to look powerful. Moderate to protect the community.`,
        components: [
            row(button('finish', userId))
        ]
    };
}

function finalMessage(userId) {
    return {
        content:
            `# ✅ TRIAL MOD TRAINING COMPLETE\n\n` +
            `You have finished the Trial Mod briefing.\n\n` +
            `Use Staff powers carefully, ask questions, and remember: trust is earned in public and lost quickly.\n\n` +
            `Press **Done** to close this room.`,
        components: [
            row(button('done', userId, 'Done'))
        ]
    };
}

async function scheduleTrialModChannelDelete(interaction) {
    const channel = interaction.channel;
    let countdownMessage = null;

    try {
        countdownMessage = await interaction.followUp({
            content: '💣🐧 This Trial Mod training room will self destruct in **10**...',
            fetchReply: true
        });
    } catch (error) {
        console.error(`Failed to start Trial Mod onboarding countdown in ${channel?.id || 'unknown'}:`);
        console.error(error);
    }

    for (let seconds = 9; seconds >= 1; seconds--) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!countdownMessage) continue;

        try {
            await countdownMessage.edit({
                content: `💣🐧 This Trial Mod training room will self destruct in **${seconds}**...`
            });
        } catch {
            countdownMessage = null;
        }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    setTimeout(async () => {
        try {
            if (channel?.deletable) {
                await channel.delete('Penguin Mafia Trial Mod onboarding completed');
            }
        } catch (error) {
            console.error(`Failed to delete Trial Mod onboarding channel ${channel?.id || 'unknown'}:`);
            console.error(error);
        }
    }, 1_000);
}

async function ensureTrialModOnboardingChannel(member, context = {}) {
    const guild = member.guild;
    const channels = context.channelCache || await guild.channels.fetch();
    const topic = trialModChannelTopic(member.id);
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
            name: `🛡️-trial-mod-${sanitizeChannelName(member.user.username)}`,
            type: ChannelType.GuildText,
            parent: category.id,
            topic,
            permissionOverwrites,
            reason: 'Penguin Mafia Trial Mod onboarding'
        });

        if (context.channelCache) {
            context.channelCache.set(channel.id, channel);
        }
    } else {
        await channel.permissionOverwrites.set(
            permissionOverwrites,
            'Penguin Mafia Trial Mod onboarding permissions'
        );
    }

    return channel;
}

function isTrialModFlowMessage(message, userId) {
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

async function startTrialModOnboardingForMember(member, context = {}) {
    const channel = await ensureTrialModOnboardingChannel(member, context);
    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const alreadyStarted = recentMessages?.some(message => {
        return isTrialModFlowMessage(message, member.id);
    });

    if (alreadyStarted) {
        return channel;
    }

    await channel.send(introMessage(member));
    return channel;
}

async function handleTrialModButton(interaction) {
    const parts = interaction.customId.split(':');

    if (parts[0] !== BUTTON_PREFIX) return false;

    const action = parts[1];
    const targetUserId = parts[2];

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '🐧 This Trial Mod training room belongs to another Staff member.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (action === 'expectations') {
        await interaction.update(expectationsMessage(targetUserId));
        return true;
    }

    if (action === 'mentor') {
        await interaction.update(mentorMessage(targetUserId));
        return true;
    }

    if (action === 'groups') {
        await interaction.update(groupsMessage(targetUserId));
        return true;
    }

    if (action === 'warnings') {
        await interaction.update(warningsMessage(targetUserId));
        return true;
    }

    if (action === 'moderation') {
        await interaction.update(moderationMessage(targetUserId));
        return true;
    }

    if (action === 'finish') {
        await interaction.update(finalMessage(targetUserId));
        return true;
    }

    if (action === 'done') {
        await interaction.update({
            content: '# ✅ TRIAL MOD TRAINING COMPLETE\n\nThis room will now self destruct.',
            components: []
        });
        await scheduleTrialModChannelDelete(interaction);
        return true;
    }

    return false;
}

module.exports = {
    handleTrialModButton,
    startTrialModOnboardingForMember
};
