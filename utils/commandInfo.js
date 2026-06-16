const RECRUIT_COMMANDS_CHANNEL_ID = process.env.RECRUIT_COMMANDS_CHANNEL_ID || '1513422017528070184';
const GETTING_PROMOTED_CHANNEL_ID = process.env.GETTING_PROMOTED_CHANNEL_ID || '1512488370591371325';

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

function renderGettingPromotedInfoMessage() {
    return {
        content:
            `# 🐧🎖️ GETTING PROMOTED\n\n` +
            `Recruiting is how penguins climb. Build your direct recruit tree, help your recruits rank up, and use \`/eligible\` when you want to check the next step.\n\n` +
            `## 🧊 Penguin Soldier\n` +
            `Starting rank. Fresh on the ice.\n\n` +
            `## 🎩 Penguin Captain\n` +
            `Requires **3 direct recruits** at **Penguin Soldier or higher**.\n\n` +
            `## ⭐ Penguin General\n` +
            `Requires **3 direct recruits** at **Penguin Captain or higher**.\n\n` +
            `## 👑 Emperor Penguin\n` +
            `Requires **2 direct recruits** at **Penguin General or higher**.\n\n` +
            `Use \`/eligible player:@Player rank:Rank\` to check promotion eligibility.`
    };
}

async function upsertInfoBoard(guild, channelId, label, marker, payload) {
    const channel = await getChannelById(guild, channelId, label);

    if (!channel) {
        return false;
    }

    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const existingMessage = recentMessages?.find(message => {
        return message.author.id === guild.client.user.id &&
            message.content.includes(marker);
    });

    if (existingMessage) {
        await existingMessage.edit(payload);
    } else {
        await channel.send(payload);
    }

    return true;
}

async function ensureRecruitCommandInfoBoard(guild) {
    return upsertInfoBoard(
        guild,
        RECRUIT_COMMANDS_CHANNEL_ID,
        'recruit commands',
        'RECRUIT TREE COMMANDS',
        renderRecruitCommandInfoMessage()
    );
}

async function ensureGettingPromotedInfoBoard(guild) {
    return upsertInfoBoard(
        guild,
        GETTING_PROMOTED_CHANNEL_ID,
        'getting promoted',
        'GETTING PROMOTED',
        renderGettingPromotedInfoMessage()
    );
}

module.exports = {
    GETTING_PROMOTED_CHANNEL_ID,
    RECRUIT_COMMANDS_CHANNEL_ID,
    ensureGettingPromotedInfoBoard,
    ensureRecruitCommandInfoBoard
};
