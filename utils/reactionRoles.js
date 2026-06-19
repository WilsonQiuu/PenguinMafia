const REACTION_ROLES_CHANNEL_ID =
    process.env.REACTION_ROLES_CHANNEL_ID || '1517425846510686288';
const GIVEAWAY_PING_ROLE_ID =
    process.env.GIVEAWAY_PING_ROLE_ID || '1502669868393169046';
const REACTION_ROLES_MARKER = 'PENGUIN MAFIA PING ROLES';

const REACTION_ROLES = new Map([
    ['🎉', {
        label: 'Giveaway Ping',
        roleId: GIVEAWAY_PING_ROLE_ID,
        description: 'Get notified when a new giveaway starts.'
    }],
    ['📢', {
        label: 'Announcement Ping',
        roleId: process.env.ANNOUNCEMENT_PING_ROLE_ID || '1502665620322259015',
        description: 'Get notified about important community announcements.'
    }],
    ['🔴', {
        label: 'Live Ping',
        roleId: process.env.LIVE_PING_ROLE_ID || '1502666129905025025',
        description: 'Get notified when a stream goes live.'
    }],
    ['📹', {
        label: 'Upload Ping',
        roleId: process.env.UPLOAD_PING_ROLE_ID || '1502670122488430692',
        description: 'Get notified when a new upload is posted.'
    }]
]);

function reactionRolesMessage() {
    const roleLines = [...REACTION_ROLES.entries()]
        .map(([emoji, role]) => {
            return `${emoji} <@&${role.roleId}> — ${role.description}`;
        })
        .join('\n\n');

    return {
        content:
            `# 🔔 ${REACTION_ROLES_MARKER}\n\n` +
            `React below to choose which notifications you want.\n` +
            `Remove your reaction at any time to remove the role.\n\n` +
            `${roleLines}`,
        allowedMentions: {
            parse: []
        }
    };
}

async function getReactionRolesChannel(guild) {
    const channel = guild.channels.cache.get(REACTION_ROLES_CHANNEL_ID) ||
        (await guild.channels.fetch(REACTION_ROLES_CHANNEL_ID).catch(() => null));

    if (!channel?.isTextBased()) {
        console.warn(`Reaction roles channel was not found by ID ${REACTION_ROLES_CHANNEL_ID}.`);
        return null;
    }

    return channel;
}

async function ensureReactionRolesMessage(guild) {
    const channel = await getReactionRolesChannel(guild);

    if (!channel) {
        return null;
    }

    const recentMessages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    let message = recentMessages?.find(existingMessage => {
        return existingMessage.author.id === guild.client.user.id &&
            existingMessage.content.includes(REACTION_ROLES_MARKER);
    }) || null;
    const payload = reactionRolesMessage();

    if (message) {
        await message.edit(payload);
    } else {
        message = await channel.send(payload);
    }

    for (const emoji of REACTION_ROLES.keys()) {
        const existingReaction = message.reactions.cache.find(reaction => {
            return reaction.emoji.name === emoji;
        });

        if (!existingReaction?.me) {
            await message.react(emoji);
        }
    }

    return message;
}

async function isManagedReactionRoleMessage(reaction) {
    if (reaction.partial) {
        await reaction.fetch();
    }

    const message = reaction.message;

    if (message.partial) {
        await message.fetch();
    }

    return message.channelId === REACTION_ROLES_CHANNEL_ID &&
        message.author?.id === message.client.user.id &&
        message.content.includes(REACTION_ROLES_MARKER);
}

async function handleReactionRole(reaction, user, shouldAdd) {
    if (user.bot || !(await isManagedReactionRoleMessage(reaction))) {
        return false;
    }

    const roleConfig = REACTION_ROLES.get(reaction.emoji.name);

    if (!roleConfig) {
        return false;
    }

    if (user.partial) {
        await user.fetch();
    }

    const guild = reaction.message.guild;
    const member = guild.members.cache.get(user.id) ||
        (await guild.members.fetch(user.id).catch(() => null));
    const role = guild.roles.cache.get(roleConfig.roleId) ||
        (await guild.roles.fetch(roleConfig.roleId).catch(() => null));

    if (!member) {
        console.warn(`Could not find member ${user.id} for reaction role ${roleConfig.label}.`);
        return true;
    }

    if (!role) {
        console.warn(`Could not find reaction role ${roleConfig.label} by ID ${roleConfig.roleId}.`);
        return true;
    }

    if (shouldAdd && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Selected ${roleConfig.label} reaction role`);
    } else if (!shouldAdd && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, `Removed ${roleConfig.label} reaction role`);
    }

    return true;
}

module.exports = {
    GIVEAWAY_PING_ROLE_ID,
    REACTION_ROLES,
    REACTION_ROLES_CHANNEL_ID,
    ensureReactionRolesMessage,
    handleReactionRole
};
