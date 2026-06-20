const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const {
    isDon
} = require('../utils/staff.js');
const {
    messagePlayer,
    minecraftBotStatus,
    payPlayer,
    startMinecraftBot,
    stopMinecraftBot
} = require('../minecraft-bot.js');

function connectionLabel(status) {
    const account = status.username ? ` as **${status.username}**` : '';
    const server = status.host ? ` on **${status.host}**` : '';
    return `${account}${server}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bot')
        .setDescription('Control the Minecraft payment bot. Don only.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start the Minecraft bot.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('pay')
                .setDescription('Pay a Minecraft player and wait for confirmation.')
                .addStringOption(option =>
                    option
                        .setName('player')
                        .setDescription('Java or Bedrock Minecraft username')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('amount')
                        .setDescription('Payment amount, such as 10k or 2.5m')
                        .setRequired(true)
                )
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
                .setName('quit')
                .setDescription('Disconnect and stop the Minecraft bot.')
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the Don can control the Minecraft bot.');
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'start') {
            const before = minecraftBotStatus();

            if (before.status === 'connected') {
                await interaction.editReply(
                    `ℹ️ The Minecraft bot is already connected${connectionLabel(before)}.`
                );
                return;
            }

            if (before.status === 'connecting' || before.status === 'reconnecting') {
                await interaction.editReply(
                    `ℹ️ The Minecraft bot is already ${before.status}${connectionLabel(before)}.`
                );
                return;
            }

            const started = startMinecraftBot();
            await interaction.editReply(
                `✅ Minecraft bot is starting${connectionLabel({
                    ...started,
                    host: process.env.MINECRAFT_HOST?.trim() || null
                })}.`
            );
            return;
        }

        if (subcommand === 'quit') {
            const stopped = stopMinecraftBot();
            await interaction.editReply(
                stopped
                    ? '✅ Minecraft bot disconnected and automatic reconnecting stopped.'
                    : 'ℹ️ The Minecraft bot is already stopped.'
            );
            return;
        }

        const status = minecraftBotStatus();
        if (status.status !== 'connected') {
            await interaction.editReply(
                `❌ The Minecraft bot is **${status.status}**. Use \`/bot start\` and wait for it to connect.`
            );
            return;
        }

        const player = interaction.options.getString('player', true);

        if (subcommand === 'msg') {
            const message = interaction.options.getString('message', true);
            messagePlayer(player, message);
            await interaction.editReply(`✅ Private message sent to **${player}**.`);
            return;
        }

        const amount = interaction.options.getString('amount', true);
        const result = await payPlayer(player, amount);
        await interaction.editReply(
            `✅ Payment confirmed.\n\n**Server response:** ${result.message}`
        );
    }
};
