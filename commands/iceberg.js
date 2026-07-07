const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatDonationAmount
} = require('../utils/donations.js');
const {
    ICEBERG_ENTRY_FEE_CENTS
} = require('../utils/bootstrap.js');
const {
    createPendingJoinRequest,
    createPendingClaimRequest,
    getPlotInfo,
    isIcebergMember,
    isPlotClaimed,
    isTrustedPenguin,
    plotPriceCents,
    transferPlot,
    updateIcebergChannel,
    updateMembersListChannel
} = require('../utils/iceberg.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('iceberg')
        .setDescription('Iceberg Builder\'s Fund commands.')
        .addSubcommand(sub =>
            sub.setName('join').setDescription('Join the Iceberg Builder\'s Fund. Requires Trusted Penguin.')
        )
        .addSubcommand(sub =>
            sub.setName('claimplot')
                .setDescription('Claim a plot in the Iceberg.')
                .addIntegerOption(opt =>
                    opt.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('plot')
                .setDescription('Check plot info.')
                .addIntegerOption(opt =>
                    opt.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('transfer')
                .setDescription('Transfer your plot to another player.')
                .addIntegerOption(opt =>
                    opt.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
                .addUserOption(opt =>
                    opt.setName('user').setDescription('The player to transfer to').setRequired(true)
                )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'join') return handleJoin(interaction);
        if (sub === 'claimplot') return handleClaimPlot(interaction);
        if (sub === 'plot') return handlePlot(interaction);
        if (sub === 'transfer') return handleTransfer(interaction);
    }
};

async function handleJoin(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        if (!await isTrustedPenguin(interaction.guild, interaction.member)) {
            await interaction.editReply('❌ You need to be **Trusted Penguin** to join the Iceberg.');
            return;
        }

        if (await isIcebergMember(interaction.guild, interaction.member)) {
            await interaction.editReply('❌ You are already an Iceberg member.');
            return;
        }

        const playerRows = await sql`
            select minecraft_ign from players where discord_id = ${interaction.user.id} limit 1
        `;
        const ign = playerRows[0]?.minecraft_ign;

        if (!ign) {
            await interaction.editReply('❌ You need to link your Minecraft account first using `/penguinlink`.');
            return;
        }

        const pendingRows = await sql`
            select id from iceberg_payment_requests
            where player_discord_id = ${interaction.user.id} and purpose = 'join' and status = 'pending'
            limit 1
        `;

        if (pendingRows[0]) {
            await interaction.editReply(
                `⏳ You already have a pending join request. Pay **${formatDonationAmount(ICEBERG_ENTRY_FEE_CENTS)}** to the Minecraft bot (${process.env.MINECRAFT_BOT_USERNAME || 'PenguinMafiaBot'}) from **${ign}**.\n\n` +
                `Your payment will be detected automatically.`
            );
            return;
        }

        await createPendingJoinRequest(interaction.guild, interaction.member, ign);

        await interaction.editReply(
            `✅ **Iceberg join initiated!**\n\n` +
            `Please pay **${formatDonationAmount(ICEBERG_ENTRY_FEE_CENTS)}** to the Minecraft bot (${process.env.MINECRAFT_BOT_USERNAME || 'PenguinMafiaBot'}) from **${ign}**.\n\n` +
            `Your payment will be detected automatically and you will receive the Iceberg role.`
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg join', error);
        await interaction.editReply(`❌ **Join failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handleClaimPlot(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        if (!await isIcebergMember(interaction.guild, interaction.member)) {
            await interaction.editReply('❌ You must be an Iceberg member to claim a plot. Use `/iceberg join` first.');
            return;
        }

        const plotNumber = interaction.options.getInteger('number');
        const price = plotPriceCents(plotNumber);

        const playerRows = await sql`
            select minecraft_ign from players where discord_id = ${interaction.user.id} limit 1
        `;
        const ign = playerRows[0]?.minecraft_ign;

        if (!ign) {
            await interaction.editReply('❌ You need to link your Minecraft account first using `/penguinlink`.');
            return;
        }

        const plotStatus = await isPlotClaimed(plotNumber, interaction.guild);

        if (plotStatus?.status === 'owned') {
            await interaction.editReply(`❌ Plot ${plotNumber} is already owned.`);
            return;
        }

        if (plotStatus?.status === 'on_hold') {
            await interaction.editReply(`⏳ Plot ${plotNumber} is currently on hold. Please check back later.`);
            return;
        }

        const pendingRows = await sql`
            select id from iceberg_payment_requests
            where player_discord_id = ${interaction.user.id} and purpose = 'claim' and plot_number = ${plotNumber} and status = 'pending'
            limit 1
        `;

        if (pendingRows[0]) {
            await interaction.editReply(
                `⏳ You already have a pending claim for Plot ${plotNumber}. ` +
                `Pay **${formatDonationAmount(price)}** to the Minecraft bot from **${ign}**.`
            );
            return;
        }

        await createPendingClaimRequest(interaction.guild, interaction.member, ign, plotNumber);

        await interaction.editReply(
            `✅ **Plot ${plotNumber} claim initiated!**\n\n` +
            `Price: **${formatDonationAmount(price)}**\n` +
            `You have **5 minutes** to pay the Minecraft bot (${process.env.MINECRAFT_BOT_USERNAME || 'PenguinMafiaBot'}) from **${ign}**.\n\n` +
            `Your payment will be detected automatically and the plot will be assigned to you.`
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg claimplot', error);
        await interaction.editReply(`❌ **Claim failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handlePlot(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const plotNumber = interaction.options.getInteger('number');
        const price = plotPriceCents(plotNumber);
        const info = await getPlotInfo(plotNumber);

        let lines = [`**Plot ${plotNumber}**`];
        lines.push(`Price: **${formatDonationAmount(price)}**`);

        if (!info) {
            lines.push('Status: **Available**');
        } else if (info.owner_discord_id) {
            const ownerName = info.minecraft_ign || info.discord_display_name || info.discord_username || 'Unknown';
            lines.push(`Status: **Owned** by **${ownerName}**`);
            lines.push(`Original owner: **${ownerName}**`);
            lines.push(`Original price: **${formatDonationAmount(info.original_price)}**`);
        } else if (info.current_claimer_discord_id && info.claim_expires_at && new Date(info.claim_expires_at) > new Date()) {
            lines.push('Status: **On Hold** — currently being claimed');
        } else {
            lines.push('Status: **Available**');
        }

        await interaction.editReply(lines.join('\n'));
    } catch (error) {
        logCommandError(interaction, '/iceberg plot', error);
        await interaction.editReply(`❌ **Plot info failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handleTransfer(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const plotNumber = interaction.options.getInteger('number');
        const targetUser = interaction.options.getUser('user');

        const plotRows = await sql`
            select owner_discord_id, original_price
            from iceberg_plots
            where plot_number = ${plotNumber}
            limit 1
        `;
        const plot = plotRows[0];

        if (!plot?.owner_discord_id) {
            await interaction.editReply('❌ That plot is not owned by anyone.');
            return;
        }

        if (plot.owner_discord_id !== interaction.user.id) {
            await interaction.editReply('❌ You do not own this plot.');
            return;
        }

        const success = await transferPlot(plotNumber, interaction.user.id, targetUser.id);

        if (success) {
            await interaction.editReply(`✅ Plot ${plotNumber} has been transferred to ${targetUser}.`);
        } else {
            await interaction.editReply('❌ Transfer failed. You may not own this plot.');
        }
    } catch (error) {
        logCommandError(interaction, '/iceberg transfer', error);
        await interaction.editReply(`❌ **Transfer failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}
