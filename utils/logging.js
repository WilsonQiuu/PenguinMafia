function formatUser(user) {
    if (!user) {
        return 'Unknown user';
    }

    return `${user.tag || user.username || 'Unknown user'} (${user.id})`;
}

function formatGuild(guild) {
    if (!guild) {
        return 'DM/unknown guild';
    }

    return `${guild.name || 'Unknown guild'} (${guild.id})`;
}

function logCommandError(interaction, commandName, error) {
    const reason = error?.message || String(error);

    console.error(
        `[${new Date().toISOString()}] ${commandName} failed. ` +
        `Attempted by: ${formatUser(interaction?.user)}. ` +
        `Guild: ${formatGuild(interaction?.guild)}. ` +
        `Reason: ${reason}`
    );
    console.error(error);
}

module.exports = {
    logCommandError
};
