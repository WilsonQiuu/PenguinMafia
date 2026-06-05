const {
    ChannelType,
    EmbedBuilder
} = require('discord.js');

const {
    MOD_LOG_CHANNEL_NAME
} = require('./bootstrap.js');

function truncateValue(value, maxLength = 900) {
    const text = String(value ?? 'Unknown').replace(/`/g, "'");

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
}

function formatUser(userOrMember) {
    if (!userOrMember) {
        return 'Unknown';
    }

    const user = userOrMember.user || userOrMember;
    const label = user.tag || user.username || user.globalName || 'Unknown User';

    return `${label} (${user.id})`;
}

function getUserId(userOrMember) {
    if (!userOrMember) {
        return null;
    }

    const user = userOrMember.user || userOrMember;

    return user.id || null;
}

function getUserAvatarUrl(userOrMember) {
    if (!userOrMember) {
        return null;
    }

    const user = userOrMember.user || userOrMember;

    if (typeof user.displayAvatarURL === 'function') {
        return user.displayAvatarURL({
            size: 128
        });
    }

    return null;
}

function formatChannel(channelOrId) {
    if (!channelOrId) {
        return 'None';
    }

    if (typeof channelOrId === 'string') {
        return `#${channelOrId}`;
    }

    return `#${channelOrId.name || channelOrId.id} (${channelOrId.id})`;
}

function getLogColor(title) {
    const normalizedTitle = String(title || '').toLowerCase();

    if (normalizedTitle.includes('failed')) {
        return 0xE74C3C;
    }

    if (normalizedTitle.includes('cancelled')) {
        return 0x95A5A6;
    }

    if (normalizedTitle.includes('ban')) {
        return 0xC0392B;
    }

    if (normalizedTitle.includes('kick')) {
        return 0xE67E22;
    }

    if (normalizedTitle.includes('timeout') || normalizedTitle.includes('mute')) {
        return 0x9B59B6;
    }

    if (normalizedTitle.includes('message')) {
        return 0x3498DB;
    }

    if (normalizedTitle.includes('voice')) {
        return 0x1ABC9C;
    }

    return 0x5865F2;
}

function findField(fields, names) {
    return fields.find(field => {
        return names.includes(String(field.name || '').toLowerCase());
    });
}

function isExecutorField(field) {
    return ['actor', 'executor', 'deleted by'].includes(String(field?.name || '').toLowerCase());
}

function stripDiscordId(value) {
    return String(value ?? 'Unknown')
        .replace(/\s+\(\d{15,25}\)/g, '')
        .replace(/\s+`\d{15,25}`/g, '');
}

function extractUserIdFromValue(value) {
    const text = String(value || '');
    const mentionMatch = text.match(/<@!?(\d+)>/);

    if (mentionMatch) {
        return mentionMatch[1];
    }

    const parenthesizedIdMatch = text.match(/\((\d{15,25})\)/);

    if (parenthesizedIdMatch) {
        return parenthesizedIdMatch[1];
    }

    const rawIdMatch = text.match(/\b\d{15,25}\b/);

    return rawIdMatch ? rawIdMatch[0] : null;
}

async function resolveThumbnailUrl(guild, fields) {
    const targetField = findField(fields, ['player', 'target', 'author']);
    const userId = extractUserIdFromValue(targetField?.value);

    if (!userId) {
        return null;
    }

    const cachedMember = guild.members.cache.get(userId);
    const cachedUser = guild.client.users.cache.get(userId);

    if (cachedMember || cachedUser) {
        return getUserAvatarUrl(cachedMember || cachedUser);
    }

    try {
        const user = await guild.client.users.fetch(userId);

        return getUserAvatarUrl(user);
    } catch {
        return null;
    }
}

function buildDescription(fields) {
    const fieldLines = [];
    const skippedNames = new Set(['command']);

    for (const field of fields) {
        if (!field || field.value === undefined || field.value === null || field.value === '') {
            continue;
        }

        const name = String(field.name || '').toLowerCase();

        if (skippedNames.has(name)) {
            continue;
        }

        const value = isExecutorField(field)
            ? stripDiscordId(field.value)
            : field.value;

        fieldLines.push(`**${truncateValue(field.name, 80)}:** ${truncateValue(value, 350)}`);
    }

    return truncateValue(fieldLines.join('\n') || 'No additional details provided.', 3900);
}

function formatTimestamp(date = Date.now()) {
    const timestamp = date instanceof Date ? date.getTime() : date;

    return `<t:${Math.floor(timestamp / 1000)}:F>`;
}

async function findModLogChannel(guild) {
    const cachedChannel = guild.channels.cache.find(channel => {
        return channel.name === MOD_LOG_CHANNEL_NAME &&
            channel.type === ChannelType.GuildText;
    });

    if (cachedChannel) {
        return cachedChannel;
    }

    const channels = await guild.channels.fetch();

    return channels.find(channel => {
        return channel?.name === MOD_LOG_CHANNEL_NAME &&
            channel.type === ChannelType.GuildText;
    }) || null;
}

async function postModLog(guild, title, fields = []) {
    if (!guild) {
        return false;
    }

    const channel = await findModLogChannel(guild);

    if (!channel) {
        console.warn(`Mod log channel "${MOD_LOG_CHANNEL_NAME}" not found in ${guild.name}.`);
        return false;
    }

    const commandField = findField(fields, ['command']);
    const actorField = findField(fields, ['actor', 'executor', 'deleted by']);
    const thumbnailUrl = await resolveThumbnailUrl(guild, fields);
    const embedTitle = commandField ? `${title} ${commandField.value}` : title;
    const footerText = actorField
        ? `${actorField.name}: ${truncateValue(stripDiscordId(actorField.value), 120)}`
        : `Server: ${guild.name}`;
    const embed = new EmbedBuilder()
        .setColor(getLogColor(title))
        .setTitle(truncateValue(embedTitle, 250))
        .setDescription(buildDescription(fields))
        .setTimestamp(new Date())
        .setFooter({
            text: truncateValue(footerText, 200)
        });

    if (thumbnailUrl) {
        embed.setThumbnail(thumbnailUrl);
    }

    await channel.send({
        embeds: [embed],
        allowedMentions: {
            parse: []
        }
    });

    return true;
}

module.exports = {
    formatChannel,
    formatTimestamp,
    formatUser,
    getUserAvatarUrl,
    getUserId,
    postModLog,
    truncateValue
};
