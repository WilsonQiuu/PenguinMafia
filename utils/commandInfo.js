const RECRUIT_COMMANDS_CHANNEL_ID = process.env.RECRUIT_COMMANDS_CHANNEL_ID || '1513422017528070184';

async function getChannelById(guild, channelId, label) {
    const channel = guild.channels.cache.get(channelId) ||
        (await guild.channels.fetch(channelId).catch(() => null));

    if (!channel) {
        console.warn(`Command info ${label} channel was not found by ID ${channelId}.`);
        return null;
    }

    return channel;
}

function renderRecruitCommandInfoMessage() {
    return {
        content:
            `# 🐧🌲 RECRUIT TREE COMMANDS\n\n` +
            `Keep your colony organized, inspect your branches, and move recruits when the hierarchy needs a clean shuffle.\n\n` +
            `## 🌲 \`/tree\`\n` +
            `Shows a text version of a player's recruit tree.\n` +
            `Use it when you want a fast, easy-to-read list of who is under who.\n\n` +
            `**Example:** \`/tree player:@Player\`\n\n` +
            `## 🧊 \`/graph\`\n` +
            `Creates a visual Penguin Mafia recruit graph image.\n` +
            `Use it when you want the cool penguin-themed map of a player's hierarchy.\n\n` +
            `**Example:** \`/graph player:@Player\`\n\n` +
            `## 🔁 \`/give recruiter:@Player recruit:@Player\`\n` +
            `Moves one of your **direct recruits** to another recruiter/hierarchy.\n\n` +
            `When you give a recruit, their entire recruit tree moves with them.\n` +
            `The new recruiter must be the same rank or higher than the recruit being moved.\n\n` +
            `**Example:** \`/give recruiter:@NewRecruiter recruit:@YourRecruit\`\n\n` +
            `Use this carefully. Moving one penguin can move a whole iceberg branch. 🐧`
    };
}

async function ensureRecruitCommandInfoBoard(guild) {
    const channel = await getChannelById(guild, RECRUIT_COMMANDS_CHANNEL_ID, 'recruit commands');

    if (!channel) {
        return false;
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const existingMessage = recentMessages?.find(message => {
        return message.author.id === guild.client.user.id &&
            message.content.includes('RECRUIT TREE COMMANDS');
    });
    const payload = renderRecruitCommandInfoMessage();

    if (existingMessage) {
        await existingMessage.edit(payload);
    } else {
        await channel.send(payload);
    }

    return true;
}

module.exports = {
    RECRUIT_COMMANDS_CHANNEL_ID,
    ensureRecruitCommandInfoBoard
};
