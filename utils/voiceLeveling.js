const {
    ChannelType
} = require('discord.js');
const {
    PROMOTION_EVENTS_CHANNEL_ID,
    PROMOTION_EVENTS_CHANNEL_NAME
} = require('./bootstrap.js');
const {
    postModLog
} = require('./modlogs.js');

const VOICE_CREDIT_MINUTES = 10;
const VOICE_CREDIT_SECONDS = VOICE_CREDIT_MINUTES * 60;
const VOICE_CREDIT_XP = 1;
const VOICE_LEVEL_INFO_MARKER = 'VC TIME LEVELING';

function voiceXpModLoggingStateKey(guildId) {
    return `vc_xp_mod_logging:${guildId}`;
}

async function voiceXpModLoggingEnabled(guildId, db) {
    const rows = await db`
        select value
        from bot_state
        where key = ${voiceXpModLoggingStateKey(guildId)}
        limit 1
    `;

    return rows[0]?.value === 'true';
}

async function setVoiceXpModLogging(guildId, enabled, db) {
    await db`
        insert into bot_state (key, value, updated_at)
        values (${voiceXpModLoggingStateKey(guildId)}, ${enabled ? 'true' : 'false'}, now())
        on conflict (key) do update
        set value = excluded.value, updated_at = now()
    `;

    return enabled;
}

function xpForLevel(level) {
    const normalizedLevel = Math.max(0, Math.floor(Number(level) || 0));

    if (normalizedLevel <= 16) {
        return (normalizedLevel ** 2) + (6 * normalizedLevel);
    }

    if (normalizedLevel <= 31) {
        return Math.floor((2.5 * (normalizedLevel ** 2)) - (40.5 * normalizedLevel) + 360);
    }

    return Math.floor((4.5 * (normalizedLevel ** 2)) - (162.5 * normalizedLevel) + 2220);
}

function levelForXp(xp) {
    const normalizedXp = Math.max(0, Math.floor(Number(xp) || 0));
    let low = 0;
    let high = 1;

    while (xpForLevel(high) <= normalizedXp) {
        low = high;
        high *= 2;
    }

    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);

        if (xpForLevel(middle) <= normalizedXp) {
            low = middle;
        } else {
            high = middle;
        }
    }

    return low;
}

function voiceProgress(xp) {
    const normalizedXp = Math.max(0, Math.floor(Number(xp) || 0));
    const level = levelForXp(normalizedXp);
    const currentLevelXp = xpForLevel(level);
    const nextLevelXp = xpForLevel(level + 1);

    return {
        level,
        currentLevelXp,
        nextLevelXp,
        earnedThisLevel: normalizedXp - currentLevelXp,
        neededThisLevel: nextLevelXp - currentLevelXp,
        xpToNextLevel: nextLevelXp - normalizedXp
    };
}

function formatVoiceTime(seconds) {
    const normalizedSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(normalizedSeconds / 3600);
    const minutes = Math.floor((normalizedSeconds % 3600) / 60);
    const remainingSeconds = normalizedSeconds % 60;
    const parts = [];

    if (hours > 0) {
        parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    }

    if (minutes > 0 || hours > 0) {
        parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    }

    parts.push(`${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}`);
    return parts.join(' ');
}

function voiceLevelInfoPayload() {
    return {
        content:
            `# 🎙️🐧 ${VOICE_LEVEL_INFO_MARKER}\n\n` +
            `Spending time together in voice chat now earns **VC levels**. The bot records exact join and leave timestamps, so eligible voice time is tracked **to the second** without writing to the database every second. Bots and members in the server AFK channel do not earn time.\n\n` +
            `## Minecraft-style level formula\n` +
            `The total VC XP needed to reach level **L** is:\n` +
            `- Levels 0–16: **L² + 6L**\n` +
            `- Levels 17–31: **2.5L² − 40.5L + 360**\n` +
            `- Levels 32+: **4.5L² − 162.5L + 2220**\n\n` +
            `Every **600 tracked seconds** earns **1 VC XP**. Level 10 takes **26h 40m**, level 20 takes **91h 40m**, and level 30 takes **232h 30m**.\n\n` +
            `Use \`/vchours\` to see your tracked call time, VC level, and progress to the next level.`
    };
}

async function findPromotionEventsChannel(guild) {
    const channels = await guild.channels.fetch();
    const configuredChannel = channels.get(PROMOTION_EVENTS_CHANNEL_ID);

    if (configuredChannel?.type === ChannelType.GuildText) {
        return configuredChannel;
    }

    return channels.find(channel => {
        return channel.type === ChannelType.GuildText &&
            channel.name === PROMOTION_EVENTS_CHANNEL_NAME;
    }) || null;
}

async function ensureVoiceLevelInfoBoard(guild, db) {
    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        return false;
    }

    const stateKey = `voice_level_info_message:${guild.id}`;
    const stateRows = await db`
        select value
        from bot_state
        where key = ${stateKey}
        limit 1
    `;
    let message = null;

    if (stateRows[0]?.value) {
        message = await channel.messages.fetch(stateRows[0].value).catch(() => null);
    }

    if (!message) {
        const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        message = recentMessages?.find(candidate => {
            return candidate.author.id === guild.client.user.id &&
                candidate.content.includes(VOICE_LEVEL_INFO_MARKER);
        }) || null;
    }

    if (message) {
        await message.edit(voiceLevelInfoPayload());
    } else {
        message = await channel.send(voiceLevelInfoPayload());
    }

    await db`
        insert into bot_state (key, value, updated_at)
        values (${stateKey}, ${message.id}, now())
        on conflict (key) do update
        set value = excluded.value, updated_at = now()
    `;

    return true;
}

function eligibleVoiceMemberIds(guild) {
    const memberIds = new Set();

    for (const [, voiceState] of guild.voiceStates.cache) {
        if (!voiceState.channelId || voiceState.channelId === guild.afkChannelId) {
            continue;
        }

        const member = voiceState.member || guild.members.cache.get(voiceState.id);

        if (!member || member.user.bot) {
            continue;
        }

        memberIds.add(member.id);
    }

    return [...memberIds];
}

function voiceStateIsEligible(guild, voiceState) {
    const member = voiceState?.member || guild.members.cache.get(voiceState?.id);

    return Boolean(
        voiceState?.channelId &&
        voiceState.channelId !== guild.afkChannelId &&
        member &&
        !member.user.bot
    );
}

async function startVoiceSession(guildId, discordId, channelId, db, startedAt = new Date(), options = {}) {
    return db.begin(async transaction => {
        await transaction`
            insert into vc_levels (guild_id, discord_id)
            values (${guildId}, ${discordId})
            on conflict (guild_id, discord_id) do nothing
        `;

        if (options.preserveExisting) {
            await transaction`
                insert into vc_active_sessions (guild_id, discord_id, channel_id, started_at, updated_at)
                values (${guildId}, ${discordId}, ${channelId}, ${startedAt}, now())
                on conflict (guild_id, discord_id) do update
                set channel_id = excluded.channel_id, updated_at = now()
            `;
        } else {
            await transaction`
                insert into vc_active_sessions (guild_id, discord_id, channel_id, started_at, updated_at)
                values (${guildId}, ${discordId}, ${channelId}, ${startedAt}, now())
                on conflict (guild_id, discord_id) do update
                set
                    channel_id = excluded.channel_id,
                    started_at = excluded.started_at,
                    updated_at = now()
            `;
        }
    });
}

async function moveVoiceSession(guildId, discordId, channelId, db) {
    await db`
        update vc_active_sessions
        set channel_id = ${channelId}, updated_at = now()
        where guild_id = ${guildId}
            and discord_id = ${discordId}
    `;
}

async function endVoiceSession(guildId, discordId, db, endedAt = new Date()) {
    const rows = await db`
        with ended as (
            delete from vc_active_sessions
            where guild_id = ${guildId}
                and discord_id = ${discordId}
            returning started_at
        ),
        elapsed as (
            select greatest(
                0,
                floor(extract(epoch from (${endedAt}::timestamptz - started_at)))
            )::bigint as seconds
            from ended
        )
        update vc_levels stats
        set
            voice_seconds = stats.voice_seconds + elapsed.seconds,
            voice_minutes = (stats.voice_seconds + elapsed.seconds) / 60,
            voice_xp = (stats.voice_seconds + elapsed.seconds) / ${VOICE_CREDIT_SECONDS},
            updated_at = now()
        from elapsed
        where stats.guild_id = ${guildId}
            and stats.discord_id = ${discordId}
        returning
            stats.discord_id,
            elapsed.seconds::text as session_seconds,
            stats.voice_seconds::text,
            stats.voice_xp::text
    `;

    return rows[0] || null;
}

async function trackVoiceStateUpdate(oldState, newState, db, now = new Date()) {
    const guild = newState.guild || oldState.guild;
    const member = newState.member || oldState.member;

    if (!guild || !member || member.user.bot) {
        return { changed: false, type: null };
    }

    const wasEligible = voiceStateIsEligible(guild, oldState);
    const isEligible = voiceStateIsEligible(guild, newState);

    if (!wasEligible && isEligible) {
        await startVoiceSession(guild.id, member.id, newState.channelId, db, now);
        return { changed: true, type: 'started', discordId: member.id };
    }

    if (wasEligible && !isEligible) {
        const stats = await endVoiceSession(guild.id, member.id, db, now);
        const voiceSeconds = Number(stats?.voice_seconds || 0);
        const voiceXp = Number(stats?.voice_xp || Math.floor(voiceSeconds / VOICE_CREDIT_SECONDS));

        return {
            changed: true,
            type: 'ended',
            discordId: member.id,
            credit: stats
                ? {
                    discordId: member.id,
                    sessionSeconds: Number(stats.session_seconds || 0),
                    voiceSeconds,
                    voiceXp,
                    level: levelForXp(voiceXp)
                }
                : null
        };
    }

    if (wasEligible && isEligible && oldState.channelId !== newState.channelId) {
        await moveVoiceSession(guild.id, member.id, newState.channelId, db);
        return { changed: true, type: 'moved', discordId: member.id };
    }

    return { changed: false, type: null };
}

async function reconcileVoiceSessionsForGuild(guild, db, now = new Date()) {
    const eligibleStates = new Map();

    for (const [, voiceState] of guild.voiceStates.cache) {
        if (voiceStateIsEligible(guild, voiceState)) {
            const member = voiceState.member || guild.members.cache.get(voiceState.id);
            eligibleStates.set(member.id, voiceState);
        }
    }

    const activeRows = await db`
        select discord_id, channel_id
        from vc_active_sessions
        where guild_id = ${guild.id}
    `;
    const activeIds = new Set(activeRows.map(row => row.discord_id));

    for (const row of activeRows) {
        const currentState = eligibleStates.get(row.discord_id);

        if (!currentState) {
            await endVoiceSession(guild.id, row.discord_id, db, now);
        } else if (currentState.channelId !== row.channel_id) {
            await moveVoiceSession(guild.id, row.discord_id, currentState.channelId, db);
        }
    }

    for (const [discordId, voiceState] of eligibleStates) {
        if (!activeIds.has(discordId)) {
            await startVoiceSession(guild.id, discordId, voiceState.channelId, db, now, {
                preserveExisting: true
            });
        }
    }

    return eligibleStates.size;
}

async function liveVoiceStatsForGuild(guildId, db, activeOnly = false) {
    return db`
        select
            stats.discord_id,
            (
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
            and (${activeOnly} = false or session.discord_id is not null)
    `;
}

async function claimVoiceLevelUps(guildId, db) {
    const rows = await db`
        select
            stats.discord_id,
            stats.announced_level,
            (
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
    `;
    const levelUps = [];

    for (const row of rows) {
        const voiceSeconds = Number(row.voice_seconds);
        const voiceXp = Math.floor(voiceSeconds / VOICE_CREDIT_SECONDS);
        const newLevel = levelForXp(voiceXp);

        if (row.announced_level === null) {
            await db`
                update vc_levels
                set announced_level = ${newLevel}
                where guild_id = ${guildId}
                    and discord_id = ${row.discord_id}
                    and announced_level is null
            `;
            continue;
        }

        const oldLevel = Number(row.announced_level || 0);

        if (newLevel <= oldLevel) {
            continue;
        }

        const claimed = await db`
            update vc_levels
            set announced_level = ${newLevel}
            where guild_id = ${guildId}
                and discord_id = ${row.discord_id}
                and coalesce(announced_level, 0) < ${newLevel}
            returning discord_id
        `;

        if (claimed.length > 0) {
            levelUps.push({
                discordId: row.discord_id,
                oldLevel,
                newLevel,
                voiceSeconds,
                voiceXp
            });
        }
    }

    return levelUps;
}

async function creditVoiceTimeForGuild(guild, db, now = new Date()) {
    await reconcileVoiceSessionsForGuild(guild, db, now);
    const rows = await liveVoiceStatsForGuild(guild.id, db, true);
    const credits = rows.map(row => {
        const voiceSeconds = Number(row.voice_seconds);
        const voiceXp = Math.floor(voiceSeconds / VOICE_CREDIT_SECONDS);

        return {
            discordId: row.discord_id,
            voiceSeconds,
            voiceXp,
            level: levelForXp(voiceXp)
        };
    });

    return {
        credits,
        credited: credits.length,
        levelUps: await claimVoiceLevelUps(guild.id, db),
        skippedDuplicate: false
    };
}

async function postVoiceXpModLogs(guild, result) {
    if (result.skippedDuplicate) {
        return 0;
    }

    const credits = result.credits || [];
    const batches = credits.length > 0
        ? Array.from({ length: Math.ceil(credits.length / 20) }, (_, index) => {
            return credits.slice(index * 20, (index + 1) * 20);
        })
        : [[]];

    for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const fields = [{
            name: 'Scan Result',
            value: `Exact live VC totals checked for ${result.credited} active member(s). No per-second database polling is used.`
        }];

        if (batches.length > 1) {
            fields.push({
                name: 'Batch',
                value: `${index + 1}/${batches.length}`
            });
        }

        if (batch.length === 0) {
            fields.push({
                name: 'Players',
                value: 'No eligible human members were connected during this scan.'
            });
        } else {
            for (const credit of batch) {
                fields.push({
                    name: `<@${credit.discordId}>`,
                    value:
                        `${credit.sessionSeconds !== undefined ? `+${credit.sessionSeconds} seconds this session | ` : ''}` +
                        `${credit.voiceXp} XP | ${formatVoiceTime(credit.voiceSeconds)} total | ` +
                        `level ${credit.level}`
                });
            }
        }

        await postModLog(guild, 'Voice XP Development Log', fields);
    }

    return batches.length;
}

async function postVoiceLevelUps(guild, levelUps) {
    if (levelUps.length === 0) {
        return 0;
    }

    const channel = await findPromotionEventsChannel(guild);

    if (!channel) {
        return 0;
    }

    for (const levelUp of levelUps) {
        await channel.send({
            content:
                `🎙️🐧 **VC LEVEL UP!** 🐧🎙️\n\n` +
                `<@${levelUp.discordId}> reached **VC Level ${levelUp.newLevel}** because of their time spent in voice chat!\n` +
                `Tracked call time: **${formatVoiceTime(levelUp.voiceSeconds)}**\n\n` +
                `Thanks for spending time with the colony. 🧊`,
            allowedMentions: {
                users: [levelUp.discordId]
            }
        });
    }

    return levelUps.length;
}

module.exports = {
    VOICE_CREDIT_MINUTES,
    VOICE_CREDIT_SECONDS,
    VOICE_CREDIT_XP,
    creditVoiceTimeForGuild,
    eligibleVoiceMemberIds,
    ensureVoiceLevelInfoBoard,
    formatVoiceTime,
    levelForXp,
    postVoiceXpModLogs,
    postVoiceLevelUps,
    reconcileVoiceSessionsForGuild,
    setVoiceXpModLogging,
    voiceLevelInfoPayload,
    voiceProgress,
    trackVoiceStateUpdate,
    voiceStateIsEligible,
    voiceXpModLoggingEnabled,
    xpForLevel
};
