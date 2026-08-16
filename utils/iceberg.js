const sql = require('../db.js');
const {
    ICEBERG_CHANNEL_ID,
    ICEBERG_MEMBERS_CHANNEL_ID,
    ICEBERG_ROLE_ID
} = require('./bootstrap.js');

const ICEBERG_VOUCHES_REQUIRED = 3;
const ICEBERG_PLOT_LIMIT = 2;

async function getIcebergRole(guild) {
    return guild.roles.cache.get(ICEBERG_ROLE_ID) ||
        await guild.roles.fetch(ICEBERG_ROLE_ID).catch(() => null);
}

function isIcebergEligibleProfile(profile) {
    return Boolean(
        profile && (
            Number(profile.vouches || 0) >= ICEBERG_VOUCHES_REQUIRED ||
            profile.staff_rank_name === 'Admin'
        )
    );
}

async function getIcebergEligibility(discordId, db = sql) {
    const rows = await db`
        select discord_id, vouches, staff_rank_name
        from players
        where discord_id = ${discordId}
            and status = 'active'
            and welcome_completed = true
        limit 1
    `;

    return {
        profile: rows[0] || null,
        eligible: isIcebergEligibleProfile(rows[0])
    };
}

async function syncIcebergMember(guild, member, db = sql) {
    const role = await getIcebergRole(guild);
    const { eligible } = await getIcebergEligibility(member.id, db);
    const hasRole = Boolean(role && member.roles.cache.has(role.id));

    if (role?.editable && eligible && !hasRole) {
        await member.roles.add(role, 'Automatically eligible for Iceberg (3+ vouches or Admin)');
    } else if (role?.editable && !eligible && hasRole) {
        await member.roles.remove(role, 'No longer eligible for Iceberg');
    }

    if (eligible) {
        await db`
            insert into iceberg_members (discord_id)
            values (${member.id})
            on conflict (discord_id) do nothing
        `;
    } else {
        await db`delete from iceberg_members where discord_id = ${member.id}`;
    }

    return eligible;
}

async function syncIcebergMembershipForGuild(guild, db = sql) {
    const members = await guild.members.fetch();
    let eligible = 0;

    for (const [, member] of members) {
        if (member.user.bot) continue;
        if (await syncIcebergMember(guild, member, db)) eligible += 1;
    }

    return { checked: members.size, eligible };
}

async function isIcebergMember(guild, member, db = sql) {
    return syncIcebergMember(guild, member, db);
}

async function addIcebergPlot(plotNumber, db = sql) {
    const rows = await db`
        insert into iceberg_plots (plot_number)
        values (${plotNumber})
        on conflict (plot_number) do nothing
        returning plot_number
    `;

    return rows.length > 0;
}

async function deleteIcebergPlot(plotNumber, db = sql) {
    const rows = await db`
        delete from iceberg_plots
        where plot_number = ${plotNumber}
        returning plot_number, owner_discord_id
    `;

    return rows[0] || null;
}

async function claimIcebergPlot(plotNumber, playerDiscordId, db = sql) {
    return db.begin(async transaction => {
        const ownedRows = await transaction`
            select plot_number
            from iceberg_plots
            where owner_discord_id = ${playerDiscordId}
            for update
        `;

        if (ownedRows.length >= ICEBERG_PLOT_LIMIT) {
            return { status: 'limit_reached', ownedCount: ownedRows.length };
        }

        const plotRows = await transaction`
            select plot_number, owner_discord_id
            from iceberg_plots
            where plot_number = ${plotNumber}
            for update
        `;
        const plot = plotRows[0];

        if (!plot) return { status: 'not_found' };
        if (plot.owner_discord_id) {
            return { status: 'owned', ownerId: plot.owner_discord_id };
        }

        const claimedRows = await transaction`
            update iceberg_plots
            set
                owner_discord_id = ${playerDiscordId},
                updated_at = now()
            where plot_number = ${plotNumber}
                and owner_discord_id is null
            returning plot_number
        `;

        return claimedRows[0]
            ? { status: 'claimed', plotNumber }
            : { status: 'owned' };
    });
}

async function clearPlotOwner(plotNumber, db = sql) {
    const rows = await db`
        update iceberg_plots
        set
            owner_discord_id = null,
            updated_at = now()
        where plot_number = ${plotNumber}
        returning plot_number
    `;

    return rows[0] || null;
}

async function getPlotInfo(plotNumber, db = sql) {
    const rows = await db`
        select
            plot.plot_number,
            plot.owner_discord_id,
            player.discord_username,
            player.discord_display_name,
            player.minecraft_ign
        from iceberg_plots plot
        left join players player on player.discord_id = plot.owner_discord_id
        where plot.plot_number = ${plotNumber}
        limit 1
    `;

    return rows[0] || null;
}

async function transferPlot(plotNumber, fromUserId, toUserId, db = sql) {
    return db.begin(async transaction => {
        const targetPlots = await transaction`
            select plot_number
            from iceberg_plots
            where owner_discord_id = ${toUserId}
            for update
        `;

        if (targetPlots.length >= ICEBERG_PLOT_LIMIT) return { status: 'limit_reached' };

        const rows = await transaction`
            update iceberg_plots
            set owner_discord_id = ${toUserId}, updated_at = now()
            where plot_number = ${plotNumber}
                and owner_discord_id = ${fromUserId}
            returning plot_number
        `;

        return rows[0] ? { status: 'transferred' } : { status: 'not_owned' };
    });
}

async function getAllMembers(db = sql) {
    return db`
        select member.discord_id, member.joined_at,
            player.discord_username, player.discord_display_name, player.minecraft_ign
        from iceberg_members member
        join players player on player.discord_id = member.discord_id
        order by member.joined_at asc
    `;
}

async function getAllPlots(db = sql) {
    return db`
        select plot.plot_number, plot.owner_discord_id,
            player.discord_username, player.discord_display_name, player.minecraft_ign
        from iceberg_plots plot
        left join players player on player.discord_id = plot.owner_discord_id
        order by plot.plot_number asc
    `;
}

function truncateIcebergName(name, maxLength = 28) {
    const text = String(name || 'Unknown').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function upsertIcebergMessage(channel, markers, content) {
    const markerList = Array.isArray(markers) ? markers : [markers];
    const safeContent = content.length <= 2000 ? content : `${content.slice(0, 1950)}\n\n…trimmed`;
    const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = recentMessages?.find(message =>
        message.author.id === channel.client.user.id &&
        markerList.some(marker => message.content.includes(marker))
    );

    if (existing) {
        return existing.edit({ content: safeContent, allowedMentions: { parse: [] } });
    }

    return channel.send({ content: safeContent, allowedMentions: { parse: [] } });
}

async function updateIcebergChannel(guild, db = sql) {
    const channel = guild.channels.cache.get(ICEBERG_CHANNEL_ID) ||
        await guild.channels.fetch(ICEBERG_CHANNEL_ID).catch(() => null);

    if (!channel) return false;

    const [plots, countRows] = await Promise.all([
        getAllPlots(db),
        db`select count(*)::int as count from iceberg_members`
    ]);
    const memberCount = countRows[0]?.count || 0;
    const plotLines = plots.length > 0
        ? plots.map(plot => {
            if (!plot.owner_discord_id) return `**${plot.plot_number}.** 🟢 Available`;
            const owner = truncateIcebergName(
                plot.minecraft_ign || plot.discord_display_name || plot.discord_username
            );
            return `**${plot.plot_number}.** ✅ ${owner}`;
        })
        : ['No plots are currently registered.'];
    const overviewContent =
        `🏔️🐧 **ICEBERG OVERVIEW** 🐧🏔️\n\n` +
        `Players with **${ICEBERG_VOUCHES_REQUIRED}+ vouches** or the **Admin** staff rank automatically become Iceberg Penguins.\n\n` +
        `Plots are **free to claim**, first come, first served, with a limit of **${ICEBERG_PLOT_LIMIT} plots per player**.\n\n` +
        `**📋 PLOT COMMANDS**\n\n` +
        `\`/claimplot [number]\` — Claim an available plot\n` +
        `\`/iceberg plot [number]\` — Check a plot\n` +
        `\`/iceberg transfer [number] [user]\` — Transfer your plot\n\n` +
        `**👥 ICEBERG PENGUINS: ${memberCount}**`;
    const plotContent =
        `🏘️🐧 **ICEBERG PLOT LIST** 🐧🏘️\n\n` +
        `✅ Claimed  •  🟢 Available\n\n` +
        plotLines.join('\n');

    await upsertIcebergMessage(channel, 'ICEBERG OVERVIEW', overviewContent);
    await upsertIcebergMessage(channel, 'ICEBERG PLOT LIST', plotContent);
    return true;
}

async function updateMembersListChannel(guild, db = sql) {
    const channel = guild.channels.cache.get(ICEBERG_MEMBERS_CHANNEL_ID) ||
        await guild.channels.fetch(ICEBERG_MEMBERS_CHANNEL_ID).catch(() => null);

    if (!channel) return false;

    const members = await getAllMembers(db);
    const content = members.length > 0
        ? `**❄️ ICEBERG PENGUINS**\n\n` + members.map((member, index) => {
            const name = member.minecraft_ign || member.discord_display_name || member.discord_username || 'Unknown';
            return `**${index + 1}.** ${name} — <@${member.discord_id}>`;
        }).join('\n')
        : '**❄️ ICEBERG PENGUINS**\n\nNo eligible players yet.';

    await upsertIcebergMessage(channel, ['ICEBERG PENGUINS', 'ICEBERG MEMBERS'], content);
    return true;
}

module.exports = {
    ICEBERG_PLOT_LIMIT,
    ICEBERG_VOUCHES_REQUIRED,
    addIcebergPlot,
    claimIcebergPlot,
    clearPlotOwner,
    deleteIcebergPlot,
    getAllMembers,
    getAllPlots,
    getIcebergEligibility,
    getIcebergRole,
    getPlotInfo,
    isIcebergEligibleProfile,
    isIcebergMember,
    syncIcebergMember,
    syncIcebergMembershipForGuild,
    transferPlot,
    updateIcebergChannel,
    updateMembersListChannel
};
