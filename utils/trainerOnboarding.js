const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');

const {
    ensureTrainerRole
} = require('./bootstrap.js');
const {
    postTrainerPromotionEvent
} = require('./events.js');
const {
    scheduleDmOnboardingMessageDelete
} = require('./onboarding.js');

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
            `# 🐧 TRAINER GUIDE\n\n` +
            `Use \`/training\` anytime to bring this guide back.\n\n` +
            `## Before Part 1 • Welcome Them\n\n` +
            `Welcome the new recruit to the server first.\n\n` +
            `Make them feel seen:\n` +
            `👋 Say hi\n` +
            `🐧 Welcome them to the Penguin Mafia\n` +
            `🧊 Let them know you will guide them step by step\n\n` +
            `Do **not** explain the whole rank path yet.`,
        components: [
            row(button('graphs', userId, 'Part 1'))
        ]
    };
}

function graphTrainingMessage(userId) {
    return {
        content:
            `# 📊 Part 1 • Show The Graph\n\n` +
            `Do **not** explain the whole rank path yet.\n\n` +
            `First, teach \`/graph\`:\n` +
            `🐧 Have them use \`/graph\` on themselves\n` +
            `🌱 Show them their starting tree\n` +
            `🌲 Use \`/graph\` on someone with a bigger tree\n\n` +
            `Then explain the first mission:\n\n` +
            `Help the new recruit focus on one mission:\n` +
            `🐧 Get their **first recruit**\n` +
            `🎨 Encourage them to use **any penguin skin** if they want, but it is not required\n` +
            `🔗 That recruit joins with their invite\n\n` +
            `If the bot misses it, have them use:\n` +
            `\`/join recruiter:@YourDiscord\``,
        components: [
            row(button('team', userId, 'Part 2'))
        ]
    };
}

function teamBuildingMessage(userId) {
    return {
        content:
            `# 🎩 Part 2 • Captain Goal\n\n` +
            `Only teach this after they get their first recruit.\n\n` +
            `Help the recruit:\n` +
            `🐧 Recruit **2 more penguins**\n` +
            `📊 Reach **3 direct recruits total**\n` +
            `🎩 Become **Penguin Captain**\n\n` +
            `Keep it simple. One iceberg at a time.`,
        components: [
            row(button('rankpath', userId, 'Part 3'))
        ]
    };
}

function rankPathMessage(userId) {
    return {
        content:
            `# 🎓 Part 3 • Train A Captain\n\n` +
            `Only teach this after they become Captain.\n\n` +
            `Now help them learn leadership:\n` +
            `🐧 Keep recruiting\n` +
            `🎩 Help **1 of their recruits** become Captain\n` +
            `🎓 This is when Penguin Trainer can be offered\n\n` +
            `Remind them: Trainer is a side role. It does not replace Penguin rank.`,
        components: [
            row(button('powers', userId, 'Part 4'))
        ]
    };
}

function powersMessage(userId) {
    return {
        content:
            `# ⭐ Part 4 • General Goal\n\n` +
            `Only teach this after they have trained 1 Captain.\n\n` +
            `Help them build more leaders:\n` +
            `🎩 Help **2 more recruits** become Captains\n` +
            `📊 Reach **3 direct Captains total**\n` +
            `⭐ Become **Penguin General**`,
        components: [
            row(button('finish', userId, 'Part 5'))
        ]
    };
}

function finalPathMessage(userId) {
    return {
        content:
            `# 👑 Part 5 • Emperor Goal\n\n` +
            `Only teach this after they become General.\n\n` +
            `Final coaching goal:\n` +
            `⭐ Help **2 of their recruits** become Generals\n` +
            `👑 They become **Emperor Penguin**\n\n` +
            `Train slowly. Reveal the next goal only after they finish the current one.`,
        components: [
            row(button('complete', userId, 'Finish'))
        ]
    };
}

function finalMessage(userId) {
    return {
        content:
            `# ✅ TRAINER TRAINING COMPLETE\n\n` +
            `You are ready to guide recruits one step at a time.\n\n` +
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
    const channel = await member.createDM();
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
    const channel = await member.createDM();

    await channel.send(welcomeRecruitsMessage(member.id));
    return channel;
}

async function resolveTrainerMember(interaction, targetUserId) {
    if (interaction.guild) {
        return interaction.guild.members.fetch(targetUserId);
    }

    for (const [, guild] of interaction.client.guilds.cache) {
        const member = await guild.members.fetch(targetUserId).catch(() => null);
        if (member) return member;
    }

    throw new Error('Could not find this Trainer in a shared Penguin Mafia server.');
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
            content: '# ❌ TRAINER POSITION REJECTED\n\nNo Trainer role was added. This message will now self destruct.',
            components: []
        });
        if (interaction.channel?.isDMBased?.()) {
            await scheduleDmOnboardingMessageDelete(interaction, 10);
        } else {
            await scheduleTrainerChannelDelete(interaction, 'Penguin Mafia Trainer onboarding rejected');
        }
        return true;
    }

    if (action === 'accept') {
        const member = await resolveTrainerMember(interaction, targetUserId);
        const { trainerRole } = await ensureTrainerRole(member.guild);
        const wasAlreadyTrainer = member.roles.cache.has(trainerRole.id);

        if (!wasAlreadyTrainer) {
            await member.roles.add(trainerRole, 'Penguin Mafia Trainer accepted onboarding');

            await postTrainerPromotionEvent(member.guild, {
                playerId: targetUserId
            }).catch(error => {
                console.error('Promotion event channel post failed after Trainer acceptance:');
                console.error(error);
                return false;
            });
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
        await interaction.update(finalPathMessage(targetUserId));
        return true;
    }

    if (action === 'complete') {
        await interaction.update(finalMessage(targetUserId));
        return true;
    }

    if (action === 'done') {
        await interaction.update({
            content: '# ✅ TRAINER TRAINING COMPLETE\n\nThis training message will now self destruct.',
            components: []
        });
        if (interaction.channel?.isDMBased?.()) {
            await scheduleDmOnboardingMessageDelete(interaction, 10);
        } else {
            await scheduleTrainerChannelDelete(interaction);
        }
        return true;
    }

    return false;
}

module.exports = {
    handleTrainerButton,
    startTrainerOnboardingForMember,
    startTrainerTrainingForMember
};
