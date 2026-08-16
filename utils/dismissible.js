const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const {
    isDon
} = require('./staff.js');

const DISMISS_BUTTON_PREFIX = 'dismiss:';

function dismissButton(ownerId) {
    return new ButtonBuilder()
        .setCustomId(`${DISMISS_BUTTON_PREFIX}${ownerId}`)
        .setLabel('✕')
        .setStyle(ButtonStyle.Secondary);
}

function dismissRow(ownerId) {
    return new ActionRowBuilder().addComponents(dismissButton(ownerId));
}

function parseDismissCustomId(customId) {
    if (!customId || !customId.startsWith(DISMISS_BUTTON_PREFIX)) {
        return null;
    }

    return customId.slice(DISMISS_BUTTON_PREFIX.length);
}

async function handleDismissInteraction(interaction) {
    const ownerId = parseDismissCustomId(interaction.customId);

    if (!ownerId) {
        return false;
    }

    if (interaction.user.id !== ownerId && !isDon(interaction.user.id)) {
        await interaction.reply({
            content: '❌ Only the recipient or the Don can remove this message.',
            ephemeral: true
        });
        return true;
    }

    await interaction.deferUpdate();
    await interaction.message.delete().catch(() => null);
    return true;
}

module.exports = {
    DISMISS_BUTTON_PREFIX,
    dismissButton,
    dismissRow,
    handleDismissInteraction,
    parseDismissCustomId
};
