const {
    SlashCommandBuilder,
    AttachmentBuilder,
    MessageFlags
} = require('discord.js');
const crypto = require('crypto');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    renderRecruitTreeImage
} = require('../utils/treeImage.js');

function playerName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

const GRAPH_CACHE_VERSION = 1;
const MAX_GRAPH_CACHE_ENTRIES = 50;
const GRAPH_FRESH_RENDER_WAIT_MS = 5_000;
const GRAPH_CHANNEL_ID =
    process.env.GRAPH_CHANNEL_ID || '1512671910712840192';
const graphImageCache = new Map();
const graphRenderPromises = new Map();
const graphLatestFingerprints = new Map();

function graphCacheFingerprint(root, recruits) {
    const graphState = {
        version: GRAPH_CACHE_VERSION,
        root: pickGraphPlayerFields(root),
        recruits: recruits.map(pickGraphPlayerFields)
    };

    return crypto
        .createHash('sha256')
        .update(JSON.stringify(graphState))
        .digest('hex');
}

function pickGraphPlayerFields(player) {
    return {
        discord_id: player.discord_id,
        discord_username: player.discord_username,
        discord_display_name: player.discord_display_name,
        minecraft_ign: player.minecraft_ign,
        rank_name: player.rank_name,
        parent_discord_id: player.parent_discord_id,
        parent_minecraft_ign: player.parent_minecraft_ign,
        parent_display_name: player.parent_display_name,
        parent_username: player.parent_username,
        depth: player.depth
    };
}

function getCachedGraphEntry(cacheKey) {
    const cached = graphImageCache.get(cacheKey);

    if (!cached) {
        return null;
    }

    graphImageCache.delete(cacheKey);
    graphImageCache.set(cacheKey, cached);
    return cached;
}

function setCachedGraphImage(cacheKey, fingerprint, imageBuffer) {
    graphImageCache.set(cacheKey, {
        fingerprint,
        imageBuffer
    });

    while (graphImageCache.size > MAX_GRAPH_CACHE_ENTRIES) {
        const oldestKey = graphImageCache.keys().next().value;
        graphImageCache.delete(oldestKey);
    }
}

function renderAndCacheGraph(cacheKey, fingerprint, root, recruits) {
    const renderKey = `${cacheKey}:${fingerprint}`;
    const existingRender = graphRenderPromises.get(renderKey);

    if (existingRender) {
        return existingRender;
    }

    const renderPromise = renderRecruitTreeImage(root, recruits)
        .then(imageBuffer => {
            if (graphLatestFingerprints.get(cacheKey) === fingerprint) {
                setCachedGraphImage(cacheKey, fingerprint, imageBuffer);
            }

            return imageBuffer;
        })
        .finally(() => {
            if (graphRenderPromises.get(renderKey) === renderPromise) {
                graphRenderPromises.delete(renderKey);
            }
        });

    graphRenderPromises.set(renderKey, renderPromise);
    return renderPromise;
}

async function waitForFreshGraph(renderPromise, timeoutMs) {
    const timeout = Symbol('graph-render-timeout');
    let timeoutId;

    try {
        const result = await Promise.race([
            renderPromise,
            new Promise(resolve => {
                timeoutId = setTimeout(() => resolve(timeout), timeoutMs);
            })
        ]);

        return result === timeout ? null : result;
    } finally {
        clearTimeout(timeoutId);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('graph')
        .setDescription('Show a visual Penguin Mafia recruit graph for a player.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player whose recruit graph you want to see. Defaults to yourself.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const playerUser = interaction.options.getUser('player') || interaction.user;

        try {
            const rootRows = await sql`
                select
                    child.discord_id,
                    child.discord_username,
                    child.discord_display_name,
                    child.minecraft_ign,
                    child.rank_name,
                    child.parent_discord_id,
                    parent.minecraft_ign as parent_minecraft_ign,
                    parent.discord_display_name as parent_display_name,
                    parent.discord_username as parent_username
                from players child
                left join players parent
                    on child.parent_discord_id = parent.discord_id
                where child.discord_id = ${playerUser.id}
                limit 1
            `;

            if (rootRows.length === 0) {
                await interaction.editReply(
                    `❌ ${playerUser} is not in the database yet.`
                );
                return;
            }

            const root = rootRows[0];

            const recruits = await sql`
                with recursive descendants as (
                    select
                        discord_id,
                        discord_username,
                        discord_display_name,
                        minecraft_ign,
                        rank_name,
                        parent_discord_id,
                        1 as depth
                    from players
                    where parent_discord_id = ${playerUser.id}
                        and welcome_completed = true

                    union all

                    select
                        p.discord_id,
                        p.discord_username,
                        p.discord_display_name,
                        p.minecraft_ign,
                        p.rank_name,
                        p.parent_discord_id,
                        descendants.depth + 1 as depth
                    from players p
                    join descendants
                        on p.parent_discord_id = descendants.discord_id
                    where p.welcome_completed = true
                )
                select *
                from descendants
                order by depth asc, discord_display_name asc
            `;

            const directRecruiter =
                root.parent_minecraft_ign ||
                root.parent_display_name ||
                root.parent_username ||
                'None / Orphan';
            const fingerprint = graphCacheFingerprint(root, recruits);
            const cacheKey = root.discord_id;
            graphLatestFingerprints.set(cacheKey, fingerprint);
            const cachedEntry = getCachedGraphEntry(cacheKey);
            const exactCacheHit = cachedEntry?.fingerprint === fingerprint;
            let imageBuffer = exactCacheHit
                ? cachedEntry.imageBuffer
                : null;
            let staleCacheShown = false;

            if (exactCacheHit) {
                console.log(`Graph cache hit for ${playerUser.tag || playerUser.id} (${playerUser.id}).`);
            } else {
                const renderPromise = renderAndCacheGraph(
                    cacheKey,
                    fingerprint,
                    root,
                    recruits
                );

                if (cachedEntry) {
                    imageBuffer = await waitForFreshGraph(
                        renderPromise,
                        GRAPH_FRESH_RENDER_WAIT_MS
                    );

                    if (!imageBuffer) {
                        imageBuffer = cachedEntry.imageBuffer;
                        staleCacheShown = true;
                        console.log(
                            `Graph refresh exceeded ${GRAPH_FRESH_RENDER_WAIT_MS}ms for ` +
                            `${playerUser.tag || playerUser.id} (${playerUser.id}); showing stale cache.`
                        );

                        renderPromise
                            .then(() => {
                                console.log(
                                    `Graph background refresh completed for ` +
                                    `${playerUser.tag || playerUser.id} (${playerUser.id}).`
                                );
                            })
                            .catch(error => {
                                console.error(
                                    `Graph background refresh failed for ` +
                                    `${playerUser.tag || playerUser.id} (${playerUser.id}):`
                                );
                                console.error(error);
                            });
                    }
                } else {
                    imageBuffer = await renderPromise;
                }
            }

            const attachment = new AttachmentBuilder(imageBuffer, {
                name: 'penguin-mafia-recruit-graph.png'
            });
            const largeTreeNotice = recruits.length > 49
                ? '\nLarge tree: biggest branches are shown as cards, with remaining recruits grouped as iceberg dot clusters.'
                : '';
            const staleCacheNotice = staleCacheShown
                ? '\n⚡ A cached snapshot is shown because the updated graph took longer than 5 seconds. The refreshed version is being cached for next time.'
                : '';

            const content =
                `🐧 **Recruit Graph: ${playerName(root, playerUser.username)}**\n` +
                `Direct recruiter: \`${directRecruiter}\`\n` +
                `Total recruits: **${recruits.length}**${largeTreeNotice}${staleCacheNotice}`;

            const graphChannel = interaction.guild.channels.cache.get(GRAPH_CHANNEL_ID) ||
                (await interaction.guild.channels.fetch(GRAPH_CHANNEL_ID).catch(() => null));

            if (!graphChannel?.isTextBased()) {
                await interaction.editReply(
                    `❌ The configured graph channel <#${GRAPH_CHANNEL_ID}> could not be found or is not a text channel.`
                );
                return;
            }

            const graphMessage = await graphChannel.send({
                content,
                files: [attachment]
            });

            await interaction.editReply(
                `✅ Graph posted in <#${graphChannel.id}>.\n` +
                `[Open Graph](${graphMessage.url})`
            );
        } catch (error) {
            logCommandError(interaction, '/graph', error);

            await interaction.editReply(
                `❌ **Graph command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
