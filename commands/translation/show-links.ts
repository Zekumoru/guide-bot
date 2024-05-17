import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createCommand } from '../../types/DiscordCommand';
import channelLinks from '../../cache/channelLinks';
import translateChannels from '../../cache/translateChannels';
import ChannelLink, { IChannelLink } from '../../models/ChannelLink';
import { ITranslateChannel } from '../../models/TranslateChannel';

const data = new SlashCommandBuilder()
  .setName('show-links')
  .setDescription('Shows the linking of translate channels.')
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription(
        'Shows links of the given channel. If not specified, shows all links.'
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const showLinksString = (
  chLink: IChannelLink,
  trChannel: ITranslateChannel
) => {
  const strBuilder: string[] = [];
  chLink.links.forEach((link) =>
    strBuilder.push(`\n- <#${link.id}> **(${link.sourceLang})**`)
  );

  return `Showing links of <#${chLink.id}> **(${
    trChannel.sourceLang
  })**${strBuilder.join('')}`;
};

const execute = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.guildId) {
    await interaction.reply({
      content: `This command is only available on servers.`,
    });
    return;
  }

  // show a channel's links
  const channel = interaction.options.getChannel('channel');
  if (channel) {
    const [chLink, trChannel] = await Promise.all([
      channelLinks.get(channel.id),
      translateChannels.get(channel.id),
    ]);
    if (!chLink || !trChannel) {
      interaction.reply({
        content: `Cannot show links, <#${channel.id}> is not a translate channel.`,
      });
      return;
    }

    interaction.reply({
      content: showLinksString(chLink, trChannel),
    });
    return;
  }

  // show all channels with links
  const chLinks = await ChannelLink.find({
    guildId: interaction.guildId,
  }).populate('links');
  if (!chLinks.length) {
    interaction.reply({
      content: `Cannot show links, no channels are linked yet.`,
    });
    return;
  }

  // for each chLink, iterate over to links
  const strBuilder = await Promise.all<string>(
    chLinks.map(async (chLink, i) => {
      const trChannel = await translateChannels.get(chLink.id);
      if (!trChannel) return '';

      return (
        showLinksString(chLink, trChannel) +
        (i !== chLinks.length - 1 ? '\n\n' : '')
      );
    })
  );

  interaction.reply({
    content: `**Showing all translate channels links**\n\n${strBuilder.join(
      ''
    )}`,
  });
};

export default createCommand({
  data,
  execute,
});
