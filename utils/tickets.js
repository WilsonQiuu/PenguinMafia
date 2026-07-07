const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    OverwriteType,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const {
    STAFF_ROLE_IDS
} = require('./bootstrap.js');
const sql = require('../db.js');
const {
    isDon
} = require('./staff.js');
const {
    formatUser,
    truncateValue
} = require('./modlogs.js');

const TICKET_PANEL_CHANNEL_ID = process.env.TICKET_PANEL_CHANNEL_ID || '1521278851043557578';
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '1521277985636749413';
const TICKET_PANEL_MARKER = 'Penguin Mafia Tickets';
const TICKET_BUTTON_PREFIX = 'ticket_open';
const TICKET_MODAL_PREFIX = 'ticket_modal';
const TICKET_CLOSE_PREFIX = 'ticket_close';
const STAFF_RANK_ORDER = [
    'Trial Mod',
    'Moderator',
    'Sr Moderator',
    'Admin'
];
const closingTicketChannels = new Set();
const creatingTicketKeys = new Set();

const TICKET_COOLDOWN_DAYS = 7;

async function checkTicketCooldown(userId, type) {
    if (type !== 'media' && type !== 'staff') return null;

    const rows = await sql`
        select created_at
        from ticket_cooldowns
        where player_discord_id = ${userId}
            and ticket_type = ${type}
            and created_at > now() - make_interval(days => ${TICKET_COOLDOWN_DAYS})
        limit 1
    `;

    if (rows[0]) {
        const daysLeft = Math.ceil((rows[0].created_at.getTime() + TICKET_COOLDOWN_DAYS * 86400000 - Date.now()) / 86400000);
        return daysLeft;
    }

    return null;
}

async function setTicketCooldown(userId, type) {
    if (type !== 'media' && type !== 'staff') return;

    await sql`
        insert into ticket_cooldowns (player_discord_id, ticket_type, created_at)
        values (${userId}, ${type}, now())
        on conflict (player_discord_id, ticket_type) do update
        set created_at = now()
    `;
}

function staffRoleIdsAtOrAbove(minimumRankName) {
    const minimumRankIndex = STAFF_RANK_ORDER.indexOf(minimumRankName);

    if (minimumRankIndex === -1) {
        return [];
    }

    return STAFF_RANK_ORDER
        .slice(minimumRankIndex)
        .map(rankName => STAFF_ROLE_IDS.get(rankName))
        .filter(Boolean);
}

function memberHasStaffRankAtOrAbove(member, minimumRankName) {
    if (!member) {
        return false;
    }

    if (isDon(member.id)) {
        return true;
    }

    const roleIds = staffRoleIdsAtOrAbove(minimumRankName);

    return roleIds.some(roleId => member.roles.cache.has(roleId));
}

function ticketPanelComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${TICKET_BUTTON_PREFIX}:report`)
                .setLabel('Report an Issue')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`${TICKET_BUTTON_PREFIX}:staff`)
                .setLabel('Apply for Staff')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`${TICKET_BUTTON_PREFIX}:media`)
                .setLabel('Apply for Media')
                .setStyle(ButtonStyle.Success)
        )
    ];
}

function ticketPanelContent() {
    return (
        `🎫 **${TICKET_PANEL_MARKER}**\n\n` +
        `Use the buttons below to open a private ticket or submit an application.\n\n` +
        `• **Report an Issue** — opens a private channel with you and Moderator+.\n` +
        `• **Apply for Staff** — sends your application to Sr Mod+.\n` +
        `• **Apply for Media** — sends your media application to Sr Mod+.`
    );
}

async function ensureTicketPanel(guild) {
    const channel = await guild.channels.fetch(TICKET_PANEL_CHANNEL_ID).catch(() => null);

    if (!channel?.isTextBased?.()) {
        console.warn(`Ticket panel channel was not found by ID ${TICKET_PANEL_CHANNEL_ID}.`);
        return null;
    }

    const messages = await channel.messages.fetch({
        limit: 25
    }).catch(() => null);
    const existingMessage = messages?.find(message => {
        return message.author.id === guild.client.user.id &&
            String(message.content || '').includes(TICKET_PANEL_MARKER);
    });
    const payload = {
        content: ticketPanelContent(),
        components: ticketPanelComponents(),
        allowedMentions: {
            parse: []
        }
    };

    if (existingMessage) {
        await existingMessage.edit(payload);
        return existingMessage;
    }

    return channel.send(payload);
}

function sanitizeChannelName(value) {
    return String(value || 'ticket')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30) || 'ticket';
}

function ticketTopic(type, userId) {
    return `Penguin Mafia ticket:${type}:${userId}`;
}

function ticketKey(type, userId) {
    return `${type}:${userId}`;
}

function ticketTypeLabel(type) {
    if (type === 'report') {
        return 'report ticket';
    }

    if (type === 'media') {
        return 'media application';
    }

    if (type === 'staff') {
        return 'staff application';
    }

    return 'ticket';
}

async function findOpenTicketChannel(guild, type, userId) {
    const topic = ticketTopic(type, userId);
    const cachedChannel = guild.channels.cache.find(channel => {
        return channel?.type === ChannelType.GuildText &&
            channel.parentId === TICKET_CATEGORY_ID &&
            channel.topic === topic;
    });

    if (cachedChannel) {
        return cachedChannel;
    }

    const fetchedChannels = await guild.channels.fetch().catch(() => null);

    if (!fetchedChannels) {
        return null;
    }

    return fetchedChannels.find(channel => {
        return channel?.type === ChannelType.GuildText &&
            channel.parentId === TICKET_CATEGORY_ID &&
            channel.topic === topic;
    }) || null;
}

function existingTicketMessage(type, channel = null) {
    const label = ticketTypeLabel(type);

    if (type === 'report' && channel) {
        return `❌ You already have an open ${label}: ${channel}`;
    }

    return `❌ You already have an open ${label}. Please wait for staff to review it before opening another one.`;
}

async function fetchTicketCategory(guild) {
    const category = await guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null);

    if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error(`Ticket category was not found by ID ${TICKET_CATEGORY_ID}.`);
    }

    return category;
}

function baseTicketPermissions(guild, minimumStaffRankName, includeUserId = null) {
    const permissions = [
        {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [
                PermissionFlagsBits.ViewChannel
            ]
        }
    ];

    const botId = guild.members.me?.id || guild.client.user.id;

    permissions.push({
        id: botId,
        type: OverwriteType.Member,
        allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages
        ]
    });

    if (includeUserId) {
        permissions.push({
            id: includeUserId,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
            ]
        });
    }

    for (const roleId of staffRoleIdsAtOrAbove(minimumStaffRankName)) {
        if (!guild.roles.cache.has(roleId)) {
            continue;
        }

        permissions.push({
            id: roleId,
            type: OverwriteType.Role,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageMessages
            ]
        });
    }

    if (process.env.DON_DISCORD_ID && !permissions.some(overwrite => overwrite.id === process.env.DON_DISCORD_ID)) {
        permissions.push({
            id: process.env.DON_DISCORD_ID,
            type: OverwriteType.Member,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages
            ]
        });
    }

    return permissions;
}

function closeButton(type, ownerId) {
    return new ButtonBuilder()
        .setCustomId(`${TICKET_CLOSE_PREFIX}:${type}:${ownerId}`)
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger);
}

function modalTextInput(customId, label, style = TextInputStyle.Short, required = true) {
    return new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(style === TextInputStyle.Paragraph ? 1000 : 200);
}

function buildReportModal(userId) {
    return new ModalBuilder()
        .setCustomId(`${TICKET_MODAL_PREFIX}:report:${userId}`)
        .setTitle('Report an Issue')
        .addComponents(
            new ActionRowBuilder().addComponents(
                modalTextInput('subject', 'What is the issue?', TextInputStyle.Short)
            ),
            new ActionRowBuilder().addComponents(
                modalTextInput('details', 'Describe what happened', TextInputStyle.Paragraph)
            )
        );
}

function buildMediaModal(userId) {
    return new ModalBuilder()
        .setCustomId(`${TICKET_MODAL_PREFIX}:media:${userId}`)
        .setTitle('Apply for Media')
        .addComponents(
            new ActionRowBuilder().addComponents(
                modalTextInput('accounts', 'Your media accounts', TextInputStyle.Paragraph)
            ),
            new ActionRowBuilder().addComponents(
                modalTextInput('why_media', 'Why should you get Media?', TextInputStyle.Paragraph)
            ),
            new ActionRowBuilder().addComponents(
                modalTextInput('content_plan', 'How will you involve Penguin Mafia?', TextInputStyle.Paragraph)
            )
        );
}

function buildStaffModal(userId) {
    return new ModalBuilder()
        .setCustomId(`${TICKET_MODAL_PREFIX}:staff:${userId}`)
        .setTitle('Apply for Staff')
        .addComponents(
            new ActionRowBuilder().addComponents(
                modalTextInput('age_location', 'Age, location, and timezone', TextInputStyle.Short)
            ),
            new ActionRowBuilder().addComponents(
                modalTextInput('experience', 'Prior server experience', TextInputStyle.Paragraph)
            ),
            new ActionRowBuilder().addComponents(
                modalTextInput('hours', 'Hours per week on the server', TextInputStyle.Short)
            ),
            new ActionRowBuilder().addComponents(
                modalTextInput('slur_response', 'If someone said a racial slur?', TextInputStyle.Paragraph)
            ),
            new ActionRowBuilder().addComponents(
                modalTextInput('spam_response', 'If someone spammed links?', TextInputStyle.Paragraph)
            )
        );
}

function getModalBuilder(type, userId) {
    if (type === 'report') {
        return buildReportModal(userId);
    }

    if (type === 'media') {
        return buildMediaModal(userId);
    }

    if (type === 'staff') {
        return buildStaffModal(userId);
    }

    return null;
}

async function handleTicketButton(interaction) {
    if (!interaction.customId.startsWith(`${TICKET_BUTTON_PREFIX}:`) &&
        !interaction.customId.startsWith(`${TICKET_CLOSE_PREFIX}:`)) {
        return false;
    }

    if (interaction.customId.startsWith(`${TICKET_CLOSE_PREFIX}:`)) {
        await handleTicketClose(interaction);
        return true;
    }

    const [, type] = interaction.customId.split(':');
    const modal = getModalBuilder(type, interaction.user.id);

    if (!modal) {
        await interaction.reply({
            content: '❌ Unknown ticket type.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const existingTicket = await findOpenTicketChannel(interaction.guild, type, interaction.user.id);

    if (existingTicket) {
        await interaction.reply({
            content: existingTicketMessage(type, existingTicket),
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const cooldownDays = await checkTicketCooldown(interaction.user.id, type);

    if (cooldownDays !== null) {
        await interaction.reply({
            content: `⏳ You can only submit one ${ticketTypeLabel(type)} every **${TICKET_COOLDOWN_DAYS} days**. Please wait **${cooldownDays}** day${cooldownDays === 1 ? '' : 's'} before submitting another.`,
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    await interaction.showModal(modal);
    return true;
}

async function handleTicketModal(interaction) {
    if (!interaction.customId.startsWith(`${TICKET_MODAL_PREFIX}:`)) {
        return false;
    }

    const [, type, ownerId] = interaction.customId.split(':');

    if (ownerId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ This ticket form is not for you.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const key = ticketKey(type, interaction.user.id);

    if (creatingTicketKeys.has(key)) {
        await interaction.reply({
            content: `⏳ Your ${ticketTypeLabel(type)} is already being created.`,
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const existingTicket = await findOpenTicketChannel(interaction.guild, type, interaction.user.id);

    if (existingTicket) {
        await interaction.reply({
            content: existingTicketMessage(type, existingTicket),
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const cooldownDays = await checkTicketCooldown(interaction.user.id, type);

    if (cooldownDays !== null) {
        await interaction.reply({
            content: `⏳ You can only submit one ${ticketTypeLabel(type)} every **${TICKET_COOLDOWN_DAYS} days**. Please wait **${cooldownDays}** day${cooldownDays === 1 ? '' : 's'} before submitting another.`,
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    creatingTicketKeys.add(key);

    try {
        if (type === 'report') {
            await createReportTicket(interaction);
            return true;
        }

        if (type === 'media') {
            await createMediaApplication(interaction);
            await setTicketCooldown(interaction.user.id, 'media');
            return true;
        }

        if (type === 'staff') {
            await createStaffApplication(interaction);
            await setTicketCooldown(interaction.user.id, 'staff');
            return true;
        }

        await interaction.reply({
            content: '❌ Unknown ticket form.',
            flags: MessageFlags.Ephemeral
        });
    } finally {
        creatingTicketKeys.delete(key);
    }

    return true;
}

async function createTicketChannel(interaction, type, minimumStaffRankName, includeUser) {
    const category = await fetchTicketCategory(interaction.guild);
    const safeUsername = sanitizeChannelName(interaction.user.username);
    const name = `${type}-${safeUsername}`;
    const topic = ticketTopic(type, interaction.user.id);

    return interaction.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic,
        permissionOverwrites: baseTicketPermissions(
            interaction.guild,
            minimumStaffRankName,
            includeUser ? interaction.user.id : null
        ),
        reason: `Penguin Mafia ${type} ticket created by ${interaction.user.tag || interaction.user.username}`
    });
}

function ticketEmbed(title, interaction, fields) {
    return new EmbedBuilder()
        .setTitle(title)
        .setColor(0x5865F2)
        .addFields(
            {
                name: 'Submitted By',
                value: formatUser(interaction.user)
            },
            ...fields.map(field => ({
                name: field.name,
                value: truncateValue(field.value, 1000)
            }))
        )
        .setTimestamp(new Date());
}

async function createReportTicket(interaction) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral
    });

    const subject = interaction.fields.getTextInputValue('subject').trim();
    const details = interaction.fields.getTextInputValue('details').trim();
    const channel = await createTicketChannel(interaction, 'report', 'Moderator', true);
    const components = [
        new ActionRowBuilder().addComponents(closeButton('report', interaction.user.id))
    ];

    await channel.send({
        content: `<@${interaction.user.id}> Moderator+ will help you here. Either you or staff can close this ticket when it is finished.`,
        embeds: [
            ticketEmbed('Report an Issue', interaction, [
                {
                    name: 'Issue',
                    value: subject
                },
                {
                    name: 'Details',
                    value: details
                }
            ])
        ],
        components,
        allowedMentions: {
            users: [interaction.user.id],
            parse: []
        }
    });

    await interaction.editReply(`✅ Your issue ticket was created: ${channel}`);
}

async function createMediaApplication(interaction) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral
    });

    const accounts = interaction.fields.getTextInputValue('accounts').trim();
    const whyMedia = interaction.fields.getTextInputValue('why_media').trim();
    const contentPlan = interaction.fields.getTextInputValue('content_plan').trim();
    const channel = await createTicketChannel(interaction, 'media', 'Sr Moderator', false);

    await channel.send({
        embeds: [
            ticketEmbed('Media Application', interaction, [
                {
                    name: 'Media Accounts',
                    value: accounts
                },
                {
                    name: 'Why They Should Get Media',
                    value: whyMedia
                },
                {
                    name: 'Penguin Mafia Content Plan',
                    value: contentPlan
                }
            ])
        ],
        components: [
            new ActionRowBuilder().addComponents(closeButton('media', interaction.user.id))
        ],
        allowedMentions: {
            parse: []
        }
    });

    await interaction.editReply('✅ Your media application was submitted to Sr Mod+.');
}

async function createStaffApplication(interaction) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral
    });

    const ageLocation = interaction.fields.getTextInputValue('age_location').trim();
    const experience = interaction.fields.getTextInputValue('experience').trim();
    const hours = interaction.fields.getTextInputValue('hours').trim();
    const slurResponse = interaction.fields.getTextInputValue('slur_response').trim();
    const spamResponse = interaction.fields.getTextInputValue('spam_response').trim();
    const channel = await createTicketChannel(interaction, 'staff', 'Sr Moderator', false);

    await channel.send({
        embeds: [
            ticketEmbed('Staff Application', interaction, [
                {
                    name: 'Age, Location, Timezone',
                    value: ageLocation
                },
                {
                    name: 'Prior Server Experience',
                    value: experience
                },
                {
                    name: 'Hours Per Week',
                    value: hours
                },
                {
                    name: 'Racial Slur Scenario',
                    value: slurResponse
                },
                {
                    name: 'Spam Links Scenario',
                    value: spamResponse
                }
            ])
        ],
        components: [
            new ActionRowBuilder().addComponents(closeButton('staff', interaction.user.id))
        ],
        allowedMentions: {
            parse: []
        }
    });

    await interaction.editReply('✅ Your staff application was submitted to Sr Mod+.');
}

async function handleTicketClose(interaction) {
    const [, type, ownerId] = interaction.customId.split(':');
    const member = interaction.member;
    const canClose = type === 'report'
        ? interaction.user.id === ownerId || memberHasStaffRankAtOrAbove(member, 'Moderator')
        : memberHasStaffRankAtOrAbove(member, 'Sr Moderator');

    if (!canClose) {
        await interaction.reply({
            content: '❌ You do not have permission to close this ticket.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: '❌ This button can only close a ticket text channel.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (closingTicketChannels.has(channel.id)) {
        await interaction.reply({
            content: '⏳ This ticket is already closing.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    closingTicketChannels.add(channel.id);

    await interaction.reply({
        content: `🧨 Ticket closed by ${interaction.user}. This channel will self-destruct in **10 seconds**.`,
        allowedMentions: {
            users: [interaction.user.id],
            parse: []
        }
    });

    setTimeout(async () => {
        try {
            await channel.delete(`Penguin Mafia ticket closed by ${interaction.user.tag || interaction.user.username}`);
        } catch (error) {
            console.error(`Could not delete closed ticket channel ${channel.id}:`);
            console.error(error);
        } finally {
            closingTicketChannels.delete(channel.id);
        }
    }, 10_000);
}

module.exports = {
    ensureTicketPanel,
    handleTicketButton,
    handleTicketModal,
    memberHasStaffRankAtOrAbove
};
