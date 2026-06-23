const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    setMemberNicknameToIgn
} = require('../utils/nicknames.js');

const DEFAULT_RANK_NAME = 'Penguin Soldier';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your Minecraft IGN to your Penguin Mafia account.')
        .addStringOption(option =>
            option
                .setName('ign')
                .setDescription('Your Minecraft username / IGN')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('edition')
                .setDescription('Which Minecraft edition do you play on?')
                .setRequired(true)
                .addChoices(
                    {
                        name: 'Java',
                        value: 'java'
                    },
                    {
                        name: 'Bedrock',
                        value: 'bedrock'
                    }
                )
        ),

    async execute(interaction) {
        const minecraftIGN = interaction.options.getString('ign');
        const minecraftEdition = interaction.options.getString('edition');
        const editionLabel = minecraftEdition === 'bedrock' ? 'Bedrock' : 'Java';

        const validIGN = /^[A-Za-z0-9_]{3,16}$/.test(minecraftIGN);

        if (!validIGN) {
            await interaction.reply({
                content:
                    `❌ Invalid Minecraft IGN.\n\n` +
                    `Minecraft usernames must be **3–16 characters** and can only use letters, numbers, and underscores.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const confirmButton = new ButtonBuilder()
            .setCustomId(`link_confirm:${interaction.user.id}:${minecraftIGN}:${minecraftEdition}`)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success);

        const cancelButton = new ButtonBuilder()
            .setCustomId(`link_cancel:${interaction.user.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        await interaction.reply({
            content:
                `🐧 **Minecraft IGN Confirmation**\n\n` +
                `Discord: ${interaction.user}\n` +
                `Minecraft IGN: **${minecraftIGN}**\n` +
                `Edition: **${editionLabel}**\n\n` +
                `Is this correct?`,
            components: [row],
            flags: MessageFlags.Ephemeral
        });

        const filter = buttonInteraction => {
            return (
                buttonInteraction.user.id === interaction.user.id &&
                (
                    buttonInteraction.customId === `link_confirm:${interaction.user.id}:${minecraftIGN}:${minecraftEdition}` ||
                    buttonInteraction.customId === `link_cancel:${interaction.user.id}`
                )
            );
        };

        try {
            const buttonInteraction = await interaction.channel.awaitMessageComponent({
                filter,
                time: 60_000
            });

            if (buttonInteraction.customId === `link_cancel:${interaction.user.id}`) {
                await buttonInteraction.update({
                    content: `❌ Minecraft IGN linking cancelled. You can run \`/link\` again.`,
                    components: []
                });
                return;
            }

            const displayName =
                interaction.member?.displayName ||
                interaction.user.globalName ||
                interaction.user.username;

            await sql`
                insert into players (
                    discord_id,
                    discord_username,
                    discord_display_name,
                    minecraft_ign,
                    minecraft_edition,
                    parent_discord_id,
                    claims_available,
                    rank_name,
                    status
                )
                values (
                    ${interaction.user.id},
                    ${interaction.user.username},
                    ${displayName},
                    ${minecraftIGN},
                    ${minecraftEdition},
                    null,
                    0,
                    ${DEFAULT_RANK_NAME},
                    'active'
                )
                on conflict (discord_id) do update
                set
                    discord_username = excluded.discord_username,
                    discord_display_name = excluded.discord_display_name,
                    minecraft_ign = excluded.minecraft_ign,
                    minecraft_edition = excluded.minecraft_edition,
                    account_link_reminders_disabled = false,
                    account_link_reminder_sent_at = null,
                    updated_at = now()
            `;

            const nicknameUpdated = await setMemberNicknameToIgn(
                buttonInteraction.member,
                minecraftIGN
            );
            console.log(`/link IGN for ${buttonInteraction.member.user.tag}: ${minecraftIGN} (${editionLabel}). Nickname updated=${nicknameUpdated ? 'yes' : 'no'}.`);

            await buttonInteraction.update({
                content:
                    `✅ **Minecraft IGN linked successfully!**\n\n` +
                    `Discord: ${interaction.user}\n` +
                    `Minecraft IGN: **${minecraftIGN}**\n` +
                    `Edition: **${editionLabel}**\n\n` +
                    `You can run \`/link\` again if this was wrong.`,
                components: []
            });
        } catch (error) {
            logCommandError(interaction, '/link', error);

            await interaction.editReply({
                content:
                    `⏰ Minecraft IGN confirmation expired.\n\n` +
                    `Please run \`/link\` again with your IGN and edition.`,
                components: []
            });
        }
    }
};
