import {
  ChannelType,
  EmbedBuilder,
  Events,
  Message,
  TextChannel,
} from 'discord.js';
import { DiscordEvent } from '../types/DiscordEvent';
import tagTranscoder from '../utils/tagTranscoder';
import translator from '../translation/translator';
import translateChannels from '../cache/translateChannels';
import channelLinks from '../cache/channelLinks';
import webhookCache from '../cache/webhookCache';
import { SourceLanguageCode, TargetLanguageCode } from 'deepl-node';
import { errorDebug } from '../utils/logger';
import { ITranslateChannel } from '../models/TranslateChannel';
import MessageLink, {
  IMessageLink,
  IMessageLinkItem,
} from '../models/MessageLink';

const translate = async (
  content: string,
  sourceLang: SourceLanguageCode,
  targetLang: TargetLanguageCode
) => {
  if (content.trim() === '') return;

  const [messageToTranslate, tagTable] = tagTranscoder.encode(content);

  const translatedContentToDecode = (
    await translator.translateText(messageToTranslate, sourceLang, targetLang)
  ).text;

  const translatedContent = tagTranscoder.decode(
    translatedContentToDecode,
    tagTable
  );

  return translatedContent;
};

const buildReplyEmbed = async (message: Message, replyChannel: TextChannel) => {
  if (!message.reference) return;

  const channel = message.client.channels.cache.get(message.channelId);
  if (!channel) return;
  if (channel.type !== ChannelType.GuildText) return;

  const replyOriginalMessage = await message.fetchReference();
  if (!replyOriginalMessage) return;

  // get the reply message's links
  const messageLink = await MessageLink.findOne<IMessageLink>({
    links: {
      $elemMatch: {
        messageId: replyOriginalMessage.id,
        channelId: message.channelId,
      },
    },
  });
  if (!messageLink) return;

  // get the actual link to the reply message's language
  // meaning use this link for replying
  const link = messageLink.links.find(
    ({ channelId }) => channelId === replyChannel.id
  );
  if (!link) return;

  const replyMessage = await replyChannel.messages.fetch(link.messageId);

  // build content for the reply embed
  let replyContentRaw = replyMessage.content;
  if (replyContentRaw.length > 77)
    replyContentRaw = `${replyContentRaw.slice(0, 77)}...`;
  let replyContent = `**[Replying to:](${replyMessage.url})** ${replyContentRaw}`;

  if (replyContentRaw === '') {
    // check if replying to an attachment
    if (replyMessage.attachments.size) {
      replyContent = `**[Replying to an attachment](${replyMessage.url})** ${replyContentRaw}`;
    } else if (replyMessage.stickers.size) {
      replyContent = `**[Replying to a sticker](${replyMessage.url})**`;
    } else {
      // maybe will change in the future?
      // idk what other attachments there are other than embeds
      replyContent = `**[Replying to an attachment](${replyMessage.url})** ${replyContentRaw}`;
    }
  }

  return {
    embed: new EmbedBuilder()
      .setColor(0x0099ff)
      .setAuthor({
        name: replyMessage.member?.nickname ?? replyMessage.author.displayName,
        iconURL:
          replyMessage.member?.avatarURL({ size: 32 }) ??
          replyMessage.author.displayAvatarURL({ size: 32 }),
      })
      .setDescription(replyContent),
    message: replyMessage,
  };
};

const addReplyPing = (
  content?: string,
  authorId?: string
): string | undefined => {
  // if there's no author id (meaning it's a bot) then don't ping
  if (!authorId) return content;

  // if content is empty
  if (!content) return `<@${authorId}>`;

  // do not add reply ping if there's already a ping on the user
  // INFO: pinging a user will ping the user on all channels, this is intended
  // therefore it's up to people using the bot to tell people not to ping unnecessarily
  if (content.includes(`<@${authorId}>`)) return content;

  return `${content} <@${authorId}>`;
};

const translateChannel = async (
  message: Message,
  channelId: string,
  sourceTrChannel: ITranslateChannel
) => {
  const channel = message.client.channels.cache.get(channelId);
  if (!channel) return;
  if (channel.type !== ChannelType.GuildText) return;

  const webhook = await webhookCache.get(channel);

  const targetTrChannel = await translateChannels.get(channel.id);
  if (!targetTrChannel) return;

  const username = message.member?.displayName ?? message.author.displayName;
  const avatarURL =
    message.member?.avatarURL() ?? message.author.avatarURL() ?? undefined;

  try {
    // get reply embed
    const reply = await buildReplyEmbed(message, channel);
    const replyAuthorId = !reply?.message.author.bot
      ? reply?.message.author.id
      : undefined;

    // handle sticker-only message
    const sticker = message.stickers.map((sticker) => sticker)[0];
    if (sticker) {
      return await webhook.send({
        username,
        avatarURL,
        content: addReplyPing(
          `https://media.discordapp.net/stickers/${sticker.id}.webp`,
          replyAuthorId
        ),
        embeds: reply ? [reply.embed] : undefined,
      });
    }

    const translatedContent = await translate(
      message.content,
      sourceTrChannel.sourceLang,
      targetTrChannel.targetLang
    );

    const attachments = message.attachments.map((attachment) => attachment);

    return await webhook.send({
      username,
      avatarURL,
      content: addReplyPing(translatedContent, replyAuthorId),
      files: attachments,
      embeds: reply ? [reply.embed] : undefined,
    });
  } catch (error) {
    errorDebug(error);
  }
};

export default {
  name: Events.MessageCreate,
  execute: async (message: Message) => {
    // ignore this bot's webhooks messages
    if (message.author.id !== message.client.user.id && message.webhookId) {
      const webhook = await message.fetchWebhook();
      if (webhook.owner?.id === message.client.user.id) return;
    }

    const sourceTrChannel = await translateChannels.get(message.channelId);
    const link = await channelLinks.get(message.channelId);
    if (!sourceTrChannel || !link) return;

    const messages = await Promise.all(
      link.links.map(async ({ id: channelId }) =>
        translateChannel(message, channelId, sourceTrChannel)
      )
    );

    const messagesIds = messages.filter(Boolean).map<IMessageLinkItem>((m) => ({
      messageId: m!.id,
      channelId: m!.channelId,
    }));
    messagesIds.push({
      messageId: message.id,
      channelId: message.channelId,
    });

    // save messages to db
    const messageLink = new MessageLink({
      authorId: message.author.id,
      messageId: message.id,
      channelId: message.channelId,
      links: messagesIds,
    });
    await messageLink.save();
  },
} as DiscordEvent;
