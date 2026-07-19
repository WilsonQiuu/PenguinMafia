const {
    ChannelType,
    EmbedBuilder,
    OverwriteType,
    PermissionFlagsBits
} = require('discord.js');
const {
    donDiscordIds
} = require('./staff.js');

const BOT_LOG_CHANNEL_NAME = '🤖-bot-logs';
const verifiedChannels = new Map();

function botLogChannelId() {
    return process.env.BOT_LOG_CHANNEL_ID?.trim() || null;
}

function botLogPermissions(guild) {
    const donIds = donDiscordIds();

    if (donIds.length === 0) {
        throw new Error('DON_DISCORD_ID is required to create the private bot log channel.');
    }

    return [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel
            ]
        },
        {
            id: guild.client.user.id,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages
            ]
        },
        ...donIds.map(donDiscordId => ({
            id: donDiscordId,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages
            ]
        }))
    ];
}

async function findBotLogChannel(guild) {
    const configuredId = botLogChannelId();
    const cachedById = configuredId ? guild.channels.cache.get(configuredId) : null;

    if (cachedById?.type === ChannelType.GuildText) {
        return cachedById;
    }

    const cachedByName = guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildText && channel.name === BOT_LOG_CHANNEL_NAME
    );

    if (cachedByName) {
        return cachedByName;
    }

    const channels = await guild.channels.fetch();
    const byId = configuredId ? channels.get(configuredId) : null;

    if (byId?.type === ChannelType.GuildText) {
        return byId;
    }

    return channels.find(channel =>
        channel.type === ChannelType.GuildText && channel.name === BOT_LOG_CHANNEL_NAME
    ) || null;
}

async function ensureMinecraftBotLogChannel(guild) {
    const verifiedChannelId = verifiedChannels.get(guild.id);
    const verifiedChannel = verifiedChannelId
        ? guild.channels.cache.get(verifiedChannelId)
        : null;

    if (verifiedChannel?.type === ChannelType.GuildText) {
        return verifiedChannel;
    }

    const permissionOverwrites = botLogPermissions(guild);
    let channel = await findBotLogChannel(guild);

    if (!channel) {
        channel = await guild.channels.create({
            name: BOT_LOG_CHANNEL_NAME,
            type: ChannelType.GuildText,
            permissionOverwrites,
            reason: 'Penguin Mafia private Minecraft bot log setup'
        });
    } else {
        await channel.permissionOverwrites.set(
            permissionOverwrites,
            'Enforce Don-only Minecraft bot log permissions'
        );
    }

    verifiedChannels.set(guild.id, channel.id);
    return channel;
}

function eventColor(level) {
    if (level === 'error') return 0xE74C3C;
    if (level === 'warning') return 0xF1C40F;
    if (level === 'success') return 0x2ECC71;
    return 0x3498DB;
}

function cleanValue(value, maxLength = 1000) {
    const text = String(value ?? 'Unknown').replace(/`/g, "'");
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

async function postMinecraftBotLog(guild, event) {
    if (!guild || !event) {
        return false;
    }

    const channel = await ensureMinecraftBotLogChannel(guild);
    const fields = Object.entries(event.details || {})
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .slice(0, 20)
        .map(([name, value]) => ({
            name: cleanValue(name, 250),
            value: cleanValue(value),
            inline: false
        }));
    const embed = new EmbedBuilder()
        .setColor(eventColor(event.level))
        .setTitle(cleanValue(event.title || 'Minecraft Bot Log', 250))
        .setDescription(cleanValue(event.message || 'No additional details.', 4000))
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date())
        .setFooter({
            text: 'Penguin Mafia Minecraft Bot'
        });

    if (fields.length > 0) {
        embed.addFields(fields);
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
    BOT_LOG_CHANNEL_NAME,
    botLogPermissions,
    ensureMinecraftBotLogChannel,
    findBotLogChannel,
    postMinecraftBotLog
};
