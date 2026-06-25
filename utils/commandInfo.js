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
    ensureGettingPromotedInfoBoard
};
