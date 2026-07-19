const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatDonationAmount,
    parseDonationAmount
} = require('../utils/donations.js');
const {
    ICEBERG_ENTRY_FEE_CENTS
} = require('../utils/bootstrap.js');
const {
    giveawayPaymentBotUser
} = require('../utils/giveaways.js');
const {
    addManualIcebergMember,
    adjustFund,
    areClaimsEnabled,
    clearPlotOwner,
    createPendingClaimRequest,
    createPendingJoinRequest,
    getIcebergRole,
    getPlotInfo,
    isIcebergMember,
    isPlotClaimed,
    isTrustedPenguin,
    plotPriceCents,
    setClaimsEnabled,
    transferPlot,
    updateIcebergChannel,
    updateMembersListChannel
} = require('../utils/iceberg.js');
const {
    isDon
} = require('../utils/staff.js');

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
        )
        .addSubcommand(sub =>
            sub.setName('addmember')
                .setDescription('Manually add a player to the Iceberg and add the 30m entry fee. Don only.')
                .addUserOption(opt =>
                    opt.setName('user').setDescription('The Discord user to add').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('plotclear')
                .setDescription('Clear the owner and active hold from an Iceberg plot. Don only.')
                .addIntegerOption(opt =>
                    opt.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('fund')
                .setDescription('Add or remove money from the Iceberg Builder\'s Fund. Don only.')
                .addStringOption(opt =>
                    opt.setName('action')
                        .setDescription('Whether to add or remove money')
                        .setRequired(true)
                        .addChoices(
                            { name: 'add', value: 'add' },
                            { name: 'remove', value: 'remove' }
                        )
                )
                .addStringOption(opt =>
                    opt.setName('amount').setDescription('Amount like 30m, 1.5b, or 500000').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('claims')
                .setDescription('Enable or disable plot claiming. Don only.')
                .addStringOption(opt =>
                    opt.setName('state')
                        .setDescription('Enable or disable claiming')
                        .setRequired(true)
                        .addChoices(
                            { name: 'enable', value: 'enable' },
                            { name: 'disable', value: 'disable' }
                        )
                )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'join') return handleJoin(interaction);
        if (sub === 'claimplot') return handleClaimPlot(interaction);
        if (sub === 'plot') return handlePlot(interaction);
        if (sub === 'transfer') return handleTransfer(interaction);
        if (sub === 'addmember') return handleAddMember(interaction);
        if (sub === 'plotclear') return handlePlotClear(interaction);
        if (sub === 'fund') return handleFund(interaction);
        if (sub === 'claims') return handleClaims(interaction);
    },

    handleClaimPlot
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
                `⏳ You already have a pending join request.\n\n` +
                `\`/pay ${giveawayPaymentBotUser()} ${formatDonationAmount(ICEBERG_ENTRY_FEE_CENTS)}\` from **${ign}**\n\n` +
                `Your payment will be detected automatically.`
            );
            return;
        }

        await createPendingJoinRequest(interaction.guild, interaction.member, ign);

        await interaction.editReply(
            `✅ **Iceberg join initiated!**\n\n` +
            `Pay **${formatDonationAmount(ICEBERG_ENTRY_FEE_CENTS)}** to the bot:\n` +
            `\`/pay ${giveawayPaymentBotUser()} ${formatDonationAmount(ICEBERG_ENTRY_FEE_CENTS)}\` from **${ign}**\n\n` +
            `Your payment will be detected automatically and you will receive the Iceberg role.`
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg join', error);
        await interaction.editReply(`❌ **Join failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handleClaimPlot(interaction, commandLabel = '/iceberg claimplot') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        if (!await isIcebergMember(interaction.guild, interaction.member)) {
            await interaction.editReply('❌ You must be an Iceberg member to claim a plot. Use `/iceberg join` first.');
            return;
        }

        if (!await areClaimsEnabled()) {
            await interaction.editReply('❌ Plot claiming is currently disabled.');
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
                `⏳ You already have a pending claim for Plot ${plotNumber}.\n\n` +
                `\`/pay ${giveawayPaymentBotUser()} ${formatDonationAmount(price)}\` from **${ign}**`
            );
            return;
        }

        await createPendingClaimRequest(interaction.guild, interaction.member, ign, plotNumber);

        await interaction.editReply(
            `✅ **Plot ${plotNumber} claim initiated!**\n\n` +
            `Price: **${formatDonationAmount(price)}**\n` +
            `You have **5 minutes** to pay:\n` +
            `\`/pay ${giveawayPaymentBotUser()} ${formatDonationAmount(price)}\` from **${ign}**\n\n` +
            `Your payment will be detected automatically and the plot will be assigned to you.`
        );
    } catch (error) {
        logCommandError(interaction, commandLabel, error);
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
            const refreshed = await updateIcebergChannel(interaction.guild)
                .then(() => true)
                .catch(error => error);

            if (refreshed === true) {
                await interaction.editReply(`✅ Plot ${plotNumber} has been transferred to ${targetUser}.`);
                return;
            }

            await interaction.editReply(
                `✅ Plot ${plotNumber} has been transferred to ${targetUser}.\n` +
                `⚠️ The Iceberg plot list did not refresh automatically: \`${refreshed.message || refreshed}\``
            );
        } else {
            await interaction.editReply('❌ Transfer failed. You may not own this plot.');
        }
    } catch (error) {
        logCommandError(interaction, '/iceberg transfer', error);
        await interaction.editReply(`❌ **Transfer failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handleAddMember(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isDon(interaction.user.id)) {
        await interaction.editReply('❌ Only the Don can use `/iceberg addmember`.');
        return;
    }

    try {
        const targetUser = interaction.options.getUser('user');
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!targetMember) {
            await interaction.editReply('❌ That user is not in this server, so I cannot add the Iceberg role.');
            return;
        }

        if (targetMember.user.bot) {
            await interaction.editReply('❌ Bots cannot be added as Iceberg members.');
            return;
        }

        const role = await getIcebergRole(interaction.guild);

        if (!role) {
            await interaction.editReply('❌ Iceberg role could not be found. Check `ICEBERG_ROLE_ID`.');
            return;
        }

        if (!role.editable) {
            await interaction.editReply('❌ I cannot assign the Iceberg role. Move my bot role above the Iceberg role.');
            return;
        }

        if (!targetMember.roles.cache.has(role.id)) {
            await targetMember.roles.add(role, `Manually added to Iceberg by ${interaction.user.tag}`);
        }

        const result = await addManualIcebergMember(interaction.guild, targetMember, ICEBERG_ENTRY_FEE_CENTS);

        await Promise.allSettled([
            updateIcebergChannel(interaction.guild),
            updateMembersListChannel(interaction.guild)
        ]);

        if (!result.added) {
            await interaction.editReply(
                `✅ ${targetMember} already had an Iceberg membership record, so I made sure they have the role.\n` +
                `No extra Builder's Fund money was added.\n\n` +
                `Builder's Fund: **${formatDonationAmount(result.newBalance)}**`
            );
            return;
        }

        await interaction.editReply(
            `✅ Added ${targetMember} to the Iceberg.\n` +
            `Added **${formatDonationAmount(ICEBERG_ENTRY_FEE_CENTS)}** to the Builder's Fund.\n\n` +
            `Builder's Fund: **${formatDonationAmount(result.newBalance)}**`
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg addmember', error);
        await interaction.editReply(`❌ **Add member failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handlePlotClear(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isDon(interaction.user.id)) {
        await interaction.editReply('❌ Only the Don can use `/iceberg plotclear`.');
        return;
    }

    try {
        const plotNumber = interaction.options.getInteger('number');
        const result = await clearPlotOwner(plotNumber);

        await updateIcebergChannel(interaction.guild).catch(() => {});

        const previousLine = result.previousOwnerId
            ? `Previous owner: <@${result.previousOwnerId}>`
            : result.previousClaimerId
                ? `Previous hold: <@${result.previousClaimerId}>`
                : 'Plot was already available.';

        const cancelledLine = result.cancelledRequests > 0
            ? `Cancelled pending claim requests: **${result.cancelledRequests}**`
            : 'No pending claim requests needed cancelling.';

        await interaction.editReply(
            `✅ Plot ${plotNumber} is now clear and available.\n` +
            `${previousLine}\n` +
            `${cancelledLine}`
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg plotclear', error);
        await interaction.editReply(`❌ **Plot clear failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handleFund(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isDon(interaction.user.id)) {
        await interaction.editReply('❌ Only the Don can use `/iceberg fund`.');
        return;
    }

    try {
        const action = interaction.options.getString('action');
        const amountText = interaction.options.getString('amount');
        const amount = parseDonationAmount(amountText);
        const signedAmount = action === 'remove' ? -amount : amount;
        const newBalance = await adjustFund(signedAmount);

        if (newBalance === null) {
            await interaction.editReply(
                `❌ Cannot remove **${formatDonationAmount(amount)}** because the Builder's Fund does not have enough money.`
            );
            return;
        }

        await updateIcebergChannel(interaction.guild).catch(() => {});

        await interaction.editReply(
            `✅ ${action === 'remove' ? 'Removed' : 'Added'} **${formatDonationAmount(amount)}** ` +
            `${action === 'remove' ? 'from' : 'to'} the Builder's Fund.\n\n` +
            `Builder's Fund: **${formatDonationAmount(newBalance)}**`
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg fund', error);
        await interaction.editReply(`❌ **Fund update failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handleClaims(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isDon(interaction.user.id)) {
        await interaction.editReply('❌ Only the Don can use `/iceberg claims`.');
        return;
    }

    try {
        const state = interaction.options.getString('state');
        const enabled = state === 'enable';

        await setClaimsEnabled(enabled);

        await updateIcebergChannel(interaction.guild).catch(() => {});

        await interaction.editReply(
            enabled ? '✅ Plot claiming is now **enabled**.' : '✅ Plot claiming is now **disabled**.'
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg claims', error);
        await interaction.editReply(`❌ **Claims toggle failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}
