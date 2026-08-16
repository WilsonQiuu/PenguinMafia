const {
    ChannelType,
    PermissionFlagsBits
} = require('discord.js');
const {
    dismissRow
} = require('./dismissible.js');

const PERK_ROLE_COLOR = 0x9B59B6;
const STAFF_ROLE_NAMES = ['Trial Mod', 'Moderator', 'Sr Moderator', 'Admin'];
const DON_ROLE_ID = process.env.DON_ELECTION_ROLE_ID || '1497774847630245908';

const PERK_DEFINITIONS = [
    {
        key: 'activities',
        label: 'Activities',
        level: () => Number(process.env.VC_PERK_ACTIVITIES_LEVEL || 3),
        roleIdEnv: 'VC_PERK_ACTIVITIES_ROLE_ID',
        roleName: level => `VC Perks · Activities (Lv ${level})`,
        description: 'Use activities in voice channels (Watch Together, etc.)'
    },
    {
        key: 'screenShare',
        label: 'Screen Share',
        level: () => Number(process.env.VC_PERK_SCREEN_SHARE_LEVEL || 5),
        roleIdEnv: 'VC_PERK_SCREEN_SHARE_ROLE_ID',
        roleName: level => `VC Perks · Screen Share (Lv ${level})`,
        description: 'Screen-share in voice channels'
    },
    {
        key: 'slowMode',
        label: 'Slow Mode Bypass',
        // Disabled for now; set VC_PERK_SLOWMODE_LEVEL to a positive level to re-enable later.
        level: () => Number(process.env.VC_PERK_SLOWMODE_LEVEL || 0),
        roleIdEnv: 'VC_PERK_SLOWMODE_ROLE_ID',
        roleName: level => `VC Perks · Slow Mode Bypass (Lv ${level})`,
        description: 'Bypass slow mode in text channels'
    },
    {
        key: 'stage',
        label: 'Event Stage Access',
        level: () => Number(process.env.VC_PERK_STAGE_LEVEL || 10),
        roleIdEnv: 'VC_PERK_STAGE_ROLE_ID',
        roleName: level => `VC Perks · Event Stage (Lv ${level})`,
        description: 'Join the event stage and request to speak'
    }
];

function parseDiscordIdList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map(id => id.trim())
        .filter(Boolean);
}

function perkLevels() {
    return Object.fromEntries(
        PERK_DEFINITIONS.map(definition => [definition.key, definition.level()])
    );
}

function perksAtLevel(level) {
    const normalizedLevel = Math.max(0, Math.floor(Number(level) || 0));
    return PERK_DEFINITIONS
        .filter(definition => definition.level() > 0 && normalizedLevel >= definition.level())
        .sort((a, b) => a.level() - b.level());
}

function nextPerkAtLevel(level) {
    const normalizedLevel = Math.max(0, Math.floor(Number(level) || 0));
    return PERK_DEFINITIONS
        .filter(definition => definition.level() > normalizedLevel)
        .sort((a, b) => a.level() - b.level())[0] || null;
}

function perkSummaryLines() {
    const lines = PERK_DEFINITIONS
        .filter(definition => definition.level() > 0)
        .sort((a, b) => a.level() - b.level())
        .map(definition => `- **Level ${definition.level()}** — ${definition.description}`);

    return [
        '## 🎁 VC LEVEL PERKS',
        ...(lines.length > 0 ? lines : ['- No perks are currently configured.'])
    ];
}

function perksForReply(level) {
    const unlocked = perksAtLevel(level);
    const next = nextPerkAtLevel(level);
    const unlockedLine = unlocked.length > 0
        ? `Unlocked: **${unlocked.map(definition => definition.label).join(', ')}**`
        : 'Unlocked: **none yet**';
    const nextLine = next
        ? `Next perk: **${next.label}** at **Level ${next.level()}**`
        : 'All perks unlocked!';

    return `${unlockedLine}\n${nextLine}`;
}

async function resolvePerkRole(guild, definition) {
    const configuredId = process.env[definition.roleIdEnv];

    if (configuredId) {
        return guild.roles.cache.get(configuredId) ||
            await guild.roles.fetch(configuredId).catch(() => null);
    }

    return guild.roles.cache.find(role => role.name === definition.roleName(definition.level())) || null;
}

async function ensurePerkRole(guild, definition) {
    if (definition.level() <= 0) {
        return null;
    }

    let role = await resolvePerkRole(guild, definition);

    if (!role) {
        role = await guild.roles.create({
            name: definition.roleName(definition.level()),
            colors: {
                primaryColor: PERK_ROLE_COLOR
            },
            permissions: 0n,
            reason: 'Penguin Mafia VC perk role setup'
        });
    }

    return role;
}

async function buildPerkRoleMap(guild) {
    const roleMap = new Map();

    for (const definition of PERK_DEFINITIONS) {
        roleMap.set(definition.key, await resolvePerkRole(guild, definition));
    }

    return roleMap;
}

function mergeOverwrite(overwrite, allowFlags = [], denyFlags = []) {
    let allow = overwrite?.allow || 0n;
    let deny = overwrite?.deny || 0n;

    for (const flag of allowFlags) {
        allow |= flag;
    }

    for (const flag of denyFlags) {
        deny |= flag;
    }

    return { allow, deny };
}

async function upsertChannelOverwrite(channel, targetId, options = {}) {
    const existing = channel.permissionOverwrites.cache.get(targetId);
    const merged = mergeOverwrite(
        existing,
        (options.allow || []).map(flag => BigInt(flag)),
        (options.deny || []).map(flag => BigInt(flag))
    );

    return channel.permissionOverwrites.create(
        targetId,
        {
            allow: merged.allow,
            deny: merged.deny,
            type: options.type ?? existing?.type ?? 0
        },
        'Penguin Mafia VC perk channel setup'
    );
}

function staffRoleIdsForGuild(guild) {
    const ids = [];

    for (const name of STAFF_ROLE_NAMES) {
        const role = guild.roles.cache.find(candidate => candidate.name === name);

        if (role) {
            ids.push(role.id);
        }
    }

    return ids;
}

async function ensureVcPerkRoles(guild, db, options = {}) {
    const roleMap = new Map();
    const rolesCreated = [];

    for (const definition of PERK_DEFINITIONS) {
        const role = await ensurePerkRole(guild, definition);

        if (role) {
            roleMap.set(definition.key, role);
            rolesCreated.push(role);
        }
    }

    const channels = await guild.channels.fetch();
    const voiceChannels = channels.filter(channel =>
        channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
    );
    const stageChannels = channels.filter(channel => channel.type === ChannelType.GuildStageVoice);
    const textChannels = channels.filter(channel => channel.type === ChannelType.GuildText);

    const slowModeChannelIds = parseDiscordIdList(process.env.VC_PERK_SLOWMODE_CHANNEL_IDS);
    const stageChannelIds = parseDiscordIdList(process.env.VC_PERK_STAGE_CHANNEL_IDS);

    const everyoneId = guild.roles.everyone.id;
    const protectedRoleIds = staffRoleIdsForGuild(guild);

    if (guild.roles.cache.has(DON_ROLE_ID)) {
        protectedRoleIds.push(DON_ROLE_ID);
    }

    const screenShareRole = roleMap.get('screenShare');
    const activitiesRole = roleMap.get('activities');
    const slowModeRole = roleMap.get('slowMode');
    const stageRole = roleMap.get('stage');

    let channelsUpdated = 0;

    for (const [, channel] of voiceChannels) {
        await upsertChannelOverwrite(channel, everyoneId, {
            deny: [
                PermissionFlagsBits.STREAM,
                PermissionFlagsBits.USE_EMBEDDED_ACTIVITIES
            ]
        });

        if (screenShareRole) {
            await upsertChannelOverwrite(channel, screenShareRole.id, {
                allow: [PermissionFlagsBits.STREAM]
            });
        }

        if (activitiesRole) {
            await upsertChannelOverwrite(channel, activitiesRole.id, {
                allow: [PermissionFlagsBits.USE_EMBEDDED_ACTIVITIES]
            });
        }

        for (const roleId of protectedRoleIds) {
            await upsertChannelOverwrite(channel, roleId, {
                allow: [
                    PermissionFlagsBits.STREAM,
                    PermissionFlagsBits.USE_EMBEDDED_ACTIVITIES
                ]
            });
        }

        channelsUpdated++;
    }

    for (const [, channel] of stageChannels) {
        if (stageRole && (stageChannelIds.length === 0 || stageChannelIds.includes(channel.id))) {
            await upsertChannelOverwrite(channel, stageRole.id, {
                allow: [PermissionFlagsBits.CONNECT]
            });
            // The bot needs MUTE_MEMBERS to decline request-to-speak requests.
            await upsertChannelOverwrite(channel, guild.client.user.id, {
                allow: [PermissionFlagsBits.MUTE_MEMBERS],
                type: 1
            });
            channelsUpdated++;
        }
    }

    for (const [, channel] of textChannels) {
        if (slowModeRole && (slowModeChannelIds.length === 0 || slowModeChannelIds.includes(channel.id))) {
            await upsertChannelOverwrite(channel, slowModeRole.id, {
                allow: [PermissionFlagsBits.MANAGE_MESSAGES]
            });
            channelsUpdated++;
        }
    }

    return { roleMap, rolesCreated, channelsUpdated };
}

async function memberVoiceLevel(guildId, discordId, db) {
    const rows = await db`
        select (
            stats.voice_seconds + coalesce(
                greatest(0, floor(extract(epoch from (now() - session.started_at))))::bigint,
                0
            )
        )::text as voice_seconds
        from vc_levels stats
        left join vc_active_sessions session
            on session.guild_id = stats.guild_id
            and session.discord_id = stats.discord_id
        where stats.guild_id = ${guildId}
            and stats.discord_id = ${discordId}
        limit 1
    `;

    if (!rows[0]) {
        return 0;
    }

    const {
        VOICE_CREDIT_SECONDS,
        levelForXp
    } = require('./voiceLeveling.js');
    const voiceXp = Math.floor(Number(rows[0].voice_seconds) / VOICE_CREDIT_SECONDS);

    return levelForXp(voiceXp);
}

async function syncMemberPerks(guild, member, db) {
    const level = await memberVoiceLevel(guild.id, member.id, db);
    const roleMap = await buildPerkRoleMap(guild);
    const desiredRoles = [];
    const ownedPerkRoles = [];

    for (const definition of PERK_DEFINITIONS) {
        const role = roleMap.get(definition.key);

        if (!role) {
            continue;
        }

        if (definition.level() > 0 && level >= definition.level()) {
            desiredRoles.push(role);
        }

        if (member.roles.cache.has(role.id)) {
            ownedPerkRoles.push(role);
        }
    }

    const toGrant = desiredRoles.filter(role => !ownedPerkRoles.some(owned => owned.id === role.id));
    const toRemove = ownedPerkRoles.filter(role => !desiredRoles.some(desired => desired.id === role.id));
    let granted = 0;
    let removed = 0;

    for (const role of toGrant) {
        if (role.editable) {
            await member.roles.add(role, `VC level ${level} perk unlocked`);
            granted++;
        }
    }

    for (const role of toRemove) {
        if (role.editable) {
            await member.roles.remove(role, `VC level ${level} perk no longer applies`);
            removed++;
        }
    }

    return {
        discordId: member.id,
        level,
        granted,
        removed
    };
}

async function syncAllMemberPerks(guild, db) {
    const members = await guild.members.fetch();
    let checked = 0;
    let granted = 0;
    let removed = 0;

    for (const [, member] of members) {
        if (member.user.bot) {
            continue;
        }

        try {
            const result = await syncMemberPerks(guild, member, db);
            checked++;
            granted += result.granted;
            removed += result.removed;

            if (result.granted + result.removed > 0) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        } catch (error) {
            console.error(`Could not sync VC perks for ${member.user.tag || member.id}:`);
            console.error(error);
        }
    }

    return { checked, granted, removed };
}

async function syncLevelUpPerks(guild, levelUps, db) {
    let granted = 0;

    for (const levelUp of levelUps || []) {
        const member = guild.members.cache.get(levelUp.discordId) ||
            await guild.members.fetch(levelUp.discordId).catch(() => null);

        if (!member || member.user.bot) {
            continue;
        }

        try {
            granted += (await syncMemberPerks(guild, member, db)).granted;
        } catch (error) {
            console.error(`Could not sync VC perks for ${levelUp.discordId}:`);
            console.error(error);
        }
    }

    return granted;
}

const requestToSpeakCooldowns = new Map();
const REQUEST_TO_SPEAK_COOLDOWN_MS = 60_000;

function isPerkStageChannel(guild, channelId) {
    if (!channelId) {
        return false;
    }

    const stageChannelIds = parseDiscordIdList(process.env.VC_PERK_STAGE_CHANNEL_IDS);

    if (stageChannelIds.length > 0) {
        return stageChannelIds.includes(channelId);
    }

    return guild.channels.cache.get(channelId)?.type === ChannelType.GuildStageVoice;
}

function isStaffMember(guild, member) {
    return member.roles.cache.some(role => STAFF_ROLE_NAMES.includes(role.name));
}

function isDonMember(member) {
    const { isDon } = require('./staff.js');

    return isDon(member.id);
}

async function handleStageRequestToSpeak(guild, newState, db) {
    if (!newState.requestToSpeakTimestamp) {
        return { handled: false, reason: 'no_request' };
    }

    if (!isPerkStageChannel(guild, newState.channelId)) {
        return { handled: false, reason: 'not_stage' };
    }

    const member = newState.member || guild.members.cache.get(newState.id);

    if (!member || member.user.bot) {
        return { handled: false, reason: 'not_member' };
    }

    if (isStaffMember(guild, member) || isDonMember(member)) {
        return { handled: false, reason: 'exempt' };
    }

    const stageLevel = Number(process.env.VC_PERK_STAGE_LEVEL || 10);

    if (stageLevel <= 0) {
        return { handled: false, reason: 'perk_disabled' };
    }

    const level = await memberVoiceLevel(guild.id, member.id, db);

    if (level >= stageLevel) {
        return { handled: false, reason: 'eligible' };
    }

    const now = Date.now();
    const lastHandled = requestToSpeakCooldowns.get(member.id) || 0;

    if (now - lastHandled < REQUEST_TO_SPEAK_COOLDOWN_MS) {
        return { handled: true, reason: 'cooldown', dmSent: false };
    }

    requestToSpeakCooldowns.set(member.id, now);

    try {
        await newState.setRequestToSpeak(false);
    } catch (error) {
        console.error(`Could not decline request to speak for ${member.user.tag || member.id}:`);
        console.error(error);
    }

    const next = nextPerkAtLevel(level);
    const nextLine = next
        ? `\nNext perk: **${next.label}** at **Level ${next.level()}**.`
        : '';

    try {
        await member.send({
            content:
                `🎙️❌ **Request to speak declined**\n\n` +
                `The event stage requires **VC Level ${stageLevel}** to request to speak. ` +
                `Your current VC level is **${level}**.${nextLine}\n\n` +
                `Use \`/vchours\` to see your progress.`,
            components: [dismissRow(member.id)]
        });
    } catch (error) {
        console.error(`Could not DM ${member.user.tag || member.id} about the declined request to speak:`);
        console.error(error);
    }

    return { handled: true, reason: 'declined', level, stageLevel, dmSent: true };
}

module.exports = {
    PERK_DEFINITIONS,
    ensureVcPerkRoles,
    handleStageRequestToSpeak,
    isPerkStageChannel,
    memberVoiceLevel,
    nextPerkAtLevel,
    perkLevels,
    perksAtLevel,
    perksForReply,
    perkSummaryLines,
    syncAllMemberPerks,
    syncLevelUpPerks,
    syncMemberPerks
};
