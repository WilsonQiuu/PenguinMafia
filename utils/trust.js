const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const {
    formatUser,
    postModLog
} = require('./modlogs.js');
const {
    STAFF_ROLE_IDS
} = require('./bootstrap.js');
const {
    getStaffProfile,
    isDon,
    syncInvokerStaffRank
} = require('./staff.js');

const TRUSTED_PENGUIN_ROLE_ID =
    process.env.TRUSTED_PENGUIN_ROLE_ID || '1518113965282955345';
const TRUSTED_ADMIN_VOUCHES_REQUIRED = 3;

function playerName(player, fallback = 'Unknown Player') {
    return player?.discord_display_name ||
        player?.discord_username ||
        fallback;
}

function trustSummary(profile) {
    return (
        `Admin vouches: **${profile.admin_vouches}/${TRUSTED_ADMIN_VOUCHES_REQUIRED}**\n` +
        `Admin vetoes: **${profile.admin_vetoes}**\n` +
        `Total vouches: **${profile.vouches}**\n` +
        `Total vetoes: **${profile.vetoes}**`
    );
}

function willBeTrustedAfterVouch(profile) {
    return Number(profile.admin_vouches || 0) + 1 >= TRUSTED_ADMIN_VOUCHES_REQUIRED &&
        Number(profile.admin_vetoes || 0) === 0;
}

async function requireAdminTrustAccess(db, interaction, commandName = 'this command') {
    if (isDon(interaction.user.id)) {
        return {
            isDon: true,
            staffRankName: 'Don'
        };
    }

    await syncInvokerStaffRank(db, interaction.member);
    const staff = await getStaffProfile(db, interaction.user.id);

    if (staff?.staff_rank_name !== 'Admin') {
        throw new Error(`Only Staff Admins can use \`${commandName}\` right now.`);
    }

    return {
        isDon: false,
        staffRankName: staff.staff_rank_name
    };
}

async function requireVouchAccess(db, interaction) {
    if (isDon(interaction.user.id)) {
        return {
            type: 'admin',
            isDon: true,
            staffRankName: 'Don'
        };
    }

    await syncInvokerStaffRank(db, interaction.member);
    const staff = await getStaffProfile(db, interaction.user.id);

    if (staff?.staff_rank_name === 'Admin') {
        return {
            type: 'admin',
            isDon: false,
            staffRankName: staff.staff_rank_name
        };
    }

    const role = await getTrustedPenguinRole(interaction.guild);

    if (!role) {
        throw new Error(`Trusted Penguin role ID \`${TRUSTED_PENGUIN_ROLE_ID}\` was not found.`);
    }

    if (!interaction.member.roles.cache.has(role.id)) {
        throw new Error('You need Trusted Penguin or Staff Admin to use `/vouche` right now.');
    }

    return {
        type: 'regular',
        isDon: false,
        staffRankName: staff?.staff_rank_name || null
    };
}

async function ensureActorInDatabase(db, actorId) {
    const rows = await db`
        select discord_id
        from players
        where discord_id = ${actorId}
        limit 1
    `;

    if (rows.length === 0) {
        throw new Error('You are not in the database yet. Run `/setup` first.');
    }
}

async function promoteRegularVouchesToAdminVouches(db, adminDiscordId) {
    const rows = await db`
        with regular_vouches as (
            delete from player_vouches
            where voucher_discord_id = ${adminDiscordId}
            returning target_discord_id
        ),
        inserted_admin_vouches as (
            insert into player_admin_vouches (
                target_discord_id,
                admin_discord_id
            )
            select
                target_discord_id,
                ${adminDiscordId}
            from regular_vouches
            on conflict (target_discord_id, admin_discord_id) do nothing
            returning target_discord_id
        ),
        count_rows as (
            select
                target_discord_id,
                count(*)::int as regular_deleted,
                0::int as admin_inserted
            from regular_vouches
            group by target_discord_id

            union all

            select
                target_discord_id,
                0::int as regular_deleted,
                count(*)::int as admin_inserted
            from inserted_admin_vouches
            group by target_discord_id
        ),
        totals as (
            select
                target_discord_id,
                sum(regular_deleted)::int as regular_deleted,
                sum(admin_inserted)::int as admin_inserted
            from count_rows
            group by target_discord_id
        )
        update players player
        set
            vouches = greatest(player.vouches - (totals.regular_deleted - totals.admin_inserted), 0),
            admin_vouches = player.admin_vouches + totals.admin_inserted,
            updated_at = now()
        from totals
        where player.discord_id = totals.target_discord_id
        returning
            player.discord_id,
            player.discord_username,
            player.discord_display_name,
            player.vouches,
            player.admin_vouches,
            player.vetoes,
            player.admin_vetoes,
            totals.regular_deleted,
            totals.admin_inserted
    `;

    return rows;
}

async function removeAdminVouchesByAdmin(db, adminDiscordId) {
    const rows = await db`
        with removed_admin_vouches as (
            delete from player_admin_vouches
            where admin_discord_id = ${adminDiscordId}
            returning target_discord_id
        ),
        totals as (
            select
                target_discord_id,
                count(*)::int as removed_count
            from removed_admin_vouches
            group by target_discord_id
        )
        update players player
        set
            admin_vouches = greatest(player.admin_vouches - totals.removed_count, 0),
            vouches = greatest(player.vouches - totals.removed_count, 0),
            updated_at = now()
        from totals
        where player.discord_id = totals.target_discord_id
        returning
            player.discord_id,
            player.discord_username,
            player.discord_display_name,
            player.vouches,
            player.admin_vouches,
            player.vetoes,
            player.admin_vetoes,
            totals.removed_count
    `;

    return rows;
}

async function getTrustProfile(db, playerId) {
    const rows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            vouches,
            admin_vouches,
            vetoes,
            admin_vetoes,
            staff_rank_name
        from players
        where discord_id = ${playerId}
        limit 1
    `;

    return rows[0] || null;
}

async function getTrustedPenguinRole(guild) {
    return guild.roles.cache.get(TRUSTED_PENGUIN_ROLE_ID) ||
        await guild.roles.fetch(TRUSTED_PENGUIN_ROLE_ID).catch(() => null);
}

async function syncTrustedPenguinRole(guild, profile, reason) {
    const member = await guild.members.fetch(profile.discord_id).catch(() => null);

    if (!member) {
        return {
            status: 'missing_member'
        };
    }

    const role = await getTrustedPenguinRole(guild);

    if (!role) {
        return {
            status: 'missing_role'
        };
    }

    const adminRoleId = STAFF_ROLE_IDS.get('Admin');
    const isAdmin =
        profile.staff_rank_name === 'Admin' ||
        (adminRoleId && member.roles.cache.has(adminRoleId));
    const shouldHaveRole =
        isAdmin ||
        (
            Number(profile.admin_vouches || 0) >= TRUSTED_ADMIN_VOUCHES_REQUIRED &&
            Number(profile.admin_vetoes || 0) === 0
        );
    const hasRole = member.roles.cache.has(role.id);

    if (shouldHaveRole && !hasRole) {
        await member.roles.add(role, reason);

        return {
            status: 'added',
            role
        };
    }

    if (!shouldHaveRole && hasRole) {
        await member.roles.remove(role, reason);

        return {
            status: 'removed',
            role
        };
    }

    return {
        status: shouldHaveRole ? 'already_has_role' : 'already_without_role',
        role
    };
}

function trustedRoleLine(result) {
    if (!result) {
        return '';
    }

    if (result.status === 'added') {
        return `\nTrusted Penguin role: **added** <@&${TRUSTED_PENGUIN_ROLE_ID}>`;
    }

    if (result.status === 'removed') {
        return `\nTrusted Penguin role: **removed** <@&${TRUSTED_PENGUIN_ROLE_ID}>`;
    }

    if (result.status === 'already_has_role') {
        return `\nTrusted Penguin role: **already active** <@&${TRUSTED_PENGUIN_ROLE_ID}>`;
    }

    if (result.status === 'already_without_role') {
        return '\nTrusted Penguin role: **not active**';
    }

    if (result.status === 'missing_role') {
        return `\n⚠️ Trusted Penguin role ID \`${TRUSTED_PENGUIN_ROLE_ID}\` was not found.`;
    }

    if (result.status === 'missing_member') {
        return '\n⚠️ Player is not currently in the server, so I could not update the Trusted Penguin role.';
    }

    return '';
}

async function logTrustCommand(interaction, title, commandName, fields) {
    try {
        await postModLog(interaction.guild, title, [
            {
                name: 'Command',
                value: commandName
            },
            {
                name: 'Actor',
                value: formatUser(interaction.user)
            },
            ...fields
        ]);
    } catch (error) {
        console.error(`Could not write ${commandName} mod log:`);
        console.error(error);
    }
}

async function confirmAction(interaction, options) {
    const confirmButton = new ButtonBuilder()
        .setCustomId(`${options.customIdPrefix}_confirm:${interaction.id}`)
        .setLabel(options.confirmLabel || 'Confirm')
        .setStyle(options.danger ? ButtonStyle.Danger : ButtonStyle.Primary);

    const cancelButton = new ButtonBuilder()
        .setCustomId(`${options.customIdPrefix}_cancel:${interaction.id}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    await interaction.editReply({
        content: options.content,
        components: [row]
    });

    const filter = buttonInteraction => {
        return (
            buttonInteraction.user.id === interaction.user.id &&
            (
                buttonInteraction.customId === `${options.customIdPrefix}_confirm:${interaction.id}` ||
                buttonInteraction.customId === `${options.customIdPrefix}_cancel:${interaction.id}`
            )
        );
    };

    let buttonInteraction;

    try {
        buttonInteraction = await interaction.channel.awaitMessageComponent({
            filter,
            time: options.time ?? 60_000
        });
    } catch {
        await interaction.editReply({
            content: options.expiredContent || '⏰ Confirmation expired.',
            components: []
        });

        return {
            confirmed: false,
            expired: true,
            buttonInteraction: null
        };
    }

    if (buttonInteraction.customId === `${options.customIdPrefix}_cancel:${interaction.id}`) {
        await buttonInteraction.update({
            content: options.cancelContent || '❌ Cancelled.',
            components: []
        });

        return {
            confirmed: false,
            expired: false,
            buttonInteraction
        };
    }

    await buttonInteraction.update({
        content: options.confirmedContent || '⏳ Processing...',
        components: []
    });

    return {
        confirmed: true,
        expired: false,
        buttonInteraction
    };
}

module.exports = {
    TRUSTED_ADMIN_VOUCHES_REQUIRED,
    TRUSTED_PENGUIN_ROLE_ID,
    confirmAction,
    ensureActorInDatabase,
    getTrustProfile,
    logTrustCommand,
    playerName,
    promoteRegularVouchesToAdminVouches,
    requireAdminTrustAccess,
    requireVouchAccess,
    removeAdminVouchesByAdmin,
    syncTrustedPenguinRole,
    trustedRoleLine,
    trustSummary,
    willBeTrustedAfterVouch
};
