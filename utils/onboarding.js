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

const sql = require('../db.js');
const {
    DEFAULT_RANK_NAME,
    ensureRankRoles,
    ensureWelcomeCategory,
    syncMemberRankRole
} = require('./bootstrap.js');
const {
    setMemberNicknameToIgn
} = require('./nicknames.js');

const BUTTON_PREFIX = 'welcome';
const MODAL_PREFIX = 'welcome_ign_submit';

function buttonId(action, userId, isTest = false) {
    return `${BUTTON_PREFIX}:${action}:${userId}:${isTest ? 'test' : 'live'}`;
}

function ignModalId(userId, edition, isTest = false) {
    return `${MODAL_PREFIX}:${userId}:${edition}:${isTest ? 'test' : 'live'}`;
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

async function updateWithReadingDelay(interaction, message) {
    await interaction.update(message);
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
    const isTest = Boolean(context.isTest);
    const parentLine = context.inviterDisplayName
        ? `Our bots detected ${context.recruiterId ? `<@${context.recruiterId}>` : `**${context.inviterDisplayName}**`} as your recruiter. They can see this room and help if you get stuck.`
        : `Our bots could not safely detect your recruiter, so you are an orphaned penguin for now. You can fix that later with \`/join recruiter:@YourRecruiter\`.`;
    const testLine = isTest
        ? `\n\n🧪 **Test mode:** finishing this will not change your DB welcome status, save your IGN, or give you the ${DEFAULT_RANK_NAME} role.`
        : '';

    return {
        content:
            `# 🐧 WELCOME, ${member}! 🎉\n\n` +
            `## PENGUIN MAFIA\n` +
            `👑 Loyal to the Don\n` +
            `🧊 Loyal to the ice\n` +
            `🐧 Loyal to the colony\n\n` +
            `${parentLine}\n\n` +
            `Tap below to start training.` +
            testLine,
        allowedMentions: {
            users: [member.id, context.recruiterId].filter(Boolean)
        },
        components: [
            row(scopedButton('start', member.id, 'Next', ButtonStyle.Success, isTest))
        ]
    };
}

function rankIntroMessage(userId, isTest = false) {
    return {
        content:
            `# 🎖️ YOUR FIRST RANK\n\n` +
            `## 🧊 Penguin Soldier\n` +
            `Fresh on the ice. Official Mafia penguin. 🐧\n\n` +
            `Ranks mean:\n` +
            `💰 Better commissions\n` +
            `👑 More respect\n` +
            `🐧 More recruit power\n\n` +
            `Recruiting is how you climb. Build your colony. 🌲`,
        components: [
            row(scopedButton('ranks', userId, 'Next', ButtonStyle.Success, isTest))
        ]
    };
}

function ranksMessage(userId, isTest = false) {
    return {
        content:
            `# 🐧 RANK LADDER\n\n` +
            `🧊 **Soldier**\n` +
            `Start here. Join the colony.\n\n` +
            `🎩 **Captain**\n` +
            `Need **3 direct recruits**.\n\n` +
            `⭐ **General**\n` +
            `Need **3 direct Captains+**.\n\n` +
            `👑 **Emperor Penguin**\n` +
            `Need **2 Generals+** and **1 Captain+**.\n\n` +
            `## 🐧 Recruit = Rank Up`,
        components: [
            row(scopedButton('recruit', userId, 'Next', ButtonStyle.Success, isTest))
        ]
    };
}

function recruitingMessage(userId, isTest = false) {
    return {
        content:
            `# 📣 RECRUITING\n\n` +
            `## 🍩 Find players on DonutSMP\n\n` +
            `Rule #1: **Penguins only.** 🐧✅\n\n` +
            `1. They put on **any penguin skin**\n` +
            `2. Send your invite link\n` +
            `3. Bot detects your recruit 🤖\n\n` +
            `If detection fails:\n` +
            `\`/join recruiter:@YourDiscord\`\n\n` +
            `Need this later? Use \`/recruit\`.`,
        components: [
            row(scopedButton('ign', userId, 'Next', ButtonStyle.Success, isTest))
        ]
    };
}

function ignMessage(userId, isTest = false) {
    return {
        content:
            `# 💰 LINK YOUR IGN\n\n` +
            `Your Minecraft IGN is **not necessary** to finish welcome.\n\n` +
            `Linking it helps the Don know who gets paid during events. 🐧💸\n\n` +
            `🔎 No IGN = unpaid commissions saved\n` +
            `✅ Linked IGN = easier payouts\n\n` +
            `Choose your Minecraft edition first:`,
        components: [
            row(
                scopedButton('enter_ign_java', userId, 'Java', ButtonStyle.Success, isTest),
                scopedButton('enter_ign_bedrock', userId, 'Bedrock', ButtonStyle.Success, isTest),
                scopedButton('skip_ign', userId, 'Skip', ButtonStyle.Secondary, isTest)
            )
        ]
    };
}

function finalMessage(userId, linkedIgn = null, edition = null, isTest = false) {
    const linkedLine = linkedIgn
        ? `✅ IGN linked: **${linkedIgn}**${edition ? ` (${minecraftEditionLabel(edition)})` : ''}`
        : `⏭️ IGN skipped. Use \`/link\` before events.`;
    const roleLine = isTest
        ? `🧪 Test mode: no role, IGN, or DB changes.`
        : `🎖️ Role ready: **${DEFAULT_RANK_NAME}**`;

    return {
        content:
            `# 🐧 WELCOME TO THE\n# PENGUIN MAFIA 🎉\n\n` +
            `👑 The Don approves.\n` +
            `🧊 The ice gates open.\n` +
            `🐧 The colony awaits.\n\n` +
            `${linkedLine}\n\n` +
            `${roleLine}\n\n` +
            `Press **Done** to enter. The training room will self destruct. 💣`,
        components: [
            row(scopedButton('done', userId, 'Done', ButtonStyle.Success, isTest))
        ]
    };
}

async function scheduleWelcomeChannelDelete(interaction) {
    const channel = interaction.channel;

    let countdownMessage = null;

    try {
        countdownMessage = await interaction.followUp({
            content: '💣🐧 This secret penguin training room will self destruct in **10**...',
            fetchReply: true
        });
    } catch (error) {
        console.error(`Failed to start welcome channel countdown in ${channel?.id || 'unknown'}:`);
        console.error(error);
    }

    for (let seconds = 9; seconds >= 1; seconds--) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!countdownMessage) continue;

        try {
            await countdownMessage.edit({
                content: `💣🐧 This secret penguin training room will self destruct in **${seconds}**...`
            });
        } catch {
            countdownMessage = null;
        }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    setTimeout(async () => {
        try {
            if (channel?.deletable) {
                await channel.delete('Penguin Mafia welcome flow completed');
            }
        } catch (error) {
            console.error(`Failed to delete welcome channel ${channel?.id || 'unknown'}:`);
            console.error(error);
        }
    }, 1_000);
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

    if (process.env.DON_DISCORD_ID) {
        addMemberOverwrite(process.env.DON_DISCORD_ID, [
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

async function sendOneTimeWelcomeReminder(member, channel) {
    const rows = await sql`
        select welcome_completed, welcome_reminder_sent_at
        from players
        where discord_id = ${member.id}
        limit 1
    `;
    const player = rows[0];

    if (!player || player.welcome_completed || player.welcome_reminder_sent_at) {
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

        await sql`
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
    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const alreadyStarted = recentMessages?.some(message => {
        return isWelcomeFlowMessage(message, member.id);
    });

    if (!isTest) {
        await sendOneTimeWelcomeReminder(member, channel);
    }

    if (alreadyStarted && !isTest) {
        return channel;
    }

    await channel.send(introMessage(member, context));
    return channel;
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

async function completeOnboarding(member, linkedIgn = null, minecraftEdition = null) {
    await sql`
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
        await setMemberNicknameToIgn(member, linkedIgn);
    }
}

async function saveOnboardingIgn(member, linkedIgn, minecraftEdition) {
    await sql`
        update players
        set
            minecraft_ign = ${linkedIgn},
            minecraft_edition = ${minecraftEdition},
            updated_at = now()
        where discord_id = ${member.id}
    `;

    return setMemberNicknameToIgn(member, linkedIgn);
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

    if (action === 'start') {
        await updateWithReadingDelay(interaction, rankIntroMessage(targetUserId, isTest));
        return true;
    }

    if (action === 'ranks') {
        await updateWithReadingDelay(interaction, ranksMessage(targetUserId, isTest));
        return true;
    }

    if (action === 'recruit') {
        await updateWithReadingDelay(interaction, recruitingMessage(targetUserId, isTest));
        return true;
    }

    if (action === 'ign') {
        await updateWithReadingDelay(interaction, ignMessage(targetUserId, isTest));
        return true;
    }

    if (action === 'enter_ign_java' || action === 'enter_ign_bedrock') {
        const minecraftEdition = action === 'enter_ign_bedrock' ? 'bedrock' : 'java';
        const modal = new ModalBuilder()
            .setCustomId(ignModalId(targetUserId, minecraftEdition, isTest))
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

        await interaction.showModal(modal);
        return true;
    }

    if (action === 'skip_ign') {
        await interaction.update(finalMessage(targetUserId, null, null, isTest));
        return true;
    }

    if (action === 'done') {
        const member = await interaction.guild.members.fetch(targetUserId);
        if (!isTest) {
            await completeOnboarding(member);
        }

        await interaction.update({
            content:
                `# 🐧 WELCOME TO THE PENGUIN MAFIA\n\n` +
                `Training complete. Your **${DEFAULT_RANK_NAME}** role is active. Enter the iceberg. 🧊✨`,
            components: []
        });
        await scheduleWelcomeChannelDelete(interaction);
        return true;
    }

    return false;
}

async function handleWelcomeModal(interaction) {
    if (!interaction.customId.startsWith(`${MODAL_PREFIX}:`)) return false;

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
    const validIgn = /^[A-Za-z0-9_]{3,16}$/.test(minecraftIgn);

    if (!validIgn) {
        await interaction.reply({
            content:
                `❌ Invalid Minecraft IGN.\n\n` +
                `Minecraft usernames must be 3-16 characters and can only use letters, numbers, and underscores.`,
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const member = await interaction.guild.members.fetch(targetUserId);
    if (!isTest) {
        const nicknameUpdated = await saveOnboardingIgn(member, minecraftIgn, minecraftEdition);
        console.log(`Welcome IGN link for ${member.user.tag}: ${minecraftIgn}${minecraftEdition ? ` (${minecraftEditionLabel(minecraftEdition)})` : ''}. Nickname updated=${nicknameUpdated ? 'yes' : 'no'}.`);
    }

    if (interaction.isFromMessage?.()) {
        await interaction.update(finalMessage(targetUserId, minecraftIgn, minecraftEdition, isTest));
    } else {
        await interaction.reply(finalMessage(targetUserId, minecraftIgn, minecraftEdition, isTest));
    }

    return true;
}

module.exports = {
    cleanupWelcomeChannelsForMissingMembers,
    recruitingMessage,
    startOnboardingForMember,
    handleWelcomeButton,
    handleWelcomeModal
};
