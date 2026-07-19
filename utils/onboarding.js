const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ModalBuilder,
    OverwriteType,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    DEFAULT_RANK_NAME,
    ensureRankRoles,
    ensureWelcomeCategory,
    syncMemberRankRole
} = require('./bootstrap.js');
const {
    formatDonationAmount
} = require('./donations.js');
const {
    enterAllActiveGiveawaysForUser
} = require('./giveaways.js');
const {
    renderRecruitTreeImage
} = require('./treeImage.js');
const {
    setMemberNicknameToIgn
} = require('./nicknames.js');
const {
    donDiscordIds
} = require('./staff.js');

const BUTTON_PREFIX = 'welcome';
const MODAL_PREFIX = 'welcome_ign_submit';
const JOIN_ALL_MODAL_PREFIX = 'welcome_join_all_ign';
const WELCOME_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const WELCOME_SELF_DESTRUCT_SECONDS = 30;
const CLICK_HERE_PROMPT = '# CLICK BELOW';
const CLICK_HERE_COMPONENT_ID = `${BUTTON_PREFIX}:click_here_label`;

const welcomeGraphCache = new Map();

pregenerateAllGraphs();

async function pregenerateAllGraphs() {
    const stages = [
        ['soldier', directRecruitSimulation, [0]],
        ['direct-1', directRecruitSimulation, [1]],
        ['direct-2', directRecruitSimulation, [2]],
        ['direct-3', directRecruitSimulation, [3]],
        ['general-1', generalSimulation, [1]],
        ['general-2', generalSimulation, [2]],
        ['general-3', generalSimulation, [3]],
        ['emperor-1', emperorSimulation, [1]],
        ['emperor-2', emperorSimulation, [2]],
    ];

    const results = await Promise.allSettled(stages.map(async ([stageName, simFn, args]) => {
        if (welcomeGraphCache.has(stageName)) return;
        const sim = simFn(null, 'welcome-root', ...args);
        const imageBuffer = await renderRecruitTreeImage(sim.root, sim.recruits);
        welcomeGraphCache.set(stageName, new AttachmentBuilder(imageBuffer, {
            name: `welcome-${stageName}-graph.png`
        }));
    }));

    for (const result of results) {
        if (result.status === 'rejected') {
            console.error('Failed to pre-generate welcome graph:', result.reason);
        }
    }
}

function buttonId(action, userId, isTest = false) {
    return `${BUTTON_PREFIX}:${action}:${userId}:${isTest ? 'test' : 'live'}`;
}

function ignModalId(userId, edition, isTest = false) {
    return `${MODAL_PREFIX}:${userId}:${edition}:${isTest ? 'test' : 'live'}`;
}

function joinAllIgnModalId(userId, edition, isTest = false) {
    return `${JOIN_ALL_MODAL_PREFIX}:${userId}:${edition}:${isTest ? 'test' : 'live'}`;
}

function minecraftEditionLabel(edition) {
    return edition === 'bedrock' ? 'Bedrock' : 'Java';
}

function scopedButton(action, userId, label, style = ButtonStyle.Primary, isTest = false) {
    return new ButtonBuilder()
        .setCustomId(buttonId(action, userId, isTest))
        .setLabel(label)
        .setStyle(style);
}

function row(...components) {
    return new ActionRowBuilder().addComponents(...components);
}

function clickHereRow() {
    return row(
        new ButtonBuilder()
            .setCustomId(CLICK_HERE_COMPONENT_ID)
            .setLabel('CLICK BELOW')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true)
    );
}

function withClickHerePrompt(message) {
    if (!message.components?.length || message.content.includes(CLICK_HERE_PROMPT)) {
        return message;
    }

    return {
        ...message,
        content: `${message.content}\n\n${CLICK_HERE_PROMPT}`
    };
}

function withClickHereComponent(message) {
    if (!message.components?.length) {
        return message;
    }

    const hasClickHereComponent = message.components.some(actionRow => {
        return actionRow.components.some(component => component.data?.custom_id === CLICK_HERE_COMPONENT_ID);
    });

    if (hasClickHereComponent) {
        return message;
    }

    return {
        ...message,
        components: [
            clickHereRow(),
            ...message.components
        ]
    };
}

function normalizeWelcomePayload(interaction, message) {
    const payload = {
        ...message
    };

    if (payload.files || interaction.message?.attachments?.size) {
        payload.attachments = [];
    }

    return payload;
}

async function updateWithReadingDelay(interaction, message) {
    await interaction.deferUpdate();

    const resolvedMessage = typeof message === 'function'
        ? await message()
        : await message;

    await interaction.editReply(normalizeWelcomePayload(interaction, resolvedMessage));
}

function sanitizeChannelName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28) || 'new-penguin';
}

function welcomeChannelTopic(userId) {
    return `Penguin Mafia onboarding:${userId}`;
}

function escapeDiscordMarkdown(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/([*_`~|])/g, '\\$1');
}

function memberDisplayName(member) {
    return escapeDiscordMarkdown(member?.displayName || member?.user?.globalName || member?.user?.username || 'new penguin');
}

async function resolveGrandRecruiterId(recruiterId) {
    if (!recruiterId) {
        return null;
    }

    const rows = await sql`
        select parent_discord_id
        from players
        where discord_id = ${recruiterId}
        limit 1
    `;

    return rows[0]?.parent_discord_id || null;
}

function isWelcomeFlowMessage(message, userId) {
    if (message.author.id !== message.client.user.id) {
        return false;
    }

    const hasWelcomeButton = message.components.some(actionRow => {
        return actionRow.components.some(component => {
            return component.customId?.startsWith(`${BUTTON_PREFIX}:`) &&
                component.customId.includes(`:${userId}:live`);
        });
    });

    if (hasWelcomeButton) {
        return true;
    }

    return message.content.includes('PENGUIN MAFIA') &&
        message.content.includes(userId);
}

function introMessage(member, context = {}) {
    const helperMentions = [context.recruiterId, context.grandRecruiterId]
        .filter(Boolean);
    const safeInviterDisplayName = escapeDiscordMarkdown(context.inviterDisplayName || 'your recruiter');
    const parentLine = context.inviterDisplayName
        ? `Our bots detected ${context.recruiterId ? `<@${context.recruiterId}>` : `**${safeInviterDisplayName}**`} as your recruiter. They${context.grandRecruiterId ? ` and <@${context.grandRecruiterId}>` : ''} can see this room and help if you get stuck.`
        : `No recruiter was detected for this join. If someone invited you, use \`/join recruiter:@TheirDiscord\` after this tutorial.`;
    const isTest = Boolean(context.isTest);

    return withClickHerePrompt({
        content:
            `# 🐧 Welcome to the Penguin Mafia\n\n` +
            `This welcome room is for **${memberDisplayName(member)}** ${member}.\n\n` +
            `Here you can:\n\n` +
            `• **Buy and sell spawners**\n` +
            `• **Win giveaways**\n` +
            `• **Build a team**\n\n` +
            `Penguin skins are **encouraged**, but they are **not required**. 🐧\n\n` +
            `${parentLine}\n\n` +
            `Tap below to start the tutorial.`,
        allowedMentions: {
            users: [member.id, ...helperMentions],
            parse: []
        },
        components: [
            row(scopedButton('rank_graph', member.id, 'Start Tutorial', ButtonStyle.Success, isTest))
        ]
    });
}

function simulatedWelcomePlayer(id, name, rankName, parentId = null) {
    return {
        discord_id: id,
        discord_username: name,
        discord_display_name: name,
        minecraft_ign: name,
        rank_name: rankName,
        parent_discord_id: parentId
    };
}

function welcomeRootName() {
    return 'You';
}

function welcomeRoot(member, userId, rankName) {
    return simulatedWelcomePlayer(
        userId || member?.id || member?.user?.id || 'welcome-root',
        welcomeRootName(member),
        rankName
    );
}

function directRecruitSimulation(member, userId, recruitCount) {
    const isCaptain = recruitCount >= 3;
    const root = welcomeRoot(member, userId, isCaptain ? 'Penguin Captain' : DEFAULT_RANK_NAME);
    const recruits = [];

    for (let index = 1; index <= recruitCount; index++) {
        recruits.push(simulatedWelcomePlayer(
            `welcome-direct-${index}`,
            `Recruit ${index}`,
            DEFAULT_RANK_NAME,
            root.discord_id
        ));
    }

    return {
        root,
        recruits
    };
}

function generalSimulation(member, userId, captainCount) {
    const isGeneral = captainCount >= 3;
    const root = welcomeRoot(member, userId, isGeneral ? 'Penguin General' : 'Penguin Captain');
    const recruits = [];

    for (let index = 1; index <= 3; index++) {
        const trained = index <= captainCount;
        const directRecruitId = `welcome-general-direct-${index}`;

        recruits.push(simulatedWelcomePlayer(
            directRecruitId,
            `Recruit ${index}`,
            trained ? 'Penguin Captain' : DEFAULT_RANK_NAME,
            root.discord_id
        ));

        if (trained) {
            for (let childIndex = 1; childIndex <= 3; childIndex++) {
                recruits.push(simulatedWelcomePlayer(
                    `welcome-general-${index}-${childIndex}`,
                    `Recruit ${index}.${childIndex}`,
                    DEFAULT_RANK_NAME,
                    directRecruitId
                ));
            }
        }
    }

    return {
        root,
        recruits
    };
}

function emperorSimulation(member, userId, generalCount) {
    const isEmperor = generalCount >= 2;
    const root = welcomeRoot(member, userId, isEmperor ? 'Emperor Penguin' : 'Penguin General');
    const recruits = [];

    for (let index = 1; index <= 3; index++) {
        const isGeneral = index <= generalCount;
        const directRecruitId = `welcome-emperor-direct-${index}`;

        recruits.push(simulatedWelcomePlayer(
            directRecruitId,
            `Recruit ${index}`,
            isGeneral ? 'Penguin General' : 'Penguin Captain',
            root.discord_id
        ));

        for (let childIndex = 1; childIndex <= 3; childIndex++) {
            const captainId = `welcome-emperor-${index}-${childIndex}`;

            recruits.push(simulatedWelcomePlayer(
                captainId,
                `Recruit ${index}.${childIndex}`,
                isGeneral ? 'Penguin Captain' : DEFAULT_RANK_NAME,
                directRecruitId
            ));

            if (isGeneral) {
                for (let recruitIndex = 1; recruitIndex <= 3; recruitIndex++) {
                    recruits.push(simulatedWelcomePlayer(
                        `welcome-emperor-${index}-${childIndex}-${recruitIndex}`,
                        `Recruit ${index}.${childIndex}.${recruitIndex}`,
                        DEFAULT_RANK_NAME,
                        captainId
                    ));
                }
            }
        }
    }

    return {
        root,
        recruits
    };
}

async function welcomeGraphAttachment(stageName, simulation) {
    const cached = welcomeGraphCache.get(stageName);
    if (cached) return cached;

    const imageBuffer = await renderRecruitTreeImage(simulation.root, simulation.recruits);
    const attachment = new AttachmentBuilder(imageBuffer, {
        name: `welcome-${stageName}-graph.png`
    });

    welcomeGraphCache.set(stageName, attachment);
    return attachment;
}

async function withWelcomeGraph(stageName, simulation, message) {
    return {
        ...withClickHereComponent(message),
        files: [
            await welcomeGraphAttachment(stageName, simulation)
        ]
    };
}

async function rankIntroMessage(member, userId, isTest = false) {
    return withWelcomeGraph('soldier', directRecruitSimulation(member, userId, 0), {
        content:
            `# 1️⃣ Your first rank\n\n` +
            `Your first rank is **${DEFAULT_RANK_NAME}**.\n\n` +
            `You start with a base commission rate of **40%**.\n\n` +
            `Your first upgrade is **Penguin Captain**, which starts when you build your team.`,
        components: [
            row(scopedButton('direct_recruit_1', userId, 'Add Recruit 1', ButtonStyle.Success, isTest))
        ]
    });
}

async function directRecruitMessage(member, userId, recruitCount, isTest = false) {
    const isCaptain = recruitCount >= 3;

    return withWelcomeGraph(`direct-${recruitCount}`, directRecruitSimulation(member, userId, recruitCount), {
        content:
            `# 2️⃣ Let’s add recruits to your team\n\n` +
            (
                isCaptain
                    ? `When you get **3 direct recruits**, you become a **Penguin Captain** and your commission rate becomes **60%**.`
                    : `Recruit ${recruitCount} joined your team. Add the next recruit to keep climbing.`
            ),
        components: [
            row(
                isCaptain
                    ? scopedButton('general_train_1', userId, 'Help Recruit 1 Reach Captain', ButtonStyle.Success, isTest)
                    : scopedButton(`direct_recruit_${recruitCount + 1}`, userId, `Add Recruit ${recruitCount + 1}`, ButtonStyle.Success, isTest)
            )
        ]
    });
}

async function generalTrainingMessage(member, userId, captainCount, isTest = false) {
    const isGeneral = captainCount >= 3;

    return withWelcomeGraph(`general-${captainCount}`, generalSimulation(member, userId, captainCount), {
        content:
            `# 3️⃣ Help your recruits build their teams\n\n` +
            (
                isGeneral
                    ? `Once you train **3 direct recruits** to reach **Captain**, you become a **Penguin General** with an **80%** commission rate.`
                    : `Recruit ${captainCount} just reached **Penguin Captain**. Keep training the next direct recruit.`
            ),
        components: [
            row(
                isGeneral
                    ? scopedButton('emperor_train_1', userId, 'Train a General', ButtonStyle.Success, isTest)
                    : scopedButton(`general_train_${captainCount + 1}`, userId, `Help Recruit ${captainCount + 1} Reach Captain`, ButtonStyle.Success, isTest)
            )
        ]
    });
}

async function emperorTrainingMessage(member, userId, generalCount, isTest = false) {
    const isEmperor = generalCount >= 2;

    return withWelcomeGraph(`emperor-${generalCount}`, emperorSimulation(member, userId, generalCount), {
        content:
            `# 4️⃣ The Emperor path\n\n` +
            (
                isEmperor
                    ? `If you manage to make it this far, you’ve done something right. **Emperor Penguin** is the highest rank. Once you train **2 direct recruits** to become **General**, you earn **Emperor Penguin**.`
                    : `Recruit ${generalCount} became a **Penguin General** because their Captains built teams too. Train one more General to reach the top.`
            ),
        components: [
            row(
                isEmperor
                    ? scopedButton('why_team', userId, 'Why Build a Large Team?', ButtonStyle.Success, isTest)
                    : scopedButton(`emperor_train_${generalCount + 1}`, userId, 'Train One More General', ButtonStyle.Success, isTest)
            )
        ]
    });
}

function whyTeamMessage(userId, isTest = false) {
    return withClickHerePrompt({
        content:
            `# 5️⃣ Why do we want a large team?\n\n` +
            `If any teammate under you:\n\n` +
            `• Wins a **giveaway**\n` +
            `• Earns the **daily recruit bonus**\n` +
            `• Earns money from **spawner trading**\n\n` +
            `You can earn a portion through your commission chain.\n\n` +
            `That is the point of building a strong tree: when your team wins, the whole branch can eat.`,
        components: [
            row(scopedButton('giveaway_prompt', userId, 'Continue', ButtonStyle.Success, isTest))
        ]
    });
}

async function activeGiveawaySummary(guild) {
    const rows = await sql`
        select
            count(*)::int as active_count,
            coalesce(sum(amount), 0)::bigint as total_amount
        from giveaways
        where guild_id = ${guild.id}
            and status = 'active'
            and ends_at > now()
    `;

    return rows[0] || {
        active_count: 0,
        total_amount: 0n
    };
}

async function giveawayJoinPromptMessage(guild, userId, isTest = false) {
    const summary = await activeGiveawaySummary(guild);
    const activeCount = Number(summary.active_count || 0);
    const totalAmount = BigInt(summary.total_amount || 0);
    const giveawayLine = activeCount > 0
        ? `There ${activeCount === 1 ? 'is' : 'are'} currently **${activeCount}** active giveaway${activeCount === 1 ? '' : 's'} with **${formatDonationAmount(totalAmount)}** in prize pools.`
        : `There are no active giveaways right now, but this is where new active giveaways will appear.`;

    return withClickHerePrompt({
        content:
            `# 6️⃣ Active giveaways\n\n` +
            `${giveawayLine}\n\n` +
            `Do you want to join all active giveaways at once?`,
        components: [
            row(
                scopedButton('giveaway_join_all_yes', userId, 'Yes', ButtonStyle.Success, isTest),
                scopedButton('giveaway_join_all_no', userId, 'No', ButtonStyle.Secondary, isTest)
            )
        ]
    });
}

function joinAllGiveawaysInfoMessage(userId, isTest = false) {
    return withClickHerePrompt({
        content:
            `# 💰 Instant giveaway payouts\n\n` +
            `Our giveaways are hosted by players in the community, and the best part is that we have **instant payouts**.\n\n` +
            `Please give us your Minecraft IGN and edition so we can pay you if you win. After you link here, you will automatically be entered into all active giveaways you are eligible for.\n\n` +
            `If you do not give us your IGN now, we can still handle payout manually later, but it will be slower.`,
        components: [
            row(
                scopedButton('join_all_ign_java', userId, 'Java', ButtonStyle.Success, isTest),
                scopedButton('join_all_ign_bedrock', userId, 'Bedrock', ButtonStyle.Success, isTest),
                scopedButton('join_all_skip', userId, 'Skip', ButtonStyle.Secondary, isTest)
            )
        ]
    });
}

function finalMessage(userId, linkedIgn = null, edition = null, options = {}) {
    const linkedLine = linkedIgn
        ? `✅ Linked account: **${linkedIgn}**${edition ? ` (${minecraftEditionLabel(edition)})` : ''}`
        : (options.skipMessage || `⏭️ IGN skipped. Use \`/penguinlink\` later for faster payouts.`);
    const giveawayLine = options.giveawayEntryResult
        ? `\n🎉 Entered **${options.giveawayEntryResult.inserted_count}** new active giveaway${options.giveawayEntryResult.inserted_count === 1 ? '' : 's'} out of **${options.giveawayEntryResult.eligible_count}** eligible.`
        : (options.giveawaySkippedLine ? `\n${options.giveawaySkippedLine}` : '');

    return {
        content:
            `# 🐧 Tutorial complete\n\n` +
            `You've completed the tutorial. **Welcome to the Penguin Mafia!**\n\n` +
            `${linkedLine}${giveawayLine}\n\n` +
            `🎖️ Rank ready: **${DEFAULT_RANK_NAME}**\n\n` +
            `Use \`/graph\` to view your recruit tree at any time.`,
        components: []
    };
}

async function scheduleWelcomeChannelDelete(interaction, seconds = WELCOME_SELF_DESTRUCT_SECONDS) {
    const channel = interaction.channel;

    let countdownMessage = null;

    try {
        countdownMessage = await interaction.followUp({
            content: `💣🐧 This secret penguin training room will self destruct in **${seconds}**...`,
            fetchReply: true
        });
    } catch (error) {
        console.error(`Failed to start welcome channel countdown in ${channel?.id || 'unknown'}:`);
        console.error(error);
    }

    for (let remaining = seconds - 1; remaining >= 1; remaining--) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!countdownMessage) continue;

        try {
            await countdownMessage.edit({
                content: `💣🐧 This secret penguin training room will self destruct in **${remaining}**...`
            });
        } catch {
            countdownMessage = null;
        }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    setTimeout(async () => {
        try {
            if (channel?.deletable) {
                await channel.delete('Penguin Mafia welcome flow completed');
            }
        } catch (error) {
            console.error(`Failed to delete welcome channel ${channel?.id || 'unknown'}:`);
            console.error(error);
        }
    }, 1_000);
}

async function getOnboardingChannels(guild, context = {}) {
    if (context.channelCache) {
        return context.channelCache;
    }

    return guild.channels.fetch();
}

function rememberOnboardingChannel(context, channel) {
    if (context.channelCache && channel) {
        context.channelCache.set(channel.id, channel);
    }
}

async function ensureWelcomeChannel(member, context = {}) {
    const guild = member.guild;
    const channels = await getOnboardingChannels(guild, context);
    const topic = welcomeChannelTopic(member.id);
    const grandRecruiterId = context.grandRecruiterId !== undefined
        ? context.grandRecruiterId
        : await resolveGrandRecruiterId(context.recruiterId);
    let channel = channels.find(existingChannel => {
        return existingChannel?.type === ChannelType.GuildText && existingChannel.topic === topic;
    });

    const category = await ensureWelcomeCategory(guild, {
        channelCache: context.channelCache,
        requireAvailableSlot: true
    });
    const permissionOverwrites = [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel
            ]
        },
        {
            id: member.id,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
            ]
        }
    ];

    const addMemberOverwrite = (userId, allow) => {
        if (!userId || permissionOverwrites.some(overwrite => overwrite.id === userId)) {
            return;
        }

        permissionOverwrites.push({
            id: userId,
            type: OverwriteType.Member,
            allow
        });
    };

    addMemberOverwrite(context.recruiterId, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
    ]);
    addMemberOverwrite(grandRecruiterId, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
    ]);

    for (const donDiscordId of donDiscordIds()) {
        addMemberOverwrite(donDiscordId, [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages
        ]);
    }

    if (!channel) {
        channel = await guild.channels.create({
            name: `🐧-welcome-${sanitizeChannelName(member.user.username)}`,
            type: ChannelType.GuildText,
            parent: category.id,
            topic,
            permissionOverwrites,
            reason: 'Penguin Mafia private welcome onboarding'
        });
        rememberOnboardingChannel(context, channel);
    } else {
        await channel.permissionOverwrites.set(
            permissionOverwrites,
            'Penguin Mafia private welcome onboarding permissions'
        );
    }

    return channel;
}

async function sendWelcomeReminderIfDue(member, channel) {
    const rows = await sql`
        select welcome_completed, welcome_reminder_sent_at
        from players
        where discord_id = ${member.id}
        limit 1
    `;
    const player = rows[0];

    if (!player || player.welcome_completed) {
        return false;
    }

    const lastReminderAt = player.welcome_reminder_sent_at
        ? new Date(player.welcome_reminder_sent_at).getTime()
        : 0;

    if (lastReminderAt && Date.now() - lastReminderAt < WELCOME_REMINDER_INTERVAL_MS) {
        return false;
    }

    const channelLink = `https://discord.com/channels/${member.guild.id}/${channel.id}`;

    try {
        await member.send({
            content:
                `🐧 Hey! You still need to finish your **Penguin Mafia** welcome setup.\n\n` +
                `Please go to ${channel} and press **Next** until you finish.\n\n` +
                `Direct link: ${channelLink}\n\n` +
                `Once you complete it, you’ll get your **${DEFAULT_RANK_NAME}** role and full server access.`
        });

        await sql`
            update players
            set
                welcome_reminder_sent_at = now(),
                updated_at = now()
            where discord_id = ${member.id}
        `;

        console.log(`Welcome reminder DM sent to ${member.user.tag} for ${channel.name} (${channel.id}).`);
        return true;
    } catch (error) {
        console.log(`Could not DM welcome reminder to ${member.user.tag}: ${error.message}`);
        return false;
    }
}

async function startOnboardingForMember(member, context = {}) {
    const channel = await ensureWelcomeChannel(member, context);
    const isTest = Boolean(context.isTest);
    const grandRecruiterId = context.grandRecruiterId !== undefined
        ? context.grandRecruiterId
        : await resolveGrandRecruiterId(context.recruiterId);
    const recentMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const alreadyStarted = recentMessages?.some(message => {
        return isWelcomeFlowMessage(message, member.id);
    });

    if (alreadyStarted && !isTest) {
        return channel;
    }

    await channel.send(introMessage(member, {
        ...context,
        grandRecruiterId
    }));
    return channel;
}

async function remindIncompleteWelcomeMembers(guild) {
    const rows = await sql`
        select discord_id, parent_discord_id
        from players
        where welcome_completed = false
            and (
                welcome_reminder_sent_at is null
                or welcome_reminder_sent_at <= now() - interval '2 days'
            )
    `;

    if (rows.length === 0) {
        return {
            checked: 0,
            sent: 0
        };
    }

    const channelCache = await guild.channels.fetch();
    let sent = 0;

    for (const player of rows) {
        const member = await guild.members.fetch(player.discord_id).catch(() => null);

        if (!member || member.user.bot) {
            continue;
        }

        const channel = await ensureWelcomeChannel(member, {
            channelCache,
            recruiterId: player.parent_discord_id
        });
        const reminderSent = await sendWelcomeReminderIfDue(member, channel);

        if (reminderSent) {
            sent++;
        }
    }

    return {
        checked: rows.length,
        sent
    };
}

async function cleanupWelcomeChannelsForMissingMembers(guild, members) {
    const memberIds = new Set([...members.keys()]);
    const channels = await guild.channels.fetch();
    const staleWelcomeChannels = channels.filter(channel => {
        if (channel?.type !== ChannelType.GuildText) {
            return false;
        }

        const match = String(channel.topic || '').match(/^Penguin Mafia onboarding:(\d{15,25})$/);

        return match && !memberIds.has(match[1]);
    });
    const deletedChannels = [];

    for (const [, channel] of staleWelcomeChannels) {
        try {
            if (!channel.deletable) {
                console.log(`Could not delete stale welcome channel ${channel.name} (${channel.id}): channel is not deletable.`);
                continue;
            }

            await channel.delete('Penguin Mafia stale onboarding cleanup');
            deletedChannels.push(channel);
        } catch (error) {
            console.error(`Could not delete stale welcome channel ${channel.name} (${channel.id}):`);
            console.error(error);
        }
    }

    return deletedChannels;
}

async function cleanupWelcomeChannelForMember(guild, userId) {
    const channels = await guild.channels.fetch();
    const welcomeChannel = channels.find(channel => {
        return channel?.type === ChannelType.GuildText &&
            String(channel.topic || '') === welcomeChannelTopic(userId);
    });

    if (!welcomeChannel) {
        return null;
    }

    try {
        if (!welcomeChannel.deletable) {
            console.log(`Could not delete welcome channel ${welcomeChannel.name} (${welcomeChannel.id}) for ${userId}: channel is not deletable.`);
            return null;
        }

        await welcomeChannel.delete('Penguin Mafia onboarding cleanup for member leave');
        return welcomeChannel;
    } catch (error) {
        console.error(`Could not delete welcome channel ${welcomeChannel.name} (${welcomeChannel.id}) for ${userId}:`);
        console.error(error);
        return null;
    }
}

async function completeOnboarding(member, linkedIgn = null, minecraftEdition = null) {
    await sql`
        update players
        set
            welcome_completed = true,
            minecraft_ign = coalesce(${linkedIgn}, minecraft_ign),
            minecraft_edition = coalesce(${minecraftEdition}, minecraft_edition),
            updated_at = now()
        where discord_id = ${member.id}
    `;

    const { rankRoles } = await ensureRankRoles(member.guild);
    await syncMemberRankRole(member, rankRoles, DEFAULT_RANK_NAME);

    if (linkedIgn) {
        await sql`
            update players
            set
                account_link_reminders_disabled = false,
                account_link_reminder_sent_at = null,
                updated_at = now()
            where discord_id = ${member.id}
        `;

        await setMemberNicknameToIgn(member, linkedIgn);
    }
}

async function saveOnboardingIgn(member, linkedIgn, minecraftEdition) {
    await sql`
        update players
        set
            minecraft_ign = ${linkedIgn},
            minecraft_edition = ${minecraftEdition},
            account_link_reminders_disabled = false,
            updated_at = now()
        where discord_id = ${member.id}
    `;

    return setMemberNicknameToIgn(member, linkedIgn);
}

async function skipOnboardingIgn(userId) {
    await sql`
        update players
        set
            account_link_reminders_disabled = true,
            updated_at = now()
        where discord_id = ${userId}
    `;
}

function buildIgnModal(customId, minecraftEdition) {
    const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle(`Link ${minecraftEditionLabel(minecraftEdition)} IGN`);

    const ignInput = new TextInputBuilder()
        .setCustomId('minecraft_ign')
        .setLabel('Minecraft IGN')
        .setPlaceholder('Example: PenguinBoss123')
        .setMinLength(3)
        .setMaxLength(16)
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder().addComponents(ignInput));
    return modal;
}

function validMinecraftIgn(minecraftIgn) {
    return /^[A-Za-z0-9_]{3,16}$/.test(minecraftIgn);
}

async function respondWithWelcomeFinal(interaction, payload) {
    if (typeof interaction.update === 'function' && interaction.message) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }

        await interaction.editReply(normalizeWelcomePayload(interaction, payload));
        return;
    }

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply(normalizeWelcomePayload(interaction, payload));
        return;
    }

    await interaction.reply(payload);
}

async function finishOnboardingInteraction(interaction, options) {
    const {
        targetUserId,
        isTest,
        linkedIgn = null,
        minecraftEdition = null,
        skipMessage = null,
        giveawaySkippedLine = null,
        enterAllGiveaways = false,
        allowUnlinkedGiveawayEntry = false
    } = options;
    let giveawayEntryResult = null;
    let finalGiveawaySkippedLine = giveawaySkippedLine;

    if (!isTest) {
        const member = await interaction.guild.members.fetch(targetUserId);
        await completeOnboarding(member, linkedIgn, minecraftEdition);

        if (enterAllGiveaways && ((linkedIgn && minecraftEdition) || allowUnlinkedGiveawayEntry)) {
            const entryResult = await enterAllActiveGiveawaysForUser(
                interaction.guild,
                targetUserId,
                sql
            );

            if (entryResult.eligible_count > 0 || entryResult.own_skipped > 0) {
                giveawayEntryResult = entryResult;
            } else {
                finalGiveawaySkippedLine = 'ℹ️ There were no active eligible giveaways to enter right now.';
            }
        }
    } else if (enterAllGiveaways) {
        finalGiveawaySkippedLine = '🧪 Test preview: no giveaways were entered and no rank was assigned.';
    }

    await respondWithWelcomeFinal(
        interaction,
        finalMessage(targetUserId, linkedIgn, minecraftEdition, {
            skipMessage,
            giveawayEntryResult,
            giveawaySkippedLine: finalGiveawaySkippedLine
        })
    );
    await scheduleWelcomeChannelDelete(interaction);
}

async function handleWelcomeButton(interaction) {
    const parts = interaction.customId.split(':');

    if (parts[0] !== BUTTON_PREFIX) return false;

    const action = parts[1];
    const targetUserId = parts[2];
    const isTest = parts[3] === 'test';

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '🐧 This welcome training belongs to another penguin.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (action === 'start' || action === 'rank_graph') {
        await updateWithReadingDelay(interaction, () => rankIntroMessage(interaction.member, targetUserId, isTest));
        return true;
    }

    if (action.startsWith('direct_recruit_')) {
        const recruitCount = Number(action.replace('direct_recruit_', ''));
        await updateWithReadingDelay(interaction, () => directRecruitMessage(interaction.member, targetUserId, recruitCount, isTest));
        return true;
    }

    if (action.startsWith('general_train_')) {
        const captainCount = Number(action.replace('general_train_', ''));
        await updateWithReadingDelay(interaction, () => generalTrainingMessage(interaction.member, targetUserId, captainCount, isTest));
        return true;
    }

    if (action.startsWith('emperor_train_')) {
        const generalCount = Number(action.replace('emperor_train_', ''));
        await updateWithReadingDelay(interaction, () => emperorTrainingMessage(interaction.member, targetUserId, generalCount, isTest));
        return true;
    }

    if (action === 'why_team') {
        await updateWithReadingDelay(interaction, whyTeamMessage(targetUserId, isTest));
        return true;
    }

    if (action === 'giveaway_prompt') {
        const rows = await sql`
            select minecraft_ign, minecraft_edition
            from players
            where discord_id = ${targetUserId}
            limit 1
        `;
        const player = rows[0];

        if (player?.minecraft_ign && player?.minecraft_edition) {
            await finishOnboardingInteraction(interaction, {
                targetUserId,
                isTest,
                linkedIgn: player.minecraft_ign,
                minecraftEdition: player.minecraft_edition,
                enterAllGiveaways: true
            });
            return true;
        }

        await updateWithReadingDelay(interaction, () => giveawayJoinPromptMessage(interaction.guild, targetUserId, isTest));
        return true;
    }

    if (action === 'giveaway_join_all_yes' || action === 'giveaway_pay_yes' || action === 'ign') {
        await updateWithReadingDelay(interaction, joinAllGiveawaysInfoMessage(targetUserId, isTest));
        return true;
    }

    if (action === 'giveaway_join_all_no' || action === 'giveaway_pay_no') {
        if (!isTest) {
            await skipOnboardingIgn(targetUserId);
        }

        await finishOnboardingInteraction(interaction, {
            targetUserId,
            isTest,
            skipMessage: `⏭️ No Minecraft username linked. If you ever want instant giveaway payouts, use \`/penguinlink\`.`,
            giveawaySkippedLine: 'Skipped joining active giveaways from onboarding.'
        });
        return true;
    }

    if (
        action === 'join_all_ign_java' ||
        action === 'join_all_ign_bedrock' ||
        action === 'enter_ign_java' ||
        action === 'enter_ign_bedrock'
    ) {
        const minecraftEdition = action.endsWith('bedrock') ? 'bedrock' : 'java';
        const shouldEnterAll = action.startsWith('join_all_');
        const modalId = shouldEnterAll
            ? joinAllIgnModalId(targetUserId, minecraftEdition, isTest)
            : ignModalId(targetUserId, minecraftEdition, isTest);

        await interaction.showModal(buildIgnModal(modalId, minecraftEdition));
        return true;
    }

    if (action === 'join_all_skip' || action === 'skip_ign' || action === 'skip_ign_later') {
        if (!isTest) {
            await skipOnboardingIgn(targetUserId);
        }

        const shouldEnterAll = action === 'join_all_skip';

        await finishOnboardingInteraction(interaction, {
            targetUserId,
            isTest,
            skipMessage: shouldEnterAll
                ? `⏭️ Username skipped for now. If you win, payout may need to be handled manually and can be slower.`
                : `⏭️ Username skipped for now. You can link it later with \`/penguinlink\`.`,
            giveawaySkippedLine: shouldEnterAll ? null : 'Skipped automatic giveaway entry because no Minecraft account was linked.',
            enterAllGiveaways: shouldEnterAll,
            allowUnlinkedGiveawayEntry: shouldEnterAll
        });
        return true;
    }

    if (action === 'done') {
        const member = await interaction.guild.members.fetch(targetUserId);
        if (!isTest) {
            await completeOnboarding(member);
        }

        await updateWithReadingDelay(interaction, {
            content:
                `# 🐧 WELCOME TO THE PENGUIN MAFIA\n\n` +
                `Training complete. Your **${DEFAULT_RANK_NAME}** role is active. Enter the iceberg. 🧊✨`,
            components: []
        });
        await scheduleWelcomeChannelDelete(interaction);
        return true;
    }

    if (action === 'ranks') {
        await updateWithReadingDelay(interaction, () => directRecruitMessage(interaction.member, targetUserId, 1, isTest));
        return true;
    }

    if (action === 'recruit') {
        await updateWithReadingDelay(interaction, whyTeamMessage(targetUserId, isTest));
        return true;
    }

    if (action === 'account_link_info') {
        await updateWithReadingDelay(interaction, () => giveawayJoinPromptMessage(interaction.guild, targetUserId, isTest));
        return true;
    }

    return false;
}

async function handleWelcomeModal(interaction) {
    const isJoinAllModal = interaction.customId.startsWith(`${JOIN_ALL_MODAL_PREFIX}:`);

    if (!interaction.customId.startsWith(`${MODAL_PREFIX}:`) && !isJoinAllModal) return false;

    const parts = interaction.customId.split(':');
    const targetUserId = parts[1];
    const minecraftEdition = ['java', 'bedrock'].includes(parts[2]) ? parts[2] : null;
    const isTest = ['java', 'bedrock'].includes(parts[2]) ? parts[3] === 'test' : parts[2] === 'test';

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '🐧 This Minecraft IGN form belongs to another penguin.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const minecraftIgn = interaction.fields.getTextInputValue('minecraft_ign').trim();

    if (!validMinecraftIgn(minecraftIgn)) {
        await interaction.reply({
            content:
                `❌ Invalid Minecraft IGN.\n\n` +
                `Minecraft usernames must be 3-16 characters and can only use letters, numbers, and underscores.`,
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (!isTest) {
        console.log(`Welcome IGN link for ${interaction.user.tag}: ${minecraftIgn}${minecraftEdition ? ` (${minecraftEditionLabel(minecraftEdition)})` : ''}. Join-all=${isJoinAllModal ? 'yes' : 'no'}.`);
    }

    await finishOnboardingInteraction(interaction, {
        targetUserId,
        isTest,
        linkedIgn: minecraftIgn,
        minecraftEdition,
        enterAllGiveaways: isJoinAllModal
    });

    return true;
}

module.exports = {
    cleanupWelcomeChannelForMember,
    cleanupWelcomeChannelsForMissingMembers,
    remindIncompleteWelcomeMembers,
    startOnboardingForMember,
    handleWelcomeButton,
    handleWelcomeModal
};
