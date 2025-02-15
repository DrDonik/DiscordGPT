import {
    Client, Discord, Slash, SlashOption,
} from 'discordx';
import { ApplicationCommandOptionType, ChannelType, CommandInteraction } from 'discord.js';
import { Category } from '@discordx/utilities';
import { handleGPTResponse, handleThreadCreation, runGPT } from '../../utils/Util.js';

@Discord()
@Category('Miscellaneous')
export class Ask {
    /**
     * Query the DiscordGPT model
     * @param query - The query for DiscordGPT
     * @param interaction - The command interaction.
     * @param client - The Discord client.
     */
    @Slash({ description: 'Query the DiscordGPT model' })
    async ask(
        @SlashOption({
            description: 'Query the DiscordGPT',
            name: 'query',
            required: true,
            type: ApplicationCommandOptionType.String,
            minLength: 4,
            maxLength: 1024,
        })
            query: string,
            interaction: CommandInteraction,
            client: Client,
    ) {
        await interaction.deferReply();

        if (process.env.ENABLE_MESSAGE_THREADS === 'true' && interaction.guild && interaction.channel?.type === ChannelType.GuildText) {
            await handleThreadCreation({
                source: interaction,
                client,
                user: interaction.user,
                query,
                commandUsageChannel: process.env.COMMAND_USAGE_CHANNEL,
            });
        } else {
            const response = await runGPT(query, interaction.user);
            await handleGPTResponse(response, interaction, client);
        }
    }
}
