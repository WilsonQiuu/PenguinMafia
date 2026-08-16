const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    LabelBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const sql = require('../db.js');
const {
    setMemberNicknameToIgn
} = require('./nicknames.js');
const {
    dismissRow
} = require('./dismissible.js');

const ACCOUNT_LINK_BUTTON_PREFIX = 'account_link_open:';
const ACCOUNT_LINK_MODAL_PREFIX = 'account_link_submit:';
const ACCOUNT_LINK_REMINDER_INTERVAL_DAYS = 7;

function accountLinkModal(userId, player) {
    const ignInput = new TextInputBuilder()
        .setCustomId('account_link_ign')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Your Minecraft username')
        .setMinLength(3)
        .setMaxLength(16)
        .setRequired(true);

    if (player.minecraft_ign) {
        ignInput.setValue(player.minecraft_ign);
    }

    const editionSelect = new StringSelectMenuBuilder()
        .setCustomId('account_link_edition')
        .setPlaceholder('Choose Java or Bedrock')
        .setRequired(true)
        .addOptions(
            {
                label: 'Java',
                value: 'java',
                default: player.minecraft_edition === 'java'
            },
            {
                label: 'Bedrock',
                value: 'bedrock',
                default: player.minecraft_edition === 'bedrock'
            }
        );

    return new ModalBuilder()
        .setCustomId(`${ACCOUNT_LINK_MODAL_PREFIX}${userId}`)
        .setTitle('Link Minecraft Account')
        .addLabelComponents(
            new LabelBuilder()
                .setLabel('Minecraft IGN')
                .setDescription('Enter the account name you use in Minecraft.')
                .setTextInputComponent(ignInput),
            new LabelBuilder()
                .setLabel('Minecraft Edition')
                .setDescription('Choose the edition you play.')
                .setStringSelectMenuComponent(editionSelect)
        );
}

function reminderPayload(player) {
    const status = !player.minecraft_ign
        ? 'Your Minecraft account is currently **Unlinked**.'
        : `Your IGN **${player.minecraft_ign}** is linked, but you still need to choose **Java** or **Bedrock**.`;
    const exampleIgn = player.minecraft_ign || 'YourMinecraftName';

    return {
        content:
            `🐧 **Penguin Mafia Account Reminder**\n\n` +
            `${status}\n\n` +
            `Press **Link Account** below to enter your IGN and choose your edition.\n\n` +
            `If the button does not work, go to the Penguin Mafia server and run:\n` +
            `\`/penguinlink ign:${exampleIgn} edition:Java\`\n` +
            `or\n` +
            `\`/penguinlink ign:${exampleIgn} edition:Bedrock\`\n\n` +
            `You will receive this reminder at most once every **7 days** until your account is fully linked.`,
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${ACCOUNT_LINK_BUTTON_PREFIX}${player.discord_id}`)
                    .setLabel('Link Account')
                    .setEmoji('🔗')
                    .setStyle(ButtonStyle.Primary)
            ),
            dismissRow(player.discord_id)
        ]
    };
}

async function remindUnlinkedPlayers(guild, db = sql) {
    const rows = await db`
        select
            discord_id,
            minecraft_ign,
            minecraft_edition
        from players
        where status = 'active'
            and welcome_completed = true
            and account_link_reminders_disabled = false
            and (
                minecraft_ign is null
                or minecraft_edition is null
            )
            and (
                account_link_reminder_sent_at is null
                or account_link_reminder_sent_at <= now() - interval '7 days'
            )
    `;
    let sent = 0;

    for (const player of rows) {
        const member = await guild.members.fetch(player.discord_id).catch(() => null);

        if (!member || member.user.bot) {
            continue;
        }

        try {
            await member.send(reminderPayload(player));
            await db`
                update players
                set
                    account_link_reminder_sent_at = now(),
                    updated_at = now()
                where discord_id = ${player.discord_id}
            `;
            sent++;
        } catch (error) {
            console.log(`Could not DM account-link reminder to ${member.user.tag}: ${error.message}`);
        }
    }

    return {
        checked: rows.length,
        sent
    };
}

async function handleAccountLinkButton(interaction, db = sql) {
    if (!interaction.customId.startsWith(ACCOUNT_LINK_BUTTON_PREFIX)) {
        return false;
    }

    const targetUserId = interaction.customId.slice(ACCOUNT_LINK_BUTTON_PREFIX.length);

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '❌ This account-link button belongs to another player.',
            ephemeral: true
        });
        return true;
    }

    const rows = await db`
        select
            minecraft_ign,
            minecraft_edition
        from players
        where discord_id = ${interaction.user.id}
            and status = 'active'
        limit 1
    `;
    const player = rows[0];

    if (!player) {
        await interaction.reply({
            content: '❌ Your Penguin Mafia player account could not be found.',
            ephemeral: true
        });
        return true;
    }

    if (player.minecraft_ign && player.minecraft_edition) {
        await interaction.reply({
            content: '✅ Your Minecraft account is already fully linked.',
            ephemeral: true
        });
        return true;
    }

    await interaction.showModal(accountLinkModal(interaction.user.id, player));
    return true;
}

async function handleAccountLinkModal(interaction, db = sql) {
    if (!interaction.customId.startsWith(ACCOUNT_LINK_MODAL_PREFIX)) {
        return false;
    }

    const targetUserId = interaction.customId.slice(ACCOUNT_LINK_MODAL_PREFIX.length);

    if (interaction.user.id !== targetUserId) {
        await interaction.reply({
            content: '❌ This account-link form belongs to another player.',
            ephemeral: true
        });
        return true;
    }

    const minecraftIgn = interaction.fields.getTextInputValue('account_link_ign').trim();
    const minecraftEdition = interaction.fields.getStringSelectValues('account_link_edition')[0];

    if (!/^[A-Za-z0-9_]{3,16}$/.test(minecraftIgn)) {
        await interaction.reply({
            content: '❌ Minecraft usernames must be 3–16 characters and can only use letters, numbers, and underscores.',
            ephemeral: true
        });
        return true;
    }

    if (!['java', 'bedrock'].includes(minecraftEdition)) {
        await interaction.reply({
            content: '❌ Choose either Java or Bedrock.',
            ephemeral: true
        });
        return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const rows = await db`
        update players
        set
            discord_username = ${interaction.user.username},
            minecraft_ign = ${minecraftIgn},
            minecraft_edition = ${minecraftEdition},
            account_link_reminders_disabled = false,
            account_link_reminder_sent_at = null,
            updated_at = now()
        where discord_id = ${interaction.user.id}
            and status = 'active'
        returning discord_id
    `;

    if (rows.length === 0) {
        await interaction.editReply('❌ Your Penguin Mafia player account could not be found.');
        return true;
    }

    const guild = interaction.client.guilds.cache.get(process.env.GUILD_ID) ||
        (await interaction.client.guilds.fetch(process.env.GUILD_ID).catch(() => null));
    const member = guild
        ? await guild.members.fetch(interaction.user.id).catch(() => null)
        : null;

    if (member) {
        await setMemberNicknameToIgn(member, minecraftIgn);
    }

    const editionLabel = minecraftEdition === 'bedrock' ? 'Bedrock' : 'Java';

    await interaction.editReply(
        `✅ **Minecraft account linked!**\n\n` +
        `IGN: **${minecraftIgn}**\n` +
        `Edition: **${editionLabel}**\n\n` +
        `You will no longer receive account-link reminders.`
    );
    return true;
}

module.exports = {
    accountLinkModal,
    handleAccountLinkButton,
    handleAccountLinkModal,
    remindUnlinkedPlayers
};
