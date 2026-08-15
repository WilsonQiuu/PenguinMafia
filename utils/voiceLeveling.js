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

function formatVoiceTime(minutes) {
    const normalizedMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
    const hours = Math.floor(normalizedMinutes / 60);
    const remainingMinutes = normalizedMinutes % 60;

    if (hours === 0) {
        return `${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
    }

    return `${hours} hour${hours === 1 ? '' : 's'} ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
}

function voiceLevelInfoPayload() {
    return {
        content:
            `# 🎙️🐧 ${VOICE_LEVEL_INFO_MARKER}\n\n` +
            `Spending time together in voice chat now earns **VC levels**. Every **10 minutes**, the bot checks who is connected and credits each eligible penguin with **10 tracked minutes** and **1 VC XP**. The credit represents the previous 10-minute segment. Bots and members in the server AFK channel do not earn credit.\n\n` +
            `## Minecraft-style level formula\n` +
            `The total VC XP needed to reach level **L** is:\n` +
            `- Levels 0–16: **L² + 6L**\n` +
            `- Levels 17–31: **2.5L² − 40.5L + 360**\n` +
            `- Levels 32+: **4.5L² − 162.5L + 2220**\n\n` +
            `Because **1 VC XP = one credited 10-minute segment**, level 10 takes **26h 40m**, level 20 takes **91h 40m**, and level 30 takes **232h 30m**.\n\n` +
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

async function creditVoiceTimeForGuild(guild, db, now = new Date()) {
    const memberIds = eligibleVoiceMemberIds(guild);
    const bucketMs = VOICE_CREDIT_MINUTES * 60 * 1000;
    const tickBucket = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);

    return db.begin(async transaction => {
        const tickRows = await transaction`
            insert into vc_level_ticks (guild_id, tick_bucket)
            values (${guild.id}, ${tickBucket})
            on conflict (guild_id, tick_bucket) do nothing
            returning tick_bucket
        `;

        if (tickRows.length === 0) {
            return {
                credits: [],
                credited: 0,
                levelUps: [],
                skippedDuplicate: true
            };
        }

        if (memberIds.length === 0) {
            return {
                credits: [],
                credited: 0,
                levelUps: [],
                skippedDuplicate: false
            };
        }

        const values = memberIds.map(discordId => ({
            guild_id: guild.id,
            discord_id: discordId,
            voice_minutes: VOICE_CREDIT_MINUTES,
            voice_xp: VOICE_CREDIT_XP
        }));
        const updatedRows = await transaction`
            insert into vc_levels ${transaction(values, 'guild_id', 'discord_id', 'voice_minutes', 'voice_xp')}
            on conflict (guild_id, discord_id) do update
            set
                voice_minutes = vc_levels.voice_minutes + excluded.voice_minutes,
                voice_xp = vc_levels.voice_xp + excluded.voice_xp,
                updated_at = now()
            returning discord_id, voice_minutes::text, voice_xp::text
        `;
        const levelUps = updatedRows.flatMap(row => {
            const newXp = Number(row.voice_xp);
            const oldLevel = levelForXp(newXp - VOICE_CREDIT_XP);
            const newLevel = levelForXp(newXp);

            return newLevel > oldLevel
                ? [{
                    discordId: row.discord_id,
                    oldLevel,
                    newLevel,
                    voiceMinutes: Number(row.voice_minutes),
                    voiceXp: newXp
                }]
                : [];
        });
        const credits = updatedRows.map(row => ({
            discordId: row.discord_id,
            voiceMinutes: Number(row.voice_minutes),
            voiceXp: Number(row.voice_xp),
            level: levelForXp(row.voice_xp)
        }));

        return {
            credits,
            credited: updatedRows.length,
            levelUps,
            skippedDuplicate: false
        };
    });
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
            value: `Credited ${result.credited} member(s) +${VOICE_CREDIT_XP} VC XP and +${VOICE_CREDIT_MINUTES} minutes each.`
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
                        `+${VOICE_CREDIT_XP} XP, +${VOICE_CREDIT_MINUTES} min | ` +
                        `total ${credit.voiceXp} XP, ${formatVoiceTime(credit.voiceMinutes)} | ` +
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
                `Tracked call time: **${formatVoiceTime(levelUp.voiceMinutes)}**\n\n` +
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
    VOICE_CREDIT_XP,
    creditVoiceTimeForGuild,
    eligibleVoiceMemberIds,
    ensureVoiceLevelInfoBoard,
    formatVoiceTime,
    levelForXp,
    postVoiceXpModLogs,
    postVoiceLevelUps,
    setVoiceXpModLogging,
    voiceLevelInfoPayload,
    voiceProgress,
    voiceXpModLoggingEnabled,
    xpForLevel
};
