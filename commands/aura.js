const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    formatCents,
    parseDonationAmount
} = require('../utils/donations.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    creditUnpaidCommission,
    ensureMinecraftBotConnected,
    formatMinecraftPaymentAmountFromCents,
    payPlayerAfterBusyWait,
    payoutMinecraftTarget,
    paymentSpacingMs
} = require('../utils/commissionPayments.js');
const {
    playerName
} = require('../utils/payouts.js');
const {
    isDon
} = require('../utils/staff.js');

const AURA_REWARD_AMOUNT_CENTS = parseDonationAmount('1m') * 100n;

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function previewList(lines, limit = 8) {
    if (lines.length === 0) {
        return 'None';
    }

    const kept = lines.slice(0, limit);
    const remaining = lines.length - kept.length;

    return remaining > 0
        ? `${kept.join('\n')}\n- ...and ${remaining} more`
        : kept.join('\n');
}

async function dmAuraCommissionCredit(guild, player, newBalanceCents) {
    const user = guild.client.users.cache.get(player.discord_id) ||
        await guild.client.users.fetch(player.discord_id).catch(() => null);

    if (!user) {
        return false;
    }

    await user.send({
        content:
            `🐧 **Aura reward credited**\n\n` +
            `The Don used \`/aura\` while you were in the call, but your Minecraft account is not fully linked.\n\n` +
            `Reward added to unpaid commissions: **${formatCents(AURA_REWARD_AMOUNT_CENTS)}**\n` +
            `New unpaid commission balance: **${formatCents(newBalanceCents)}**\n\n` +
            `To get future Aura rewards paid directly in Minecraft, use \`/penguinlink\` in the server and set your IGN + Java/Bedrock edition.`,
        allowedMentions: {
            parse: []
        }
    });

    return true;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('aura')
        .setDescription('Pay everyone currently in your voice call 1m. Don only.'),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can use `/aura`.');
            return;
        }

        try {
            const donMember = interaction.member ||
                await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            const voiceChannel = donMember?.voice?.channel;

            if (!voiceChannel) {
                await interaction.editReply('❌ You are not currently in a voice call.');
                return;
            }

            const voiceMembers = [...voiceChannel.members.values()]
                .filter(member => !member.user.bot);

            if (voiceMembers.length === 0) {
                await interaction.editReply('❌ No non-bot members were found in your voice call.');
                return;
            }

            const memberIds = voiceMembers.map(member => member.user.id);
            const playerRows = await sql`
                select
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    minecraft_edition,
                    unpaid_commissions
                from players
                where discord_id in ${sql(memberIds)}
            `;
            const playersById = new Map(playerRows.map(player => [player.discord_id, player]));
            const paid = [];
            const credited = [];
            const failed = [];
            const missingPlayers = [];
            const actionContext = {
                actorId: interaction.user.id,
                actorTag: interaction.user.tag || interaction.user.username,
                source: 'Discord /aura',
                guild: interaction.guild
            };
            let minecraftReady = false;
            let lastPaymentAt = 0;

            for (const member of voiceMembers) {
                const player = playersById.get(member.user.id);

                if (!player) {
                    missingPlayers.push(`- ${member}: not in database`);
                    continue;
                }

                const minecraftName = payoutMinecraftTarget(player);

                if (!minecraftName) {
                    const credit = await creditUnpaidCommission(
                        player,
                        AURA_REWARD_AMOUNT_CENTS,
                        'Aura reward: missing linked Minecraft account or edition.',
                        sql,
                        {
                            Source: '/aura',
                            suppressCommissionLog: true
                        }
                    );

                    let dmSent = false;

                    if (credit.status === 'credited') {
                        dmSent = await dmAuraCommissionCredit(
                            interaction.guild,
                            player,
                            credit.newBalanceCents
                        ).catch(error => {
                            console.log(`Could not DM Aura commission credit to ${player.discord_id}: ${error.message}`);
                            return false;
                        });
                    }

                    credited.push(
                        `- <@${player.discord_id}>: **${formatCents(AURA_REWARD_AMOUNT_CENTS)}** added to commissions` +
                        (dmSent ? ' (DM sent)' : ' (DM failed)')
                    );
                    continue;
                }

                try {
                    if (!minecraftReady) {
                        await ensureMinecraftBotConnected(actionContext);
                        minecraftReady = true;
                    }

                    if (lastPaymentAt) {
                        const waitMs = paymentSpacingMs() - (Date.now() - lastPaymentAt);

                        if (waitMs > 0) {
                            await sleep(waitMs);
                        }
                    }

                    lastPaymentAt = Date.now();
                    const payment = await payPlayerAfterBusyWait(
                        minecraftName,
                        formatMinecraftPaymentAmountFromCents(AURA_REWARD_AMOUNT_CENTS),
                        {
                            ...actionContext,
                            suppressPaymentLog: false,
                            source: `Discord /aura payment to ${minecraftName}`
                        }
                    );

                    paid.push(
                        `- <@${player.discord_id}> -> \`${minecraftName}\`: **${formatCents(AURA_REWARD_AMOUNT_CENTS)}**` +
                        (payment?.message ? ` (${payment.message})` : '')
                    );
                } catch (error) {
                    failed.push(
                        `- <@${player.discord_id}> -> \`${minecraftName}\`: ${error.message}`
                    );
                }
            }

            let message =
                `🐧✨ **Aura complete**\n\n` +
                `Voice call: **${voiceChannel.name}**\n` +
                `Reward per player: **${formatCents(AURA_REWARD_AMOUNT_CENTS)}**\n` +
                `Members checked: **${voiceMembers.length}**\n\n` +
                `**Paid directly**\n${previewList(paid)}\n\n` +
                `**Added to unpaid commissions + DMed**\n${previewList(credited)}\n\n` +
                `**Not in database**\n${previewList(missingPlayers)}\n\n` +
                `**Failed direct payments**\n${previewList(failed)}`;

            if (message.length > 1900) {
                message = `${message.slice(0, 1850)}\n\nOutput trimmed. Check bot logs for payment details.`;
            }

            await interaction.editReply(message);
        } catch (error) {
            logCommandError(interaction, '/aura', error);

            await interaction.editReply(
                `❌ **Aura command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
