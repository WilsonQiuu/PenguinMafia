const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    isDon
} = require('../utils/staff.js');
const {
    formatDonationAmount
} = require('../utils/donations.js');
const {
    formattedMinecraftIgn,
    linkedAccountLabel
} = require('../utils/payouts.js');
const {
    checkBalance,
    cobbleModeStatus,
    emitMinecraftEvent,
    freezeMinecraftBotConnections,
    goHomeNumber,
    messagePlayer,
    minecraftBotStatus,
    payPlayer,
    resetMinecraftBotControls,
    startCobbleMode,
    startMinecraftBot,
    stopCobbleMode,
    stopMinecraftBot
} = require('../minecraft-bot.js');

function connectionLabel(status) {
    const account = status.username ? ` as **${status.username}**` : '';
    const server = status.host ? ` on **${status.host}**` : '';
    return `${account}${server}`;
}

function discordMentionId(input) {
    const match = /^<@!?(\d+)>$/.exec(input);
    return match?.[1] || null;
}

async function linkedPaymentTarget(discordId, displayName, db = sql) {
    const rows = await db`
        select
            discord_id,
            discord_username,
            discord_display_name,
            minecraft_ign,
            minecraft_edition
        from players
        where discord_id = ${discordId}
        limit 1
    `;
    const player = rows[0];

    if (!player) {
        throw new Error(`${displayName} is not in the player database yet.`);
    }

    const minecraftName = formattedMinecraftIgn(player);

    if (!minecraftName) {
        throw new Error(`${displayName} does not have a linked Minecraft IGN yet.`);
    }

    return {
        minecraftName,
        label: `${displayName} (${linkedAccountLabel(player)})`
    };
}

async function resolvePaymentTarget(interaction, db = sql) {
    const user = interaction.options.getUser('user');
    const playerInput = interaction.options.getString('player')?.trim() || '';
    const mentionedDiscordId = playerInput ? discordMentionId(playerInput) : null;

    if (user && playerInput) {
        throw new Error('Use either `user` or `player` for `/bot pay`, not both.');
    }

    if (user) {
        return linkedPaymentTarget(user.id, `${user}`, db);
    }

    if (mentionedDiscordId) {
        return linkedPaymentTarget(mentionedDiscordId, `<@${mentionedDiscordId}>`, db);
    }

    if (playerInput) {
        return {
            minecraftName: playerInput,
            label: `**${playerInput}**`
        };
    }

    throw new Error('Choose a linked Discord user or enter a Minecraft username.');
}

function paymentFailureReply(error, target = null) {
    const reason = error?.message || String(error);
    const targetLine = target?.minecraftName
        ? `Minecraft command target: **${target.minecraftName}**\n`
        : '';

    return (
        `❌ Payment failed.\n\n` +
        targetLine +
        `Server response: **${reason}**\n\n` +
        'Double check the Minecraft account name. If the linked account is wrong, use `/penguinlink` to update it.'
    );
}

function cobbleStatusLine(status) {
    if (!status.active) {
        return 'Cobble mode is not running.';
    }

    return (
        `Cobble mode is running.\n` +
        `Digs completed: **${status.digsCompleted || 0}**\n` +
        `Left click/destroy held: **${status.destroyHeld ? 'yes' : 'no'}**\n` +
        `Right click/use active: **${status.useHeld ? 'yes' : 'no'}**\n` +
        `Right click/use: **${status.useHoldSeconds || 8}s every ${status.useIntervalSeconds || 120}s**\n` +
        `Last target: **${status.lastTarget || 'None yet'}**` +
        `${status.lastError ? `\nLast error: **${status.lastError}**` : ''}`
    );
}

function vectorLine(label, vector) {
    if (!vector) {
        return `${label}: **unknown**`;
    }

    return `${label}: **${vector.x.toFixed(3)}, ${vector.y.toFixed(3)}, ${vector.z.toFixed(3)}**`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bot')
        .setDescription('Control the Minecraft payment bot. Owner only.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start the Minecraft bot.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('pay')
                .setDescription('Pay a linked Discord user or Minecraft username.')
                .addStringOption(option =>
                    option
                        .setName('amount')
                        .setDescription('Payment amount, such as 10k or 2.5m')
                        .setRequired(true)
                )
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('Linked Discord user to pay')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('player')
                        .setDescription('Minecraft username if not paying a linked Discord user')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('bal')
                .setDescription('Check the Minecraft bot balance.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('msg')
                .setDescription('Send a private Minecraft message.')
                .addStringOption(option =>
                    option
                        .setName('player')
                        .setDescription('Java or Bedrock Minecraft username')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('message')
                        .setDescription('Message to send')
                        .setRequired(true)
                        .setMaxLength(200)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('home')
                .setDescription('Send the Minecraft bot to home 1.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('home2')
                .setDescription('Send the Minecraft bot to home 2.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('cobble')
                .setDescription('Hold shift/left click, and pulse right click every 2 minutes.')
                .addStringOption(option =>
                    option
                        .setName('action')
                        .setDescription('Start, stop, or check cobble mode.')
                        .setRequired(false)
                        .addChoices(
                            {
                                name: 'start',
                                value: 'start'
                            },
                            {
                                name: 'stop',
                                value: 'stop'
                            },
                            {
                                name: 'status',
                                value: 'status'
                            }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('unstuck')
                .setDescription('Release all Minecraft bot controls and report position/velocity.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('freeze')
                .setDescription('Disconnect and pause future Minecraft bot connection attempts.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('quit')
                .setDescription('Disconnect and stop the Minecraft bot.')
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            emitMinecraftEvent(
                'Unauthorized Minecraft Bot Command',
                'A Discord user attempted to control the Minecraft bot without owner access.',
                'warning',
                {
                    Action: `/bot ${interaction.options.getSubcommand()}`,
                    'Discord user': interaction.user.tag || interaction.user.username,
                    'Discord ID': interaction.user.id
                }
            );
            await interaction.editReply('❌ Only the owner can control the Minecraft bot.');
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const actionContext = {
            actorId: interaction.user.id,
            actorTag: interaction.user.tag || interaction.user.username,
            source: 'Discord'
        };
        let paymentTarget = null;

        try {
            if (subcommand === 'start') {
                const before = minecraftBotStatus();

                if (before.status === 'connected') {
                    await interaction.editReply(
                        `ℹ️ The Minecraft bot is already connected${connectionLabel(before)}.`
                    );
                    return;
                }

                if (before.status === 'connecting') {
                    await interaction.editReply(
                        `ℹ️ The Minecraft bot is already connecting${connectionLabel(before)}.`
                    );
                    return;
                }

                const started = startMinecraftBot({
                    ...actionContext,
                    clearFreeze: true
                });
                await interaction.editReply(
                    before.status === 'frozen'
                        ? `✅ Minecraft bot connections resumed. Minecraft bot is starting${connectionLabel({
                            ...started,
                            host: process.env.MINECRAFT_HOST?.trim() || null
                        })}.`
                        : before.status === 'reconnecting'
                        ? `✅ The automatic reconnect wait was skipped. Minecraft bot is reconnecting now${connectionLabel({
                            ...started,
                            host: process.env.MINECRAFT_HOST?.trim() || null
                        })}.`
                        : `✅ Minecraft bot is starting${connectionLabel({
                            ...started,
                            host: process.env.MINECRAFT_HOST?.trim() || null
                        })}.`
                );
                return;
            }

            if (subcommand === 'freeze') {
                const result = freezeMinecraftBotConnections(actionContext);
                await interaction.editReply(
                    result.wasRunning
                        ? '✅ Minecraft bot disconnected and future connection attempts are frozen until `/bot start`.'
                        : '✅ Minecraft bot connection attempts are frozen until `/bot start`.'
                );
                return;
            }

            if (subcommand === 'quit') {
                const stopped = stopMinecraftBot(actionContext);
                await interaction.editReply(
                    stopped
                        ? '✅ Minecraft bot disconnected and automatic reconnecting stopped.'
                        : 'ℹ️ The Minecraft bot is already stopped.'
                );
                return;
            }

            if (subcommand === 'cobble') {
                const action = interaction.options.getString('action') || 'start';

                if (action === 'status') {
                    await interaction.editReply(`ℹ️ ${cobbleStatusLine(cobbleModeStatus())}`);
                    return;
                }

                if (action === 'stop') {
                    const result = stopCobbleMode(
                        actionContext,
                        'Cobble mode was stopped from Discord.'
                    );
                    await interaction.editReply(
                        result.stopped
                            ? '✅ Cobble mode stopped. Shift, left click/destroy, and right click/use were released.'
                            : 'ℹ️ Cobble mode was not running.'
                    );
                    return;
                }

                const result = startCobbleMode(actionContext);
                await interaction.editReply(
                    result.started
                        ? '✅ Cobble mode started. The bot will wiggle left/right/forward/back, keep its current view direction, hold shift/sneak, hold left click/destroy on the block in its crosshair, and hold right click/use for 8 seconds every 2 minutes. Use `/bot cobble action:stop` to stop it.'
                        : `ℹ️ ${cobbleStatusLine(result.status)}`
                );
                return;
            }

            if (subcommand === 'unstuck') {
                const result = resetMinecraftBotControls(actionContext);
                await interaction.editReply(
                    `✅ Minecraft bot controls reset.\n` +
                    `Stopped cobble mode: **${result.stoppedCobble ? 'yes' : 'no'}**\n` +
                    `Physics enabled: **${result.physicsEnabled ? 'yes' : 'no'}**\n` +
                    `${vectorLine('Position', result.position)}\n` +
                    `${vectorLine('Velocity', result.velocity)}` +
                    `${result.errors.length > 0 ? `\nWarnings:\n\`\`\`\n${result.errors.join('\n')}\n\`\`\`` : ''}`
                );
                return;
            }

            const status = minecraftBotStatus();
            if (status.status !== 'connected') {
                throw new Error(
                    `The Minecraft bot is ${status.status}. Use /bot start and wait for it to connect.`
                );
            }

            if (subcommand === 'home' || subcommand === 'home2') {
                const homeNumber = subcommand === 'home2' ? 2 : 1;
                await goHomeNumber(homeNumber, actionContext);
                await interaction.editReply(`✅ Sent \`/home ${homeNumber}\` to the Minecraft bot.`);
                return;
            }

            if (subcommand === 'bal') {
                const result = await checkBalance(actionContext);
                await interaction.editReply(
                    `✅ Bot balance: **${formatDonationAmount(result.amount)}**`
                );
                return;
            }

            if (subcommand === 'msg') {
                const player = interaction.options.getString('player', true);
                const message = interaction.options.getString('message', true);
                await messagePlayer(player, message, actionContext);
                await interaction.editReply(`✅ Private message sent to **${player}**.`);
                return;
            }

            const amount = interaction.options.getString('amount', true);
            paymentTarget = await resolvePaymentTarget(interaction);
            const result = await payPlayer(paymentTarget.minecraftName, amount, actionContext);
            await interaction.editReply(
                `✅ Payment confirmed for ${paymentTarget.label}.\n\n` +
                `Minecraft command target: **${paymentTarget.minecraftName}**\n` +
                `**Server response:** ${result.message}`
            );
        } catch (error) {
            emitMinecraftEvent(
                'Discord Bot Action Unsuccessful',
                error.message,
                'error',
                {
                    Action: `/bot ${subcommand}`,
                    'Discord user': actionContext.actorTag,
                    'Discord ID': actionContext.actorId
                }
            );

            if (subcommand === 'pay') {
                await interaction.editReply(paymentFailureReply(error, paymentTarget));
                return;
            }

            throw error;
        }
    }
};
