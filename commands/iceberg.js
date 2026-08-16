const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const sql = require('../db.js');
const { logCommandError } = require('../utils/logging.js');
const {
    ICEBERG_PLOT_LIMIT,
    addIcebergPlot,
    claimIcebergPlot,
    clearPlotOwner,
    deleteIcebergPlot,
    getPlotInfo,
    isIcebergMember,
    transferPlot,
    updateIcebergChannel,
    updateMembersListChannel
} = require('../utils/iceberg.js');
const { isDon } = require('../utils/staff.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('iceberg')
        .setDescription('Iceberg membership and plot commands.')
        .addSubcommand(sub =>
            sub.setName('claimplot')
                .setDescription('Claim an available Iceberg plot.')
                .addIntegerOption(option =>
                    option.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('plot')
                .setDescription('Check an Iceberg plot.')
                .addIntegerOption(option =>
                    option.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('transfer')
                .setDescription('Transfer your plot to another Iceberg Penguin.')
                .addIntegerOption(option =>
                    option.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
                .addUserOption(option =>
                    option.setName('user').setDescription('Player receiving the plot').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('plotadd')
                .setDescription('Register a new Iceberg plot. Don only.')
                .addIntegerOption(option =>
                    option.setName('number').setDescription('New plot number').setRequired(true).setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('plotclear')
                .setDescription('Clear a plot owner. Don only.')
                .addIntegerOption(option =>
                    option.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('plotdelete')
                .setDescription('Delete an Iceberg plot. Don only.')
                .addIntegerOption(option =>
                    option.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'claimplot') return handleClaimPlot(interaction);
        if (subcommand === 'plot') return handlePlot(interaction);
        if (subcommand === 'transfer') return handleTransfer(interaction);
        if (subcommand === 'plotadd') return handlePlotAdd(interaction);
        if (subcommand === 'plotclear') return handlePlotClear(interaction);
        if (subcommand === 'plotdelete') return handlePlotDelete(interaction);
    },

    handleClaimPlot
};

async function handleClaimPlot(interaction, commandLabel = '/iceberg claimplot') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        if (!await isIcebergMember(interaction.guild, interaction.member, sql)) {
            await interaction.editReply(
                '❌ Iceberg plots require at least **3 vouches** or the **Admin** staff rank.'
            );
            return;
        }

        const plotNumber = interaction.options.getInteger('number');
        const result = await claimIcebergPlot(plotNumber, interaction.user.id, sql);

        if (result.status === 'not_found') {
            await interaction.editReply(`❌ Plot ${plotNumber} is not registered.`);
            return;
        }

        if (result.status === 'owned') {
            await interaction.editReply(`❌ Plot ${plotNumber} has already been claimed.`);
            return;
        }

        if (result.status === 'limit_reached') {
            await interaction.editReply(
                `❌ You already own **${ICEBERG_PLOT_LIMIT} plots**, which is the maximum.`
            );
            return;
        }

        await updateIcebergChannel(interaction.guild, sql).catch(() => null);
        await interaction.editReply(
            `✅ Plot **${plotNumber}** is now yours. Claims are **free**, first come, first served, and you can own up to **${ICEBERG_PLOT_LIMIT} plots**.`
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
        const info = await getPlotInfo(plotNumber, sql);

        if (!info) {
            await interaction.editReply(`❌ Plot ${plotNumber} is not registered.`);
            return;
        }

        if (!info.owner_discord_id) {
            await interaction.editReply(`**Plot ${plotNumber}**\nStatus: 🟢 **Available**`);
            return;
        }

        const ownerName = info.minecraft_ign || info.discord_display_name || info.discord_username || 'Unknown';
        await interaction.editReply(`**Plot ${plotNumber}**\nStatus: ✅ **Claimed** by **${ownerName}**`);
    } catch (error) {
        logCommandError(interaction, '/iceberg plot', error);
        await interaction.editReply(`❌ **Plot lookup failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handleTransfer(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const plotNumber = interaction.options.getInteger('number');
        const targetUser = interaction.options.getUser('user');
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!targetMember || targetMember.user.bot) {
            await interaction.editReply('❌ Choose a player who is currently in the server.');
            return;
        }

        if (targetUser.id === interaction.user.id) {
            await interaction.editReply('❌ You already own this plot.');
            return;
        }

        if (!await isIcebergMember(interaction.guild, targetMember, sql)) {
            await interaction.editReply('❌ That player is not eligible for the Iceberg yet.');
            return;
        }

        const result = await transferPlot(plotNumber, interaction.user.id, targetUser.id, sql);

        if (result.status === 'limit_reached') {
            await interaction.editReply(`❌ ${targetUser} already owns **${ICEBERG_PLOT_LIMIT} plots**.`);
            return;
        }

        if (result.status !== 'transferred') {
            await interaction.editReply('❌ Transfer failed because you do not own that plot.');
            return;
        }

        await updateIcebergChannel(interaction.guild, sql).catch(() => null);
        await interaction.editReply(`✅ Plot ${plotNumber} was transferred to ${targetUser}.`);
    } catch (error) {
        logCommandError(interaction, '/iceberg transfer', error);
        await interaction.editReply(`❌ **Transfer failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function requireDon(interaction, commandName) {
    if (isDon(interaction.user.id)) return true;
    await interaction.editReply(`❌ Only the Don can use \`${commandName}\`.`);
    return false;
}

async function handlePlotAdd(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!await requireDon(interaction, '/iceberg plotadd')) return;

    try {
        const plotNumber = interaction.options.getInteger('number');
        const added = await addIcebergPlot(plotNumber, sql);

        if (!added) {
            await interaction.editReply(`ℹ️ Plot ${plotNumber} is already registered.`);
            return;
        }

        await updateIcebergChannel(interaction.guild, sql).catch(() => null);
        await interaction.editReply(`✅ Plot ${plotNumber} was added and is available to claim.`);
    } catch (error) {
        logCommandError(interaction, '/iceberg plotadd', error);
        await interaction.editReply(`❌ **Plot add failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handlePlotClear(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!await requireDon(interaction, '/iceberg plotclear')) return;

    try {
        const plotNumber = interaction.options.getInteger('number');
        const cleared = await clearPlotOwner(plotNumber, sql);

        if (!cleared) {
            await interaction.editReply(`❌ Plot ${plotNumber} is not registered.`);
            return;
        }

        await updateIcebergChannel(interaction.guild, sql).catch(() => null);
        await interaction.editReply(`✅ Plot ${plotNumber} is available again.`);
    } catch (error) {
        logCommandError(interaction, '/iceberg plotclear', error);
        await interaction.editReply(`❌ **Plot clear failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function handlePlotDelete(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!await requireDon(interaction, '/iceberg plotdelete')) return;

    try {
        const plotNumber = interaction.options.getInteger('number');
        const deleted = await deleteIcebergPlot(plotNumber, sql);

        if (!deleted) {
            await interaction.editReply(`❌ Plot ${plotNumber} is not registered.`);
            return;
        }

        await updateIcebergChannel(interaction.guild, sql).catch(() => null);
        await interaction.editReply(
            `✅ Plot ${plotNumber} was deleted.` +
            (deleted.owner_discord_id ? ` Its previous owner was <@${deleted.owner_discord_id}>.` : '')
        );
    } catch (error) {
        logCommandError(interaction, '/iceberg plotdelete', error);
        await interaction.editReply(`❌ **Plot delete failed.**\n\`\`\`\n${error.message}\n\`\`\``);
    }
}
