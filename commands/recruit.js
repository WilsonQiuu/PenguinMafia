const {
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');

const {
    logCommandError
} = require('../utils/logging.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('recruit')
        .setDescription('Review Penguin Mafia recruiting training.'),

    async execute(interaction) {
        try {
            await interaction.reply({
                content:
                    `📣🐧 **HOW TO RECRUIT MORE PENGUINS** 🐧📣\n\n` +
                    `Your mission: find players on the DonutSMP who have the heart of a penguin. Brave players. Funny players. Players ready to join the waddling empire. 🍩❄️\n\n` +
                    `There is one sacred rule: **they must become a penguin first.** 🐧✅\n\n` +
                    `Ask them to change their Minecraft skin to any penguin skin. Fancy penguin, tiny penguin, royal penguin, business penguin, sleepy penguin, all are accepted. The Mafia is for penguins only. 🐧🎩\n\n` +
                    `Once they are officially penguin-shaped, invite them to the Discord using your invite link. Our bots will try to detect that they came from you and mark them as your recruit automatically. 🤖📨\n\n` +
                    `If the bot cannot figure out who recruited them, they may become an orphaned penguin. Tragic. Dramatic. Fixable. Tell them to use:\n\n` +
                    `\`/join recruiter:@YourDiscord\`\n\n` +
                    `Recruiting matters for rank ups, so build your tree, help your penguins grow, and make the Don proud. 👑🐧`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logCommandError(interaction, '/recruit', error);

            await interaction.reply({
                content:
                    `❌ **Recruit training failed.**\n\n` +
                    `Error:\n\`\`\`\n${error.message}\n\`\`\``,
                flags: MessageFlags.Ephemeral
            });
        }
    }
};
